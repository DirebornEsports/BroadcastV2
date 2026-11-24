// Direborn Studio: the operator app. Checks Node.js + ffmpeg (ui/index.html), runs the v1 hub and the cam bridge
// as hidden child processes, then shows the hub's control panel. Closing the window stops both, whole trees.
//   env (testing): DIREBORN_HUB_PORT (8080), DIREBORN_BRIDGE_PORT (8787), DIREBORN_DATA (%APPDATA%\Direborn Studio\data),
//                  DIREBORN_FAKE_MISSING=node,ffmpeg (pretend they are not installed)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{ipc::Channel, AppHandle, Manager, RunEvent, State, Url};

const NO_WINDOW: u32 = 0x0800_0000; // CREATE_NO_WINDOW

struct Studio {
    hub_port: u16,
    bridge_port: u16,
    data: PathBuf,
    kids: Mutex<Vec<(&'static str, Child)>>,
    error: Mutex<Option<Fail>>,
    gen: AtomicU64, // bumped on every stop: an old watcher thread sees it and quits
    home: Mutex<Option<Url>>,
}

#[derive(Serialize, Clone)]
struct Fail {
    msg: String,
    log: String,
}
fn fail(msg: impl Into<String>) -> Fail {
    Fail { msg: msg.into(), log: String::new() }
}

fn env_port(var: &str, def: u16) -> u16 {
    std::env::var(var).ok().and_then(|v| v.parse().ok()).unwrap_or(def)
}

/// exe on PATH, else where winget / the Node installer put it (this process' PATH is from before an install)
fn find(exe: &str, extra: &[PathBuf]) -> Option<PathBuf> {
    let name = exe.trim_end_matches(".exe");
    if std::env::var("DIREBORN_FAKE_MISSING").is_ok_and(|v| v.split(',').any(|x| x.trim() == name)) {
        return None;
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path).map(|d| d.join(exe)).chain(extra.iter().cloned()).find(|p| p.is_file())
}
fn local_appdata(rel: &str) -> Vec<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join(rel)).into_iter().collect()
}
fn node() -> Option<PathBuf> {
    find("node.exe", &[PathBuf::from(r"C:\Program Files\nodejs\node.exe")])
}
fn ffmpeg() -> Option<PathBuf> {
    find("ffmpeg.exe", &local_appdata(r"Microsoft\WinGet\Links\ffmpeg.exe"))
}

#[derive(Serialize)]
struct Check {
    node: Option<PathBuf>,
    ffmpeg: Option<PathBuf>,
    winget: bool,
}

#[tauri::command]
fn check() -> Check {
    Check { node: node(), ffmpeg: ffmpeg(), winget: find("winget.exe", &local_appdata(r"Microsoft\WindowsApps\winget.exe")).is_some() }
}

/// winget install, its output line by line into `out`
#[tauri::command(async)]
fn install(what: String, out: Channel<String>) -> Result<(), String> {
    let id = match what.as_str() {
        "node" => "OpenJS.NodeJS.LTS",
        "ffmpeg" => "Gyan.FFmpeg",
        _ => return Err("tidak dikenal".into()),
    };
    let winget = find("winget.exe", &local_appdata(r"Microsoft\WindowsApps\winget.exe")).ok_or("winget tidak ada di PC ini")?;
    let _ = out.send(format!("> winget install -e --id {id}"));
    let mut c = Command::new(winget)
        .args(["install", "-e", "--id", id, "--accept-source-agreements", "--accept-package-agreements"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(NO_WINDOW)
        .spawn()
        .map_err(|e| format!("winget gagal jalan: {e}"))?;
    let err = c.stderr.take().unwrap();
    let out2 = out.clone();
    let t = std::thread::spawn(move || pump(err, &out2));
    pump(c.stdout.take().unwrap(), &out);
    let _ = t.join();
    let s = c.wait().map_err(|e| e.to_string())?;
    if s.success() { Ok(()) } else { Err(format!("winget selesai dengan kode {}", s.code().unwrap_or(-1))) }
}

fn pump(mut r: impl Read, out: &Channel<String>) {
    let (mut buf, mut line) = ([0u8; 4096], Vec::new());
    let flush = |line: &mut Vec<u8>| {
        let s = String::from_utf8_lossy(line).trim().to_string();
        line.clear();
        // skip winget's spinner (- \ | /) and redrawn progress bars
        if s.chars().count() > 1 && !s.contains('█') && !s.contains('▒') {
            let _ = out.send(s);
        }
    };
    while let Ok(n) = r.read(&mut buf) {
        if n == 0 {
            break;
        }
        for &b in &buf[..n] {
            if b == b'\n' || b == b'\r' { flush(&mut line) } else { line.push(b) }
        }
    }
    flush(&mut line);
}

#[tauri::command]
fn last_error(win: tauri::WebviewWindow, st: State<Studio>) -> Option<Fail> {
    // the local page's own URL (at setup the window is still about:blank): where to go back to when a child dies
    *st.home.lock().unwrap() = win.url().ok();
    st.error.lock().unwrap().take()
}

/// start hub + bridge, wait until both answer, then open the control panel in the main window
#[tauri::command(async)]
fn start(app: AppHandle, st: State<Studio>) -> Result<(), Fail> {
    stop(&st);
    let r = launch(&app, &st);
    if r.is_err() {
        stop(&st);
    }
    r
}

fn launch(app: &AppHandle, st: &Studio) -> Result<(), Fail> {
    let node = node().ok_or_else(|| fail("Node.js tidak ketemu."))?;
    let ff = ffmpeg().ok_or_else(|| fail("ffmpeg tidak ketemu."))?;
    for (p, what) in [(st.hub_port, "hub"), (st.bridge_port, "bridge kamera")] {
        if TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], p)), Duration::from_millis(300)).is_ok() {
            return Err(fail(format!(
                "Port {p} ({what}) sudah dipakai program lain. Mungkin Direborn Studio atau hub/bridge lama masih jalan? Tutup dulu, lalu Coba lagi."
            )));
        }
    }
    let res = resources(app);
    let recv = Some(res.join("studio-recv.exe")).filter(|p| p.is_file()).unwrap_or_else(|| res.join(r"studio\target\release\studio-recv.exe"));
    fs::create_dir_all(&st.data).map_err(|e| fail(format!("Folder data {} tidak bisa dibuat: {e}", st.data.display())))?;
    // ffmpeg + node first on PATH: studio-recv (grandchild) runs "ffmpeg" by name
    let old = std::env::var_os("PATH").unwrap_or_default();
    let path = std::env::join_paths([ff.parent(), node.parent()].into_iter().flatten().map(Path::to_path_buf).chain(std::env::split_paths(&old)))
        .unwrap_or(old);
    let d = |sub: &str| st.data.join(sub).to_string_lossy().into_owned();
    run_node(st, "hub", &node, &res.join("hub"), "dev/local.mjs", &path, &[
        ("PORT", st.hub_port.to_string()),
        ("LOCAL_ADMIN", "1".into()),
        ("DEV_DATA", d("hub")),
    ])?;
    run_node(st, "bridge", &node, &res, r"bridge\server.mjs", &path, &[
        ("PORT", st.bridge_port.to_string()),
        ("STUDIO", "1".into()),
        ("STUDIO_DATA", d("studio")),
        ("HUB_URL", format!("http://127.0.0.1:{}", st.hub_port)),
        ("RECV_EXE", recv.to_string_lossy().into_owned()),
    ])?;

    let t0 = Instant::now();
    while !(http_ok(st.hub_port, "/api/state") && http_ok(st.bridge_port, "/studio/state")) {
        if let Some(f) = died(st) {
            return Err(f);
        }
        if t0.elapsed() > Duration::from_secs(60) {
            return Err(Fail { msg: "Hub / bridge kamera belum jawab setelah 60 detik.".into(), log: tails(st) });
        }
        std::thread::sleep(Duration::from_millis(300));
    }

    // a child that dies later: back to the local page, which shows the error + log
    let gen = st.gen.load(Ordering::SeqCst);
    let a = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let st = a.state::<Studio>();
        if st.gen.load(Ordering::SeqCst) != gen {
            break;
        }
        if let Some(f) = died(&st) {
            stop(&st);
            *st.error.lock().unwrap() = Some(f);
            if let (Some(w), Some(u)) = (a.get_webview_window("main"), st.home.lock().unwrap().clone()) {
                let _ = w.navigate(u);
            }
            break;
        }
    });
    let w = app.get_webview_window("main").ok_or_else(|| fail("window hilang"))?;
    w.navigate(Url::parse(&format!("http://localhost:{}/control", st.hub_port)).unwrap()).map_err(|e| fail(e.to_string()))
}

/// installed: <resource dir>\res (hub\, bridge\, studio-recv.exe); dev run: straight from the repo
fn resources(app: &AppHandle) -> PathBuf {
    if let Ok(d) = app.path().resource_dir() {
        let r = d.join("res");
        if r.join("hub").is_dir() {
            return r;
        }
    }
    Path::new(env!("CARGO_MANIFEST_DIR")).join(r"..\..")
}

fn run_node(st: &Studio, name: &'static str, node: &Path, cwd: &Path, script: &str, path: &OsString, env: &[(&str, String)]) -> Result<(), Fail> {
    let log = File::create(st.data.join(format!("{name}.log"))).map_err(|e| fail(format!("Log {name} tidak bisa dibuat: {e}")))?;
    let log2 = log.try_clone().map_err(|e| fail(e.to_string()))?;
    let c = Command::new(node)
        .arg(script)
        .current_dir(cwd)
        .env("PATH", path)
        .envs(env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(log2)
        .creation_flags(NO_WINDOW)
        .spawn()
        .map_err(|e| fail(format!("{name} gagal jalan: {e}")))?;
    st.kids.lock().unwrap().push((name, c));
    Ok(())
}

fn http_ok(port: u16, path: &str) -> bool {
    let Ok(mut s) = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(500)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
    let mut b = [0u8; 12];
    write!(s, "GET {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n").is_ok() && s.read_exact(&mut b).is_ok() && b.starts_with(b"HTTP/1.") && &b[9..12] == b"200"
}

fn died(st: &Studio) -> Option<Fail> {
    let mut kids = st.kids.lock().unwrap();
    let (name, code) = kids.iter_mut().find_map(|(n, c)| c.try_wait().ok().flatten().map(|s| (*n, s.code().unwrap_or(-1))))?;
    drop(kids);
    let what = if name == "hub" { "Hub" } else { "Bridge kamera" };
    Some(Fail { msg: format!("{what} berhenti sendiri (kode {code})."), log: tails(st) })
}

fn tails(st: &Studio) -> String {
    ["hub", "bridge"]
        .iter()
        .map(|n| {
            let f = st.data.join(format!("{n}.log"));
            let t = fs::read_to_string(&f).unwrap_or_default();
            let lines: Vec<&str> = t.lines().collect();
            format!("== {} ==\n{}\n", f.display(), lines[lines.len().saturating_sub(25)..].join("\n"))
        })
        .collect()
}

/// kill both children with their whole trees (the bridge's studio-recv receivers and their ffmpeg are grandchildren)
fn stop(st: &Studio) {
    st.gen.fetch_add(1, Ordering::SeqCst);
    for (_, mut c) in std::mem::take(&mut *st.kids.lock().unwrap()) {
        let _ = Command::new("taskkill").args(["/PID", &c.id().to_string(), "/T", "/F"]).creation_flags(NO_WINDOW).output();
        let _ = c.kill();
        let _ = c.wait();
    }
}

fn main() {
    let data = std::env::var_os("DIREBORN_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default()).join(r"Direborn Studio\data"));
    let app = tauri::Builder::default()
        .manage(Studio {
            hub_port: env_port("DIREBORN_HUB_PORT", 8080),
            bridge_port: env_port("DIREBORN_BRIDGE_PORT", 8787),
            data,
            kids: Mutex::new(Vec::new()),
            error: Mutex::new(None),
            gen: AtomicU64::new(0),
            home: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![check, install, start, last_error])
        .build(tauri::generate_context!())
        .expect("Direborn Studio gagal start");
    // shortcut: if this process is force-killed, the children survive (next start reports the port in use); a Job Object would fix that.
    app.run(|app, ev| {
        if let RunEvent::Exit = ev {
            stop(&app.state::<Studio>());
        }
    });
}
