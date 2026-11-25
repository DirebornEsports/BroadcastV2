//! The ffmpeg sender: webcam -> GPU H.264 -> WHIP bridge. Same command as sender/kirim.ps1 (keep the two in step).
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::UdpSocket;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody};

pub const KBPS: u32 = 4500;
pub const SIZE: &str = "1920x1080";
pub const FPS: u32 = 30;

/// first encoder that opens on this PC wins: NVIDIA, AMD, Intel, then software
pub const ENCODERS: [&str; 4] = ["h264_nvenc", "h264_amf", "h264_qsv", "libx264"];

fn encoder_opts(enc: &str) -> &'static [&'static str] {
    match enc {
        "h264_nvenc" => &["-preset", "p4", "-tune", "ll", "-profile:v", "baseline"],
        "h264_amf" => &["-usage", "lowlatency", "-profile:v", "constrained_baseline"], // ultralowlatency fails on older AMD (RX 580)
        "h264_qsv" => &["-preset", "veryfast", "-profile:v", "baseline"],
        _ => &["-preset", "veryfast", "-tune", "zerolatency", "-profile:v", "baseline"],
    }
}

fn strs(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

/// One black frame through the encoder: exit code 0 = this encoder works on this PC.
pub fn probe_args(enc: &str, size: &str, fps: u32) -> Vec<String> {
    let mut a = strs(&["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i"]);
    a.push(format!("color=black:s={size}:r={fps}"));
    a.extend(strs(&["-frames:v", "1", "-pix_fmt", "nv12", "-c:v", enc]));
    a.extend(strs(encoder_opts(enc)));
    a.extend(strs(&["-f", "null", "-"]));
    a
}

/// Local UDP ports the same ffmpeg also feeds for the Live screen (each input is decoded once for all outputs).
#[derive(Clone, Copy)]
pub struct Monitor {
    pub video: u16,
    pub audio: u16,
    pub stats: u16,
}

/// The sender command. camera "test" = test pattern (no camera); mic "" = no sound, "test" = beep (with camera "test").
/// Output 1 is the WHIP stream (as kirim.ps1); outputs 2-3 and the stats are app only, for the Live screen.
#[allow(clippy::too_many_arguments)]
pub fn send_args(enc: &str, camera: &str, mic: &str, url: &str, kbps: u32, size: &str, fps: u32, mon: Monitor) -> Vec<String> {
    let mut a = strs(&["-hide_banner", "-loglevel", "warning"]);
    if camera == "test" {
        // test pattern; with mic test the picture flashes white while a beep plays, every 2 s (A/V sync check)
        a.extend(strs(&["-re", "-f", "lavfi", "-i"]));
        a.push(format!("testsrc2=s={size}:r={fps},drawbox=c=white:t=fill:enable='lt(mod(t,2),0.1)'"));
        if mic == "test" {
            a.extend(strs(&["-re", "-f", "lavfi", "-i", "aevalsrc='if(lt(mod(t,2),0.1),0.5*sin(2*PI*1000*t),0)':s=48000"]));
        }
    } else {
        // one dshow input for camera and mic keeps their timestamps on the same clock
        let dev = if mic.is_empty() { format!("video={camera}") } else { format!("video={camera}:audio={mic}") };
        // 20 ms mic chunks: with the default (~0.5 s) the muxer sends video and sound in bursts and ~70% of the
        // packets never reached the bridge
        a.extend(strs(&["-f", "dshow", "-rtbufsize", "256M", "-audio_buffer_size", "20", "-vcodec", "mjpeg", "-video_size", size]));
        a.extend(["-framerate".into(), fps.to_string(), "-i".into(), dev]);
    }
    // the mic stream, if any: dshow carries camera and mic in input 0, the test beep is input 1
    let audio = if mic.is_empty() {
        None
    } else if camera != "test" {
        Some("0:a")
    } else if mic == "test" {
        Some("1:a")
    } else {
        None // a real mic with the test pattern has no input (kirim.ps1 ignores it too)
    };
    // app only (not in kirim.ps1), global so it goes before the outputs: frame counter and fps on stdout, so the
    // window can tell "sending" from "stuck"
    a.extend(strs(&["-progress", "pipe:1"]));
    // ---- output 1: WHIP to the studio ----
    a.extend(strs(&["-map", "0:v"]));
    match audio {
        None => a.push("-an".into()),
        Some(m) => a.extend(strs(&["-map", m, "-c:a", "libopus", "-b:a", "64k", "-ar", "48000", "-ac", "2", "-application", "lowdelay"])),
    }
    a.extend(strs(&["-pix_fmt", "nv12", "-c:v", enc]));
    a.extend(strs(encoder_opts(enc)));
    // A 1080p keyframe leaves as one burst; when it is too big, packets are lost before the bridge. Every encoder
    // gets the same cap: no frame larger than 4x the average frame (only keyframes reach it).
    let cap_kbit = kbps * 4 / fps;
    let b = format!("{kbps}k");
    if enc == "h264_amf" {
        // AMD ignores the buffer size on keyframes, so it gets a hard per-frame limit instead
        a.extend(strs(&["-rc", "cbr", "-b:v", &b, "-maxrate", &b, "-bufsize", &format!("{}k", kbps / 2)]));
        a.extend(strs(&["-enforce_hrd", "1", "-max_au_size", &(cap_kbit * 1000).to_string()]));
    } else {
        if enc != "libx264" {
            a.extend(strs(&["-rc", "cbr"]));
        }
        // NVIDIA, Intel, x264: the VBV buffer is the cap
        a.extend(strs(&["-b:v", &b, "-maxrate", &b, "-bufsize", &format!("{cap_kbit}k")]));
        if enc == "h264_nvenc" {
            a.extend(strs(&["-zerolatency", "1"]));
        }
    }
    // keyframe every 2 s: a viewer (or the delay buffer after a lost packet) never waits longer than that
    a.extend(["-g".into(), (fps * 2).to_string(), "-bf".into(), "0".into()]);
    // app only: the size of every sent video packet, one datagram each -> bitrate (-progress says N/A for WHIP)
    a.extend(["-stats_mux_pre_fmt:v".into(), "{size}".into(), "-stats_mux_pre:v".into(), format!("udp://127.0.0.1:{}", mon.stats)]);
    // 1 MB UDP buffer: a 1080p keyframe burst otherwise fails with "UDP send blocked" and ends the sender
    a.extend(strs(&["-ts_buffer_size", "1048576", "-f", "whip", url]));
    // ---- output 2: what is being sent, for the Live screen: 4 small JPEGs a second, one per datagram ----
    // (320 px wide at q 8 is ~5-20 KB a frame, far below the 64 KB a datagram can carry)
    // -r 4, not the fps filter: with fps=4 here the bridge counted ~400 lost WHIP packets a second (ffmpeg 9.0.2)
    a.extend(strs(&["-map", "0:v", "-vf", "scale=320:-2", "-r", "4", "-c:v", "mjpeg", "-q:v", "8", "-f", "mjpeg"]));
    a.push(format!("udp://127.0.0.1:{}?pkt_size=65000", mon.video));
    // ---- output 3: the mic as 8 kHz mono PCM for the level bar ----
    if let Some(m) = audio {
        a.extend(strs(&["-map", m, "-c:a", "pcm_s16le", "-ar", "8000", "-ac", "1", "-f", "s16le"]));
        a.push(format!("udp://127.0.0.1:{}", mon.audio));
    }
    a
}

/// For the PIN in the URL (the operator types digits, but never trust a URL part). Like [uri]::EscapeDataString: everything but A-Z a-z 0-9 - _ . ~ becomes %XX (UTF-8).
/// LAN studio "host:port" -> http://host:port/whip/..., online relay "https://..." -> used as typed
pub fn whip_url(addr: &str, pin: &str) -> String {
    let base = if addr.starts_with("https://") { addr.trim_end_matches('/').to_string() } else { format!("http://{addr}") };
    format!("{base}/whip/cam?pin={}", escape(pin))
}

pub fn escape(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// `[in#0 @ ...] "name" (video)` lines -> (cameras, mics)
pub fn parse_devices(out: &str) -> (Vec<String>, Vec<String>) {
    let pick = |kind: &str| {
        out.lines()
            .filter_map(|l| l.trim_end().strip_suffix(&format!("\" ({kind})")))
            .filter_map(|l| l.split_once('"').map(|(_, n)| n.to_string()))
            .collect()
    };
    (pick("video"), pick("audio"))
}

/// ffmpeg on PATH, else the WinGet Links folder (a fresh `winget install` is not on this process's PATH yet).
pub fn find_ffmpeg() -> Option<PathBuf> {
    if std::env::var("DIREBORN_FAKE_NO_FFMPEG").as_deref() == Ok("1") {
        return None;
    }
    let links = std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join(r"Microsoft\WinGet\Links\ffmpeg.exe"));
    let path = std::env::var_os("PATH").unwrap_or_default();
    let p = std::env::split_paths(&path).map(|d| d.join("ffmpeg.exe")).chain(links).find(|p| p.is_file())?;
    // the WinGet entry is a symlink: start the real exe
    let real = std::fs::canonicalize(&p).unwrap_or(p);
    Some(PathBuf::from(real.to_string_lossy().trim_start_matches(r"\\?\")))
}

/// A child process without a console window popping up.
pub fn command(exe: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut c = Command::new(exe);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut c, 0x0800_0000); // CREATE_NO_WINDOW
    c
}

pub fn probe_encoder(ffmpeg: &PathBuf) -> Option<&'static str> {
    ENCODERS.into_iter().find(|e| {
        command(ffmpeg).args(probe_args(e, SIZE, FPS)).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .status().is_ok_and(|s| s.success())
    })
}

/// s16le mono samples -> (rms, peak), both 0..1
pub fn level(pcm: &[u8]) -> (f32, f32) {
    let s: Vec<f32> = pcm.as_chunks::<2>().0.iter().map(|b| i16::from_le_bytes(*b) as f32 / 32768.0).collect();
    if s.is_empty() {
        return (0.0, 0.0);
    }
    let rms = (s.iter().map(|x| x * x).sum::<f32>() / s.len() as f32).sqrt();
    (rms, s.iter().fold(0.0, |m, x| m.max(x.abs())))
}

/// A whole JPEG in one datagram (a frame over 64 KB would arrive in pieces: drop those)
fn is_jpeg(d: &[u8]) -> bool {
    d.starts_with(&[0xFF, 0xD8]) && d.ends_with(&[0xFF, 0xD9])
}

/// One run of the sender (a fresh one per Start): a loop that restarts ffmpeg every 3 s until stopped.
#[derive(Default)]
pub struct Live {
    stop: AtomicBool,
    child: Mutex<Option<Child>>,
}

impl Live {
    /// `args` gets the monitor ports; `preview` receives the JPEGs, `out` everything else as JSON.
    pub fn run(self: &Arc<Self>, ffmpeg: PathBuf, args: impl FnOnce(Monitor) -> Vec<String>, out: Channel<Value>, preview: Channel) -> std::io::Result<()> {
        let bind = || -> std::io::Result<UdpSocket> {
            let s = UdpSocket::bind("127.0.0.1:0")?;
            s.set_read_timeout(Some(Duration::from_millis(500)))?;
            Ok(s)
        };
        let (v, au, st) = (bind()?, bind()?, bind()?);
        let args = args(Monitor { video: v.local_addr()?.port(), audio: au.local_addr()?.port(), stats: st.local_addr()?.port() });
        self.listen(v, move |d| {
            if let Some(d) = d.filter(|d| is_jpeg(d)) {
                let _ = preview.send(InvokeResponseBody::Raw(d.to_vec()));
            }
        });
        // a datagram is ~20 ms of sound: report the loudest of every 100 ms, so short sounds stay visible on the bar
        let (o, mut loud, mut since) = (out.clone(), (0.0f32, 0.0f32), Instant::now());
        self.listen(au, move |d| {
            let (rms, peak) = d.map_or((0.0, 0.0), level); // silence while ffmpeg restarts
            loud = (loud.0.max(rms), loud.1.max(peak));
            if d.is_none() || since.elapsed() >= Duration::from_millis(100) {
                let _ = o.send(json!({ "mic": { "rms": loud.0, "peak": loud.1 } }));
                (loud, since) = ((0.0, 0.0), Instant::now());
            }
        });
        let (o, mut bytes, mut since) = (out.clone(), 0u64, Instant::now());
        self.listen(st, move |d| {
            let t = d.and_then(|d| std::str::from_utf8(d).ok()).unwrap_or("");
            bytes += t.lines().filter_map(|l| l.trim().parse::<u64>().ok()).sum::<u64>();
            let dt = since.elapsed().as_secs_f64();
            if dt >= 1.0 {
                let _ = o.send(json!({ "kbps": (bytes as f64 * 8.0 / 1000.0 / dt).round() }));
                (bytes, since) = (0, Instant::now());
            }
        });
        let me = self.clone();
        std::thread::spawn(move || {
            let mut reconnects = 0;
            while !me.stop.load(Ordering::SeqCst) {
                let _ = out.send(json!({ "state": "connecting", "reconnects": reconnects }));
                reconnects += 1;
                match command(&ffmpeg).args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
                    Err(e) => { let _ = out.send(json!({ "log": format!("ffmpeg tidak bisa dijalankan: {e}") })); }
                    Ok(mut child) => {
                        let (stdout, stderr) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
                        *me.child.lock().unwrap() = Some(child);
                        if me.stop.load(Ordering::SeqCst) {
                            me.stop(); // stop() came while ffmpeg was starting
                        }
                        let log = out.clone();
                        std::thread::spawn(move || {
                            for l in BufReader::new(stderr).lines().map_while(Result::ok) {
                                let _ = log.send(json!({ "log": l }));
                            }
                        });
                        // -progress blocks: frame=.. fps=.. ... progress=continue
                        let (mut frame, mut fps, mut last) = (0u64, 0.0f64, 0u64);
                        for l in BufReader::new(stdout).lines().map_while(Result::ok) {
                            match l.split_once('=') {
                                Some(("frame", n)) => frame = n.trim().parse().unwrap_or(frame),
                                Some(("fps", n)) => fps = n.trim().parse().unwrap_or(0.0),
                                Some(("progress", _)) if frame > last => {
                                    last = frame;
                                    let _ = out.send(json!({ "state": "sending", "frame": frame, "fps": fps }));
                                }
                                _ => {}
                            }
                        }
                        if let Some(mut c) = me.child.lock().unwrap().take() {
                            let _ = c.wait();
                        }
                    }
                }
                if me.stop.load(Ordering::SeqCst) {
                    break;
                }
                let _ = out.send(json!({ "state": "retry" }));
                let until = Instant::now() + Duration::from_secs(3);
                while Instant::now() < until && !me.stop.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
            let _ = out.send(json!({ "state": "stopped" }));
        });
        Ok(())
    }

    /// Datagrams to `f` (None every 0.5 s without one) until this run is stopped.
    fn listen(self: &Arc<Self>, s: UdpSocket, mut f: impl FnMut(Option<&[u8]>) + Send + 'static) {
        let me = self.clone();
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 65536];
            while !me.stop.load(Ordering::SeqCst) {
                match s.recv(&mut buf) {
                    Ok(n) => f(Some(&buf[..n])),
                    Err(_) => f(None),
                }
            }
        });
    }

    /// Ask ffmpeg to quit ('q' lets the WHIP muxer say goodbye to the bridge), kill it after 2 s.
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        let Some(mut c) = self.child.lock().unwrap().take() else { return };
        if let Some(mut i) = c.stdin.take() {
            let _ = i.write_all(b"q");
        }
        let until = Instant::now() + Duration::from_secs(2);
        while Instant::now() < until && matches!(c.try_wait(), Ok(None)) {
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = c.kill();
        let _ = c.wait();
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn whip_url_lan_and_online() {
        assert_eq!(super::whip_url("192.168.1.10:8787", "1234"), "http://192.168.1.10:8787/whip/cam?pin=1234");
        assert_eq!(super::whip_url("https://cam.example.workers.dev/", "0042"), "https://cam.example.workers.dev/whip/cam?pin=0042");
    }

    use super::*;

    const MON: Monitor = Monitor { video: 5555, audio: 5556, stats: 5557 };
    const PREVIEW: &str = "-map 0:v -vf scale=320:-2 -r 4 -c:v mjpeg -q:v 8 -f mjpeg udp://127.0.0.1:5555?pkt_size=65000";

    fn joined(enc: &str, cam: &str, mic: &str) -> String {
        send_args(enc, cam, mic, "http://1.2.3.4:8787/whip/cam?pin=1234", KBPS, SIZE, FPS, MON).join(" ")
    }

    #[test]
    fn amf_gets_hard_frame_cap() {
        let a = joined("h264_amf", "OsmoPocket4", "Capture Input terminal (OsmoPocket4)");
        assert!(a.contains("-i video=OsmoPocket4:audio=Capture Input terminal (OsmoPocket4)"));
        assert!(a.contains("-usage lowlatency -profile:v constrained_baseline"));
        assert!(a.contains("-rc cbr -b:v 4500k -maxrate 4500k -bufsize 2250k -enforce_hrd 1 -max_au_size 600000"));
        assert!(a.contains("-audio_buffer_size 20"));
        // global -progress, then output 1 (WHIP) with explicit maps, output 2 (preview), output 3 (mic level)
        assert!(a.contains("(OsmoPocket4) -progress pipe:1 -map 0:v -map 0:a -c:a libopus -b:a 64k -ar 48000 -ac 2 -application lowdelay -pix_fmt nv12 -c:v h264_amf"));
        assert!(a.ends_with(&format!("-g 60 -bf 0 -stats_mux_pre_fmt:v {{size}} -stats_mux_pre:v udp://127.0.0.1:5557 -ts_buffer_size 1048576 -f whip http://1.2.3.4:8787/whip/cam?pin=1234 {PREVIEW} -map 0:a -c:a pcm_s16le -ar 8000 -ac 1 -f s16le udp://127.0.0.1:5556")));
    }

    #[test]
    fn vbv_cap_for_the_others() {
        assert!(joined("h264_nvenc", "Cam", "").contains("-progress pipe:1 -map 0:v -an -pix_fmt nv12 -c:v h264_nvenc -preset p4 -tune ll -profile:v baseline -rc cbr -b:v 4500k -maxrate 4500k -bufsize 600k -zerolatency 1 -g 60"));
        assert!(joined("h264_qsv", "Cam", "").contains("-rc cbr -b:v 4500k -maxrate 4500k -bufsize 600k -g 60"));
        let x = joined("libx264", "Cam", "");
        assert!(x.contains("-tune zerolatency -profile:v baseline -b:v 4500k -maxrate 4500k -bufsize 600k -g 60") && !x.contains("-rc"));
        // no mic: no mic-level output
        assert!(x.ends_with(&format!("-f whip http://1.2.3.4:8787/whip/cam?pin=1234 {PREVIEW}")));
    }

    #[test]
    fn test_pattern_input() {
        let a = joined("libx264", "test", "test");
        assert!(a.starts_with("-hide_banner -loglevel warning -re -f lavfi -i testsrc2=s=1920x1080:r=30,"));
        assert!(a.contains("aevalsrc=") && !a.contains("dshow"));
        assert!(a.contains("-map 0:v -map 1:a -c:a libopus") && a.ends_with("-map 1:a -c:a pcm_s16le -ar 8000 -ac 1 -f s16le udp://127.0.0.1:5556"));
        // a real mic with the test pattern has no audio input: nothing may map it
        assert!(!joined("libx264", "test", "Mic X").contains(":a "));
        assert_eq!(probe_args("h264_amf", SIZE, FPS).join(" "),
            "-hide_banner -loglevel error -f lavfi -i color=black:s=1920x1080:r=30 -frames:v 1 -pix_fmt nv12 -c:v h264_amf -usage lowlatency -profile:v constrained_baseline -f null -");
    }

    #[test]
    fn devices_and_escape() {
        let out = "[in#0 @ 0000] \"OsmoPocket4\" (video)\n[in#0 @ 0000]   Alternative name \"@device_pnp_x\"\n[in#0 @ 0000] \"Capture Input terminal (OsmoPocket4)\" (audio)\r\n";
        assert_eq!(parse_devices(out), (vec!["OsmoPocket4".into()], vec!["Capture Input terminal (OsmoPocket4)".into()]));
        assert_eq!(escape("12 4/é"), "12%204%2F%C3%A9");
    }

    #[test]
    fn mic_level_and_jpeg() {
        let pcm: Vec<u8> = [16384i16, -16384, 16384, -32768].iter().flat_map(|s| s.to_le_bytes()).collect();
        let (rms, peak) = level(&pcm);
        assert!((peak - 1.0).abs() < 1e-6 && (rms - 0.661).abs() < 0.001);
        assert_eq!(level(&[]), (0.0, 0.0));
        assert!(is_jpeg(&[0xFF, 0xD8, 1, 0xFF, 0xD9]) && !is_jpeg(&[0xFF, 0xD8, 1, 2]));
    }
}
