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
use std::io::BufRead;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use rtc::rtp_transceiver::rtp_sender::RtpCodecKind;
use webrtc::media_stream::track_remote::{TrackRemote, TrackRemoteEvent};
use webrtc::peer_connection::{
    MediaEngine, PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCConfigurationBuilder,
    RTCIceGatheringState, RTCSessionDescription, Registry, register_default_interceptors,
};

pub const MAX_DELAY: f64 = 1020.0;
type Res<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

// ───────────────────────────── runtime with a big UDP buffer ─────────────────────────────

use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use webrtc::runtime::{AsyncInterval, AsyncTcpListener, AsyncTcpStream, AsyncUdpSocket, JoinHandle, Runtime};

/// The default runtime, except every UDP socket gets an 8 MB receive buffer: a 1080p keyframe from a
/// GPU encoder arrives as one burst of 100+ packets, and Windows' default 64 KB buffer drops part of it,
/// so the keyframe never completes and no picture ever comes out.
#[derive(Debug)]
struct BigBufRuntime(Arc<dyn Runtime>);

impl Runtime for BigBufRuntime {
    fn spawn(&self, f: Pin<Box<dyn Future<Output = ()> + Send>>) -> Box<dyn JoinHandle> {
        self.0.spawn(f)
    }
    fn spawn_reactor(&self, n: usize, f: Pin<Box<dyn Future<Output = ()> + Send>>) -> Box<dyn JoinHandle> {
        self.0.spawn_reactor(n, f)
    }
    fn wrap_udp_socket(&self, socket: std::net::UdpSocket) -> std::io::Result<Arc<dyn AsyncUdpSocket>> {
        let s = socket2::Socket::from(socket);
        if let Err(e) = s.set_recv_buffer_size(8 << 20) {
            eprintln!("[udp] could not raise receive buffer: {e}");
        }
        self.0.wrap_udp_socket(s.into())
    }
    fn wrap_tcp_listener(&self, l: std::net::TcpListener) -> std::io::Result<Arc<dyn AsyncTcpListener>> {
        self.0.wrap_tcp_listener(l)
    }
    fn connect_tcp<'a>(&'a self, a: SocketAddr) -> Pin<Box<dyn Future<Output = std::io::Result<Arc<dyn AsyncTcpStream>>> + Send + 'a>> {
        self.0.connect_tcp(a)
    }
    fn resolve_host<'a>(&'a self, h: &'a str) -> Pin<Box<dyn Future<Output = std::io::Result<Vec<SocketAddr>>> + Send + 'a>> {
        self.0.resolve_host(h)
    }
    fn now(&self) -> Instant {
        self.0.now()
    }
    fn sleep(&self, d: Duration) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
        self.0.sleep(d)
    }
    fn interval(&self, p: Duration) -> Box<dyn AsyncInterval> {
        self.0.interval(p)
    }
    fn block_on(&self, f: Pin<Box<dyn Future<Output = ()> + '_>>) {
        self.0.block_on(f)
    }
    fn yield_now(&self) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
        self.0.yield_now()
    }
    fn name(&self) -> &'static str {
        self.0.name()
    }
}

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

// ───────────────────────────── arrival clock ─────────────────────────────

/// Arrival time from the RTP clock, anchored to the earliest arrivals (network jitter does not reach
/// the output pacing), slowly pulled towards real arrival so clock drift cannot build up.
#[derive(Default)]
pub struct ArrivalClock(Option<(f64, u32)>);

impl ArrivalClock {
    pub fn at(&mut self, ts: u32, rate: f64, now: f64) -> f64 {
        let t = match self.0 {
            Some((t0, ts0)) => {
                let p = t0 + ts.wrapping_sub(ts0) as i32 as f64 / rate;
                if p > now || p < now - 0.5 { now } else { p + (now - p) * 0.002 }
            }
            None => now,
        };
        self.0 = Some((t, ts));
        t
    }
}

/// A plain RTP packet for the local hop into ffmpeg (payload types match the SDP we write for it).
pub fn rtp_bytes(pt: u8, marker: bool, seq: u16, ts: u32, ssrc: u32, payload: &[u8]) -> Bytes {
    let mut v = Vec::with_capacity(12 + payload.len());
    v.extend_from_slice(&[0x80, pt | if marker { 0x80 } else { 0 }]);
    v.extend_from_slice(&seq.to_be_bytes());
    v.extend_from_slice(&ts.to_be_bytes());
    v.extend_from_slice(&ssrc.to_be_bytes());
    v.extend_from_slice(payload);
    v.into()
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
    clock: ArrivalClock,
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
        let t = self.clock.at(ts, 90000.0, now);
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
    /// Opus RTP packets (all `key`), released on the same delay as the video.
    audio: DelayBuffer,
    has_audio: bool,
    stats: Stats,
}

impl Shared {
    fn set_delay(&mut self, now: f64, d: f64) {
        self.buf.set_delay(now, d);
        self.audio.set_delay(now, d);
    }
}

pub struct Config {
    pub bridge: String,
    pub name: String,
    pub delay: f64,
    pub out: String,
    /// File holding the delay in seconds, shared by every cam's receiver; checked twice a second.
    pub delay_file: Option<String>,
}

/// ffmpeg reads the delayed picture (and mic) as RTP on local UDP ports described by one SDP file, and
/// remuxes it to MPEG-TS without re-encoding. One input for both streams: with a raw H.264 pipe plus a
/// separate audio input, the two got different timestamps and the sound landed up to 0.5 s off.
/// -use_wallclock_as_timestamps: packets arrive already paced by the delay buffer, so the time ffmpeg
/// reads them is the presentation time (gaps from losses / delay changes stay real gaps).
fn ffmpeg(out: &str, sdp: &std::path::Path) -> std::io::Result<Child> {
    Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "warning", "-protocol_whitelist", "file,udp,rtp"])
        .args(["-fflags", "+nobuffer", "-max_delay", "0", "-reorder_queue_size", "0", "-buffer_size", "8388608"])
        // ~1 s of probing: the MPEG-TS muxer needs the picture size from the first keyframe's SPS
        .args(["-analyzeduration", "1000000", "-use_wallclock_as_timestamps", "1", "-i"])
        .arg(sdp)
        .args(["-c", "copy", "-f", "mpegts", "-flush_packets", "1", out])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .spawn()
}

fn write_sdp(path: &std::path::Path, vport: u16, aport: Option<u16>) -> std::io::Result<()> {
    let mut s = format!(
        "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=cam\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\n\
         m=video {vport} RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=fmtp:96 packetization-mode=1\r\n"
    );
    if let Some(a) = aport {
        s += &format!("m=audio {a} RTP/AVP 111\r\na=rtpmap:111 opus/48000/2\r\n");
    }
    std::fs::write(path, s)
}

fn free_port() -> u16 {
    std::net::UdpSocket::bind("127.0.0.1:0").and_then(|s| s.local_addr()).map(|a| a.port()).expect("no free local UDP port")
}

/// Annex-B access unit -> RTP packets: single-NAL or FU-A fragments of at most 1200 bytes, marker on the last.
pub fn packetize(au: &[u8], seq: &mut u16, ts: u32) -> Vec<Bytes> {
    const MAX: usize = 1200;
    let mut payloads: Vec<Vec<u8>> = Vec::new();
    for n in nals(au) {
        let n = &n[4..];
        if n.is_empty() {
            continue;
        }
        if n.len() <= MAX {
            payloads.push(n.to_vec());
            continue;
        }
        let chunks: Vec<&[u8]> = n[1..].chunks(MAX - 2).collect();
        for (i, c) in chunks.iter().enumerate() {
            let start = if i == 0 { 0x80 } else { 0 };
            let end = if i + 1 == chunks.len() { 0x40 } else { 0 };
            let mut p = vec![(n[0] & 0xe0) | 28, start | end | (n[0] & 0x1f)];
            p.extend_from_slice(c);
            payloads.push(p);
        }
    }
    let last = payloads.len().saturating_sub(1);
    payloads
        .iter()
        .enumerate()
        .map(|(i, p)| {
            *seq = seq.wrapping_add(1);
            rtp_bytes(96, i == last, *seq, ts, 0x4341_4d56, p) // SSRC "CAMV"
        })
        .collect()
}

fn output_loop(out: String, shared: Arc<Mutex<Shared>>, t0: Instant) {
    let mut child: Option<(Child, bool)> = None; // ffmpeg, and whether it was started with the mic
    let sdp = std::env::temp_dir().join(format!("studio-recv-{}.sdp", std::process::id()));
    let (vport, aport) = (free_port(), free_port());
    let sock = std::net::UdpSocket::bind("127.0.0.1:0").expect("cannot open the local output socket");
    let mut vseq = 0u16;
    let mut next_status = 2.0;
    loop {
        std::thread::sleep(Duration::from_millis(4));
        let now = t0.elapsed().as_secs_f64();
        let mut due = Vec::new();
        let mut adue = Vec::new();
        let has_audio;
        {
            let s = &mut *shared.lock().unwrap();
            has_audio = s.has_audio;
            let exited = child.as_mut().is_some_and(|(c, _)| !matches!(c.try_wait(), Ok(None)));
            if exited || child.as_ref().is_some_and(|(_, a)| *a != has_audio) {
                // ffmpeg died, or the mic came or went: start it again (with or without audio), from a keyframe
                if exited {
                    eprintln!("[out] ffmpeg exited, restarting at the next keyframe");
                }
                let _ = child.take().unwrap().0.kill();
                s.buf.restart_output();
            }
            while let Some(f) = s.buf.pop(now) {
                due.push(f);
            }
            while let Some(f) = s.audio.pop(now) {
                adue.push(f);
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
                    "connected": st.connected, "audio": has_audio,
                });
                (st.bytes, st.frames) = (0, 0);
                println!("{line}");
                next_status += 2.0;
            }
        }
        if child.is_none() && !due.is_empty() {
            write_sdp(&sdp, vport, has_audio.then_some(aport)).expect("cannot write the SDP file");
            child = Some((ffmpeg(&out, &sdp).expect("cannot start ffmpeg (is it on PATH?)"), has_audio));
            std::thread::sleep(Duration::from_millis(500)); // let ffmpeg open its ports before the keyframe goes out
        }
        if child.as_ref().is_some_and(|(_, a)| *a) {
            for f in adue {
                let _ = sock.send_to(&f.data, ("127.0.0.1", aport));
            }
        }
        if child.is_some() {
            for f in due {
                // RTP time from the arrival clock: unique per frame; ffmpeg's own timestamps come from the wall clock
                for p in packetize(&f.data, &mut vseq, (f.t * 90000.0) as u64 as u32) {
                    let _ = sock.send_to(&p, ("127.0.0.1", vport));
                }
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
    let (ttx, mut trx) = tokio::sync::mpsc::channel(2); // cam + mic
    let pc = PeerConnectionBuilder::new()
        .with_configuration(RTCConfigurationBuilder::new().build())
        .with_media_engine(me)
        .with_interceptor_registry(reg)
        .with_handler(Arc::new(Handler { gathered: gtx, track: ttx }))
        .with_runtime(Arc::new(BigBufRuntime(webrtc::runtime::default_runtime().ok_or("no runtime")?)))
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
        // Every track must be read as soon as it shows up: an unread track holds back the next one.
        let mut mic = None;
        let start_mic = |t: Arc<dyn TrackRemote>, mic: &mut Option<tokio::task::JoinHandle<()>>| {
            if mic.is_none() {
                eprintln!("[pull] mic connected");
                shared.lock().unwrap().has_audio = true;
                *mic = Some(tokio::spawn(receive_audio(t, shared.clone(), t0)));
            }
        };
        let video = loop {
            let t = tokio::time::timeout(Duration::from_secs(5), trx.recv()).await?.ok_or("no video track")?;
            if t.kind().await == RtpCodecKind::Audio { start_mic(t, &mut mic) } else { break t }
        };
        let v = receive(video, shared, t0);
        tokio::pin!(v);
        let r = loop {
            tokio::select! {
                r = &mut v => break r,
                Some(t) = trx.recv() => if t.kind().await == RtpCodecKind::Audio { start_mic(t, &mut mic) },
            }
        };
        if let Some(m) = mic {
            m.abort();
        }
        r
    }
    .await;
    {
        let mut s = shared.lock().unwrap();
        s.stats.connected = false;
        s.has_audio = false;
    }
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

/// Mic: every Opus packet is held on the same delay as the video (no loss handling: a lost 20 ms is inaudible).
async fn receive_audio(track: Arc<dyn TrackRemote>, shared: Arc<Mutex<Shared>>, t0: Instant) {
    let (mut clock, mut seq) = (ArrivalClock::default(), 0u16);
    while let Some(ev) = track.poll().await {
        if let TrackRemoteEvent::OnRtpPacket(p) = ev {
            let t = clock.at(p.header.timestamp, 48000.0, t0.elapsed().as_secs_f64());
            seq = seq.wrapping_add(1);
            let data = rtp_bytes(111, false, seq, p.header.timestamp, 0x4449_5245, &p.payload); // SSRC "DIRE"
            shared.lock().unwrap().audio.push(Frame { t, data, key: true });
        }
    }
}

/// Runs forever: output thread, stdin commands (`delay <seconds>`), and the pull loop with retry.
pub fn run(cfg: Config) -> Res<()> {
    let t0 = Instant::now();
    let shared = Arc::new(Mutex::new(Shared {
        buf: DelayBuffer::new(cfg.delay),
        audio: DelayBuffer::new(cfg.delay),
        has_audio: false,
        stats: Stats::default(),
    }));
    let (s, out) = (shared.clone(), cfg.out.clone());
    std::thread::spawn(move || output_loop(out, s, t0));
    let s = shared.clone();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            match line.trim().strip_prefix("delay").map(|v| v.trim().parse::<f64>()) {
                Some(Ok(d)) if d.is_finite() => s.lock().unwrap().set_delay(t0.elapsed().as_secs_f64(), d),
                _ => eprintln!("[cmd] unknown command {line:?} (try: delay 12.5)"),
            }
        }
    });
    if let Some(path) = cfg.delay_file.clone() {
        let s = shared.clone();
        std::thread::spawn(move || {
            let mut last = String::new();
            loop {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    let text = text.trim().to_string();
                    if text != last {
                        match text.parse::<f64>() {
                            Ok(d) if d.is_finite() => s.lock().unwrap().set_delay(t0.elapsed().as_secs_f64(), d),
                            _ => eprintln!("[delay-file] not a number: {text:?}"),
                        }
                        last = text;
                    }
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        });
    }
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
    fn packetize_round_trips_through_the_depacketizer() {
        let mut au = vec![0, 0, 0, 1, 0x67, 1, 2, 3]; // SPS (small: single NAL packet)
        au.extend_from_slice(&[0, 0, 0, 1, 0x65]); // IDR, 3000 bytes: split into FU-A
        au.extend((0..2999u32).map(|i| (i % 251) as u8 + 1));
        let mut seq = 10;
        let pkts = packetize(&au, &mut seq, 1234);
        assert_eq!(pkts.len(), 1 + 3);
        assert_eq!(seq, 14);
        assert!(pkts.iter().all(|p| p.len() <= 12 + 1200));
        assert_eq!(pkts.iter().map(|p| p[1] & 0x80 != 0).collect::<Vec<_>>(), [false, false, false, true]);
        let mut d = H264Packet::default();
        let mut back = Vec::new();
        for p in &pkts {
            back.extend_from_slice(&d.depacketize(&p.slice(12..)).unwrap());
        }
        assert_eq!(back, au);
    }

    #[test]
    fn audio_rtp_header_and_arrival_clock() {
        let b = rtp_bytes(111, true, 0x0102, 0x0a0b0c0d, 0x4449_5245, &[9, 9]);
        assert_eq!(&b[..], &[0x80, 0xef, 1, 2, 0x0a, 0x0b, 0x0c, 0x0d, 0x44, 0x49, 0x52, 0x45, 9, 9]);
        // a late (jittery) arrival is placed where the RTP clock says, not when it arrived
        let mut c = ArrivalClock::default();
        assert_eq!(c.at(0, 48000.0, 10.0), 10.0);
        let t = c.at(960, 48000.0, 10.1); // 20 ms of audio later, arrived 100 ms later
        assert!((t - 10.02).abs() < 0.001, "{t}");
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
