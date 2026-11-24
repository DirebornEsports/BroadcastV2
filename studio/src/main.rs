// studio-recv --bridge http://127.0.0.1:8787 --name Test --delay 10 --out "udp://127.0.0.1:5000?pkt_size=1316"
// stdin: `delay <seconds>` changes the delay at runtime. stdout: one status JSON line every 2 s.
use studio_recv::{Config, MAX_DELAY, run};

fn main() {
    let mut cfg = Config {
        bridge: "http://127.0.0.1:8787".into(),
        name: String::new(),
        delay: 10.0,
        out: "udp://127.0.0.1:5000?pkt_size=1316".into(),
    };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let v = args.next().unwrap_or_else(|| usage(&format!("{a} needs a value")));
        match a.as_str() {
            "--bridge" => cfg.bridge = v,
            "--name" => cfg.name = v,
            "--out" => cfg.out = v,
            "--delay" => cfg.delay = v.parse().unwrap_or_else(|_| usage("bad --delay")),
            _ => usage(&format!("unknown option {a}")),
        }
    }
    if cfg.name.is_empty() {
        usage("--name is required");
    }
    if !(0.0..=MAX_DELAY).contains(&cfg.delay) {
        usage("--delay must be 0..1020");
    }
    if let Err(e) = run(cfg) {
        eprintln!("studio-recv: {e}");
        std::process::exit(1);
    }
}

fn usage(msg: &str) -> ! {
    eprintln!("studio-recv: {msg}\nusage: studio-recv --name <cam> [--bridge URL] [--delay S] [--out URL]");
    std::process::exit(2);
}
