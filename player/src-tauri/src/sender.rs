//! The ffmpeg sender: webcam -> GPU H.264 -> WHIP bridge. Same command as sender/kirim.ps1 (keep the two in step).
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

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

/// The sender command. camera "test" = test pattern (no camera); mic "" = no sound, "test" = beep (with camera "test").
pub fn send_args(enc: &str, camera: &str, mic: &str, url: &str, kbps: u32, size: &str, fps: u32) -> Vec<String> {
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
    if mic.is_empty() {
        a.push("-an".into());
    } else {
        a.extend(strs(&["-c:a", "libopus", "-b:a", "64k", "-ar", "48000", "-ac", "2", "-application", "lowdelay"]));
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
    // 1 MB UDP buffer: a 1080p keyframe burst otherwise fails with "UDP send blocked" and ends the sender
    a.extend(strs(&["-ts_buffer_size", "1048576"]));
    // app only (not in kirim.ps1): frame counter on stdout so the window can tell "sending" from "stuck"
    a.extend(strs(&["-progress", "pipe:1", "-f", "whip", url]));
    a
}

/// For the PIN in the URL (the operator types digits, but never trust a URL part). Like [uri]::EscapeDataString: everything but A-Z a-z 0-9 - _ . ~ becomes %XX (UTF-8).
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

/// One run of the sender (a fresh one per Start): a loop that restarts ffmpeg every 3 s until stopped.
#[derive(Default)]
pub struct Live {
    stop: AtomicBool,
    child: Mutex<Option<Child>>,
}

impl Live {
    pub fn run(self: &Arc<Self>, ffmpeg: PathBuf, args: Vec<String>, out: Channel<Value>) {
        let me = self.clone();
        std::thread::spawn(move || {
            while !me.stop.load(Ordering::SeqCst) {
                let _ = out.send(json!({ "state": "connecting" }));
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
                        let mut last = 0u64;
                        for l in BufReader::new(stdout).lines().map_while(Result::ok) {
                            if let Some(n) = l.strip_prefix("frame=").and_then(|n| n.trim().parse::<u64>().ok()) {
                                if n > last {
                                    last = n;
                                    let _ = out.send(json!({ "state": "sending", "frame": n }));
                                }
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
    use super::*;

    fn joined(enc: &str, cam: &str, mic: &str) -> String {
        send_args(enc, cam, mic, "http://1.2.3.4:8787/whip/cam?pin=1234", KBPS, SIZE, FPS).join(" ")
    }

    #[test]
    fn amf_gets_hard_frame_cap() {
        let a = joined("h264_amf", "OsmoPocket4", "Capture Input terminal (OsmoPocket4)");
        assert!(a.contains("-i video=OsmoPocket4:audio=Capture Input terminal (OsmoPocket4)"));
        assert!(a.contains("-usage lowlatency -profile:v constrained_baseline"));
        assert!(a.contains("-rc cbr -b:v 4500k -maxrate 4500k -bufsize 2250k -enforce_hrd 1 -max_au_size 600000"));
        assert!(a.contains("-audio_buffer_size 20") && a.contains("-c:a libopus") && a.contains("-application lowdelay"));
        assert!(a.ends_with("-g 60 -bf 0 -ts_buffer_size 1048576 -progress pipe:1 -f whip http://1.2.3.4:8787/whip/cam?pin=1234"));
    }

    #[test]
    fn vbv_cap_for_the_others() {
        assert!(joined("h264_nvenc", "Cam", "").contains("-an -pix_fmt nv12 -c:v h264_nvenc -preset p4 -tune ll -profile:v baseline -rc cbr -b:v 4500k -maxrate 4500k -bufsize 600k -zerolatency 1 -g 60"));
        assert!(joined("h264_qsv", "Cam", "").contains("-rc cbr -b:v 4500k -maxrate 4500k -bufsize 600k -g 60"));
        let x = joined("libx264", "Cam", "");
        assert!(x.contains("-tune zerolatency -profile:v baseline -b:v 4500k -maxrate 4500k -bufsize 600k -g 60") && !x.contains("-rc"));
    }

    #[test]
    fn test_pattern_input() {
        let a = joined("libx264", "test", "test");
        assert!(a.starts_with("-hide_banner -loglevel warning -re -f lavfi -i testsrc2=s=1920x1080:r=30,"));
        assert!(a.contains("aevalsrc=") && !a.contains("dshow"));
        assert_eq!(probe_args("h264_amf", SIZE, FPS).join(" "),
            "-hide_banner -loglevel error -f lavfi -i color=black:s=1920x1080:r=30 -frames:v 1 -pix_fmt nv12 -c:v h264_amf -usage lowlatency -profile:v constrained_baseline -f null -");
    }

    #[test]
    fn devices_and_escape() {
        let out = "[in#0 @ 0000] \"OsmoPocket4\" (video)\n[in#0 @ 0000]   Alternative name \"@device_pnp_x\"\n[in#0 @ 0000] \"Capture Input terminal (OsmoPocket4)\" (audio)\r\n";
        assert_eq!(parse_devices(out), (vec!["OsmoPocket4".into()], vec!["Capture Input terminal (OsmoPocket4)".into()]));
        assert_eq!(escape("12 4/é"), "12%204%2F%C3%A9");
    }
}
