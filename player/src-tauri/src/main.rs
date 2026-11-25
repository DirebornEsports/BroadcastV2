// Direborn Cam: the player app. Finds the studio, checks the PIN, runs the ffmpeg sender (sender.rs).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod sender;

use serde_json::Value;
use std::io::Read;
use std::net::UdpSocket;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{ipc::Channel, AppHandle, Manager, State};

#[derive(Default)]
struct App {
    ffmpeg: Mutex<Option<PathBuf>>,
    encoder: Mutex<Option<&'static str>>,
    live: Mutex<Option<Arc<sender::Live>>>,
}

impl App {
    fn ffmpeg(&self) -> Result<PathBuf, String> {
        self.ffmpeg.lock().unwrap().clone().ok_or_else(|| "ffmpeg belum terpasang".into())
    }
    fn stop(&self) {
        if let Some(l) = self.live.lock().unwrap().take() {
            l.stop();
        }
    }
}

/// hidden dev option: DIREBORN_DEV=1 adds the ffmpeg test pattern / beep as camera "test" and mic "test"
fn dev() -> bool {
    std::env::var("DIREBORN_DEV").as_deref() == Ok("1")
}

#[tauri::command]
fn check_ffmpeg(app: State<App>) -> Option<String> {
    let p = sender::find_ffmpeg();
    *app.ffmpeg.lock().unwrap() = p.clone();
    p.map(|p| p.display().to_string())
}

/// winget install, output streamed to the window; true when winget succeeded
#[tauri::command(async)]
fn install_ffmpeg(out: Channel<String>) -> Result<bool, String> {
    let mut c = sender::command("winget")
        .args(["install", "-e", "--id", "Gyan.FFmpeg", "--accept-source-agreements", "--accept-package-agreements"])
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|e| format!("winget tidak bisa dijalankan: {e}"))?;
    let mut so = c.stdout.take().unwrap();
    let mut buf = [0u8; 4096];
    // winget draws progress with \r; send raw chunks, the window keeps the last state of each line
    while let Ok(n) = so.read(&mut buf) {
        if n == 0 {
            break;
        }
        let _ = out.send(String::from_utf8_lossy(&buf[..n]).into());
    }
    let mut err = String::new();
    let _ = c.stderr.take().unwrap().read_to_string(&mut err);
    if !err.is_empty() {
        let _ = out.send(err);
    }
    Ok(c.wait().map_err(|e| e.to_string())?.success())
}

#[derive(serde::Serialize)]
struct Devices {
    cameras: Vec<String>,
    mics: Vec<String>,
}

#[tauri::command(async)]
fn devices(app: State<App>) -> Result<Devices, String> {
    let o = sender::command(app.ffmpeg()?).args(["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"])
        .stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
    let (mut cameras, mut mics) = sender::parse_devices(&String::from_utf8_lossy(&o.stderr));
    if dev() {
        cameras.push("test".into());
        mics.push("test".into());
    }
    Ok(Devices { cameras, mics })
}

/// The encoder the sender will use (probed once, like kirim.ps1 does at start)
#[tauri::command(async)]
fn encoder(app: State<App>) -> Result<String, String> {
    if let Some(e) = *app.encoder.lock().unwrap() {
        return Ok(e.into());
    }
    let e = sender::probe_encoder(&app.ffmpeg()?).ok_or("Tidak ada encoder H.264 yang bisa dibuka")?;
    *app.encoder.lock().unwrap() = Some(e);
    Ok(e.into())
}

/// UDP broadcast "DIREBORN-CAM?" on 8789; a studio answers "DIREBORN-CAM <httpPort>". Returns "ip:port".
#[tauri::command(async)]
fn find_studio() -> Option<String> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.set_broadcast(true).ok()?;
    for to in ["255.255.255.255:8789", "127.0.0.1:8789"] {
        let _ = s.send_to(b"DIREBORN-CAM?", to);
    }
    let until = Instant::now() + Duration::from_millis(1500);
    let mut buf = [0u8; 64];
    while let Some(left) = until.checked_duration_since(Instant::now()).filter(|d| !d.is_zero()) {
        s.set_read_timeout(Some(left)).ok()?;
        match s.recv_from(&mut buf) {
            Ok((n, from)) => {
                let port = std::str::from_utf8(&buf[..n]).ok().and_then(|m| m.trim().strip_prefix("DIREBORN-CAM ")?.parse::<u16>().ok());
                if let Some(port) = port {
                    return Some(format!("{}:{port}", from.ip()));
                }
            }
            // Windows reports "port unreachable" from the 127.0.0.1 probe as a receive error: keep listening
            Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset => {}
            Err(_) => return None,
        }
    }
    None
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
fn start(app: State<App>, camera: String, mic: String, addr: String, pin: String, events: Channel<Value>, preview: Channel) -> Result<String, String> {
    app.stop();
    let enc = encoder(app.clone())?;
    // with a PIN the studio knows who this is, so the name never travels (kanji / emoji names broke the ffmpeg call)
    let url = format!("http://{addr}/whip/cam?pin={}", sender::escape(&pin));
    let live = Arc::new(sender::Live::default());
    let args = |mon| sender::send_args(&enc, &camera, &mic, &url, sender::KBPS, sender::SIZE, sender::FPS, mon);
    live.run(app.ffmpeg()?, args, events, preview).map_err(|e| e.to_string())?;
    *app.live.lock().unwrap() = Some(live);
    Ok(enc)
}

#[tauri::command(async)]
fn stop(app: State<App>) {
    app.stop();
}

fn config_file(h: &AppHandle) -> Result<PathBuf, String> {
    Ok(h.path().app_config_dir().map_err(|e| e.to_string())?.join("config.json"))
}

#[tauri::command]
fn load_config(h: AppHandle) -> String {
    config_file(&h).and_then(|f| std::fs::read_to_string(f).map_err(|e| e.to_string())).unwrap_or_else(|_| "{}".into())
}

#[tauri::command]
fn save_config(h: AppHandle, json: String) -> Result<(), String> {
    let f = config_file(&h)?;
    std::fs::create_dir_all(f.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(f, json).map_err(|e| e.to_string())
}

/// WebView2 would ask "allow camera?" itself; the app is ours, so allow camera and mic without a prompt.
#[cfg(windows)]
fn allow_media(w: &tauri::WebviewWindow) {
    let _ = w.with_webview(|wv| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        let mut token = Default::default();
        let _ = core.add_PermissionRequested(
            &webview2_com::PermissionRequestedEventHandler::create(Box::new(|_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                if kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA || kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                }
                Ok(())
            })),
            &mut token,
        );
    });
}

fn main() {
    tauri::Builder::default()
        .manage(App::default())
        .setup(|app| {
            #[cfg(windows)]
            allow_media(&app.get_webview_window("main").unwrap());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![check_ffmpeg, install_ffmpeg, devices, encoder, find_studio, start, stop, load_config, save_config])
        .build(tauri::generate_context!())
        .expect("error while building Direborn Cam")
        // closing the window ends the app: never leave ffmpeg.exe running behind it
        .run(|h, e| {
            if let tauri::RunEvent::Exit = e {
                h.state::<App>().stop();
            }
        });
}
