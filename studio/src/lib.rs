//! Studio cam receiver: pulls one cam (H.264) from the bridge / SFU over WebRTC, holds the *encoded*
//! frames for `delay` seconds and pipes them, as Annex-B, into a child ffmpeg that remuxes to MPEG-TS.
//!
//!   pull (WebRTC) -> Ingest (RTP -> access units) -> DelayBuffer -> output thread -> ffmpeg -> udp://
//!
//! The pure parts (Ingest, DelayBuffer) have no I/O and are unit tested below.

use bytes::Bytes;
use rtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use rtc::rtp::codec::h264::H264Packet;
use rtc::rtp::packetizer::Depacketizer;
use std::collections::VecDeque;
use std::io::{BufRead, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use webrtc::media_stream::track_remote::{TrackRemote, TrackRemoteEvent};
use webrtc::peer_connection::{
    MediaEngine, PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCConfigurationBuilder,
    RTCIceGatheringState, RTCSessionDescription, Registry, register_default_interceptors,
};

pub const MAX_DELAY: f64 = 1020.0;
type Res<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

// ───────────────────────────── delay buffer ─────────────────────────────

/// One H.264 access unit (Annex-B). `t` = arrival time in seconds on the receiver's clock.
#[derive(Clone, Debug)]
pub struct Frame {
    pub t: f64,
    pub data: Bytes,
    pub key: bool,
}

/// Holds not-yet-released frames; each is released at `t + delay`.
pub struct DelayBuffer {
    q: VecDeque<Frame>,
    delay: f64,
    need_key_in: bool,  // after a loss / reconnect: drop incoming frames until a keyframe
    need_key_out: bool, // at start / after a jump: drop due frames until a keyframe
}

impl DelayBuffer {
    pub fn new(delay: f64) -> Self {
        Self { q: VecDeque::new(), delay: delay.clamp(0.0, MAX_DELAY), need_key_in: true, need_key_out: true }
    }
    pub fn delay(&self) -> f64 {
        self.delay
    }
    /// Seconds of video held (oldest to newest frame).
    pub fn buffered(&self) -> f64 {
        match (self.q.front(), self.q.back()) {
            (Some(a), Some(b)) => b.t - a.t,
            _ => 0.0,
        }
    }
    pub fn push(&mut self, f: Frame) {
        if self.need_key_in {
            if !f.key {
                return;
            }
            self.need_key_in = false;
        }
        let newest = f.t;
        self.q.push_back(f);
        while self.q.front().is_some_and(|a| a.t < newest - MAX_DELAY) {
            self.q.pop_front();
            self.need_key_out = true;
        }
    }
    /// Packets were lost: everything after the gap is useless until the next keyframe.
    pub fn loss(&mut self) {
        self.need_key_in = true;
    }
    /// The output was restarted (new ffmpeg): it must start on a keyframe again.
    pub fn restart_output(&mut self) {
        self.need_key_out = true;
    }
    /// Shrink: drop what would now be overdue and resume at the next keyframe (no burst).
    /// Grow: nothing to do, output simply pauses until frames are old enough.
    pub fn set_delay(&mut self, now: f64, d: f64) {
        let d = d.clamp(0.0, MAX_DELAY);
        if d < self.delay {
            while self.q.front().is_some_and(|f| f.t + d <= now) {
                self.q.pop_front();
            }
            self.need_key_out = true;
        }
        self.delay = d;
    }
    /// The next frame due at `now`, if any.
    pub fn pop(&mut self, now: f64) -> Option<Frame> {
        while self.q.front()?.t + self.delay <= now {
            let f = self.q.pop_front()?;
            if self.need_key_out && !f.key {
                continue;
            }
            self.need_key_out = false;
            return Some(f);
        }
        None
    }
}

// ───────────────────────────── RTP -> access units ─────────────────────────────

/// RTP H.264 depacketizer + access-unit assembly + SPS/PPS cache + arrival clock.
#[derive(Default)]
pub struct Ingest {
    depack: H264Packet,
    au: Vec<u8>,
    ts: Option<u32>,
    bad: bool,
    last_seq: Option<u16>,
    sps: Vec<u8>,
    pps: Vec<u8>,
    clock: Option<(f64, u32)>,
}

const START: [u8; 4] = [0, 0, 0, 1];

/// The NAL units of an Annex-B buffer (each with its 4-byte start code). The depacketizer always
/// writes 4-byte start codes, and emulation prevention guarantees 00 00 00 never occurs inside a NAL.
fn nals(b: &[u8]) -> Vec<&[u8]> {
    let starts: Vec<usize> = (0..(b.len() + 1).saturating_sub(4)).filter(|&i| b[i..i + 4] == START).collect();
    starts.iter().enumerate().map(|(k, &s)| &b[s..*starts.get(k + 1).unwrap_or(&b.len())]).collect()
}

impl Ingest {
    /// Feed one RTP packet. Returns (packets lost before this one, a completed access unit).
    pub fn rtp(&mut self, seq: u16, ts: u32, marker: bool, payload: &Bytes, now: f64) -> (u16, Option<Frame>) {
        let mut lost = 0;
        if let Some(last) = self.last_seq {
            let d = seq.wrapping_sub(last) as i16;
            if d <= 0 {
                return (0, None); // duplicate or late (retransmitted) packet: the gap was already handled
            }
            lost = (d - 1) as u16;
        }
        self.last_seq = Some(seq);
        if self.ts != Some(ts) {
            // a new frame started; an unfinished previous one lost its last packet
            self.au.clear();
            self.bad = false;
            self.ts = Some(ts);
        }
        if lost > 0 {
            self.bad = true;
            self.depack = H264Packet::default(); // drop a half-assembled FU-A
        }
        match self.depack.depacketize(payload) {
            Ok(b) => self.au.extend_from_slice(&b),
            Err(_) => self.bad = true,
        }
        if !marker {
            return (lost, None);
        }
        self.ts = None;
        let au = std::mem::take(&mut self.au);
        if self.bad || au.is_empty() {
            return (lost, None);
        }
        (lost, Some(self.finish(au, ts, now)))
    }

    fn finish(&mut self, au: Vec<u8>, ts: u32, now: f64) -> Frame {
        let (mut idr, mut has_sps, mut has_pps, mut aud) = (false, false, false, 0);
        for (i, n) in nals(&au).into_iter().enumerate() {
            match n.get(4).map(|h| h & 0x1f) {
                Some(5) => idr = true,
                Some(7) => (self.sps, has_sps) = (n.to_vec(), true),
                Some(8) => (self.pps, has_pps) = (n.to_vec(), true),
                Some(9) if i == 0 => aud = n.len(),
                _ => {}
            }
        }
        let key = idr && !self.sps.is_empty() && !self.pps.is_empty();
        let data = if key && !(has_sps && has_pps) {
            // re-insert the cached parameter sets so a decoder can start here (after an AUD, if any)
            let mut v = Vec::with_capacity(au.len() + self.sps.len() + self.pps.len());
            v.extend_from_slice(&au[..aud]);
            v.extend_from_slice(&self.sps);
            v.extend_from_slice(&self.pps);
            v.extend_from_slice(&au[aud..]);
            v
        } else {
            au
        };
        // Arrival time from the RTP clock, anchored to the earliest arrivals (network jitter does not
        // reach the output pacing), slowly pulled towards real arrival so clock drift cannot build up.
        let t = match self.clock {
            Some((t0, ts0)) => {
                let p = t0 + ts.wrapping_sub(ts0) as i32 as f64 / 90000.0;
                if p > now || p < now - 0.5 { now } else { p + (now - p) * 0.002 }
            }
            None => now,
        };
        self.clock = Some((t, ts));
        Frame { t, data: data.into(), key }
    }
}

// ───────────────────────────── shared state + output ─────────────────────────────

#[derive(Default)]
struct Stats {
    bytes: u64,  // since last status line
    frames: u64, // since last status line
    keyframes: u64,
    lost: u64,
    plis: u64,
    out: u64,
    connected: bool,
}

struct Shared {
    buf: DelayBuffer,
    stats: Stats,
}

pub struct Config {
    pub bridge: String,
    pub name: String,
    pub delay: f64,
    pub out: String,
}

fn ffmpeg(out: &str) -> std::io::Result<Child> {
    // -use_wallclock_as_timestamps: the frames arrive already paced by the delay buffer, so the time
    // ffmpeg reads them is the presentation time (gaps from losses / delay changes stay real gaps).
    Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "warning", "-fflags", "+nobuffer", "-probesize", "32"])
        .args(["-analyzeduration", "0", "-use_wallclock_as_timestamps", "1", "-f", "h264", "-i", "pipe:0"])
        .args(["-c", "copy", "-f", "mpegts", "-flush_packets", "1", out])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
}

fn output_loop(out: String, shared: Arc<Mutex<Shared>>, t0: Instant) {
    let mut child: Option<Child> = None;
    let mut next_status = 2.0;
    loop {
        std::thread::sleep(Duration::from_millis(4));
        let now = t0.elapsed().as_secs_f64();
        let mut due = Vec::new();
        {
            let s = &mut *shared.lock().unwrap();
            while let Some(f) = s.buf.pop(now) {
                due.push(f);
            }
            s.stats.out += due.len() as u64;
            if now >= next_status {
                let st = &mut s.stats;
                let line = serde_json::json!({
                    "buffered": (s.buf.buffered() * 100.0).round() / 100.0,
                    "delay": s.buf.delay(),
                    "kbps": st.bytes * 8 / 2000,
                    "fps": st.frames as f64 / 2.0,
                    "keyframes": st.keyframes, "lost": st.lost, "plis": st.plis, "out": st.out,
                    "connected": st.connected,
                });
                (st.bytes, st.frames) = (0, 0);
                println!("{line}");
                next_status += 2.0;
            }
        }
        for f in due {
            let c = match &mut child {
                Some(c) => c,
                None => child.insert(ffmpeg(&out).expect("cannot start ffmpeg (is it on PATH?)")),
            };
            if let Err(e) = c.stdin.as_mut().unwrap().write_all(&f.data) {
                let st = c.try_wait();
                let _ = c.kill();
                eprintln!("[out] ffmpeg pipe: {e} (exit {st:?}), restarting at the next keyframe");
                child = None;
                shared.lock().unwrap().buf.restart_output();
                break;
            }
        }
    }
}

// ───────────────────────────── WebRTC pull ─────────────────────────────

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

async fn post(url: String, sdp: Option<String>) -> Res<String> {
    tokio::task::spawn_blocking(move || -> Res<String> {
        let req = ureq::post(&url);
        let mut r = match sdp {
            Some(b) => req.header("content-type", "application/sdp").send(b)?,
            None => req.send_empty()?,
        };
        Ok(r.body_mut().read_to_string()?)
    })
    .await?
}

struct Handler {
    gathered: tokio::sync::mpsc::Sender<()>,
    track: tokio::sync::mpsc::Sender<Arc<dyn TrackRemote>>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            let _ = self.gathered.try_send(());
        }
    }
    async fn on_track(&self, track: Arc<dyn TrackRemote>) {
        let _ = self.track.try_send(track);
    }
}

async fn session(cfg: &Config, shared: &Arc<Mutex<Shared>>, t0: Instant) -> Res<()> {
    let base = cfg.bridge.trim_end_matches('/');
    let j: serde_json::Value = serde_json::from_str(&post(format!("{base}/pull/{}", enc(&cfg.name)), None).await?)?;
    let (Some(sid), Some(offer)) = (j["sessionId"].as_str(), j["sdp"].as_str()) else {
        return Err("bad /pull response".into());
    };
    let mut me = MediaEngine::default();
    me.register_default_codecs()?;
    let reg = register_default_interceptors(Registry::new(), &mut me)?;
    let (gtx, mut grx) = tokio::sync::mpsc::channel(1);
    let (ttx, mut trx) = tokio::sync::mpsc::channel(1);
    let pc = PeerConnectionBuilder::new()
        .with_configuration(RTCConfigurationBuilder::new().build())
        .with_media_engine(me)
        .with_interceptor_registry(reg)
        .with_handler(Arc::new(Handler { gathered: gtx, track: ttx }))
        .with_runtime(webrtc::runtime::default_runtime().ok_or("no runtime")?)
        .with_udp_addrs(vec!["0.0.0.0:0"])
        .build()
        .await?;
    let r = async {
        pc.set_remote_description(RTCSessionDescription::offer(offer.to_string())?).await?;
        let answer = pc.create_answer(None).await?;
        pc.set_local_description(answer).await?;
        let _ = tokio::time::timeout(Duration::from_secs(5), grx.recv()).await; // non-trickle
        let local = pc.local_description().await.ok_or("no local description")?.sdp;
        post(format!("{base}/pull/{}/answer", enc(sid)), Some(local)).await?;
        let track = tokio::time::timeout(Duration::from_secs(5), trx.recv()).await?.ok_or("no track")?;
        receive(track, shared, t0).await
    }
    .await;
    shared.lock().unwrap().stats.connected = false;
    let _ = pc.close().await;
    r
}

async fn receive(track: Arc<dyn TrackRemote>, shared: &Arc<Mutex<Shared>>, t0: Instant) -> Res<()> {
    let ssrc = *track.ssrcs().await.first().ok_or("track without ssrc")?;
    let mut ing = Ingest::default();
    shared.lock().unwrap().buf.loss(); // a new stream starts at its first keyframe
    let (mut need_key, mut last_pli) = (true, f64::NEG_INFINITY);
    eprintln!("[pull] connected");
    loop {
        let ev = tokio::time::timeout(Duration::from_secs(3), track.poll())
            .await
            .map_err(|_| "no video for 3 s")?
            .ok_or("track closed")?;
        let p = match ev {
            TrackRemoteEvent::OnRtpPacket(p) => p,
            TrackRemoteEvent::OnEnded => return Err("track ended".into()),
            _ => continue,
        };
        let now = t0.elapsed().as_secs_f64();
        let (lost, frame) = ing.rtp(p.header.sequence_number, p.header.timestamp, p.header.marker, &p.payload, now);
        {
            let mut s = shared.lock().unwrap();
            s.stats.connected = true;
            s.stats.bytes += p.payload.len() as u64;
            if lost > 0 {
                s.stats.lost += lost as u64;
                s.buf.loss();
                (need_key, last_pli) = (true, f64::NEG_INFINITY);
            }
            if let Some(f) = frame {
                s.stats.frames += 1;
                if f.key && need_key {
                    need_key = false;
                }
                s.stats.keyframes += f.key as u64;
                s.buf.push(f);
            }
        }
        if need_key && now - last_pli >= 1.0 {
            // ask for a keyframe (at start / after a loss), at most once a second
            track.write_rtcp(vec![Box::new(PictureLossIndication { sender_ssrc: 0, media_ssrc: ssrc })]).await?;
            last_pli = now;
            shared.lock().unwrap().stats.plis += 1;
        }
    }
}

/// Runs forever: output thread, stdin commands (`delay <seconds>`), and the pull loop with retry.
pub fn run(cfg: Config) -> Res<()> {
    let t0 = Instant::now();
    let shared = Arc::new(Mutex::new(Shared { buf: DelayBuffer::new(cfg.delay), stats: Stats::default() }));
    let (s, out) = (shared.clone(), cfg.out.clone());
    std::thread::spawn(move || output_loop(out, s, t0));
    let s = shared.clone();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            match line.trim().strip_prefix("delay").map(|v| v.trim().parse::<f64>()) {
                Some(Ok(d)) if d.is_finite() => s.lock().unwrap().buf.set_delay(t0.elapsed().as_secs_f64(), d),
                _ => eprintln!("[cmd] unknown command {line:?} (try: delay 12.5)"),
            }
        }
    });
    tokio::runtime::Runtime::new()?.block_on(async {
        loop {
            if let Err(e) = session(&cfg, &shared, t0).await {
                eprintln!("[pull] {e}, retrying in 2 s");
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    })
}

// ───────────────────────────── tests ─────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn f(t: f64, key: bool) -> Frame {
        Frame { t, data: Bytes::from(vec![t as u8]), key }
    }
    fn times(b: &mut DelayBuffer, now: f64) -> Vec<f64> {
        std::iter::from_fn(|| b.pop(now)).map(|f| f.t).collect()
    }

    #[test]
    fn releases_at_arrival_plus_delay_starting_on_keyframe() {
        let mut b = DelayBuffer::new(10.0);
        b.push(f(0.0, false)); // before the first keyframe: never buffered
        b.push(f(1.0, true));
        b.push(f(2.0, false));
        assert!(times(&mut b, 10.9).is_empty());
        assert_eq!(times(&mut b, 11.0), vec![1.0]);
        assert!(times(&mut b, 11.9).is_empty());
        assert_eq!(times(&mut b, 12.0), vec![2.0]);
    }

    #[test]
    fn output_start_skips_to_keyframe() {
        let mut b = DelayBuffer::new(1.0);
        b.push(f(0.0, true));
        assert_eq!(times(&mut b, 1.0), vec![0.0]);
        b.restart_output(); // e.g. ffmpeg restarted mid-GOP
        b.push(f(0.5, false));
        b.push(f(0.8, true));
        assert_eq!(times(&mut b, 2.0), vec![0.8]);
    }

    #[test]
    fn loss_skips_until_next_keyframe() {
        let mut b = DelayBuffer::new(1.0);
        b.push(f(0.0, true));
        b.push(f(0.1, false));
        b.loss();
        b.push(f(0.2, false));
        b.push(f(0.3, false));
        b.push(f(0.4, true));
        b.push(f(0.5, false));
        assert_eq!(times(&mut b, 2.0), vec![0.0, 0.1, 0.4, 0.5]);
    }

    #[test]
    fn delay_shrink_jumps_to_next_keyframe_and_grow_pauses() {
        let mut b = DelayBuffer::new(10.0);
        for i in 0..100 {
            b.push(f(i as f64 / 10.0, i % 20 == 0)); // keyframe every 2 s
        }
        assert_eq!(times(&mut b, 10.0), vec![0.0]);
        // at now=10 shrink to 3 s: content up to t=7 is overdue -> dropped, resume at the keyframe t=8
        b.set_delay(10.0, 3.0);
        assert!(times(&mut b, 10.9).is_empty());
        assert_eq!(times(&mut b, 11.0), vec![8.0]);
        assert_eq!(times(&mut b, 11.15).len(), 1);
        // grow to 5 s at now=11.15: nothing for 2 s, then it continues exactly where it stopped
        b.set_delay(11.15, 5.0);
        assert!(times(&mut b, 13.0).is_empty());
        let t = times(&mut b, 13.25);
        assert!((t[0] - 8.2).abs() < 1e-9 && t.len() == 1, "{t:?}");
    }

    #[test]
    fn ingest_assembles_frames_caches_parameter_sets_and_flags_loss() {
        let mut ing = Ingest::default();
        let nal = |t: u8| Bytes::from(vec![t, 0xAA, 0xBB]);
        assert!(ing.rtp(1, 0, false, &nal(0x67), 0.0).1.is_none()); // SPS
        assert!(ing.rtp(2, 0, false, &nal(0x68), 0.0).1.is_none()); // PPS
        let k = ing.rtp(3, 0, true, &nal(0x65), 0.0).1.unwrap(); // IDR
        assert!(k.key && nals(&k.data).len() == 3);
        // a later IDR without SPS/PPS gets them re-inserted
        let k = ing.rtp(4, 3000, true, &nal(0x65), 0.033).1.unwrap();
        assert!(k.key && nals(&k.data).len() == 3 && k.data[4] == 0x67);
        assert!((k.t - 3000.0 / 90000.0).abs() < 1e-3);
        // seq 5 lost: the frame of seq 6 is dropped and the gap reported
        let (lost, fr) = ing.rtp(6, 6000, true, &nal(0x41), 0.066);
        assert!(lost == 1 && fr.is_none());
        let fr = ing.rtp(7, 9000, true, &nal(0x41), 0.1).1.unwrap();
        assert!(!fr.key && nals(&fr.data).len() == 1);
    }
}
