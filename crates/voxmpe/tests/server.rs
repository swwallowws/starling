use std::io::{Cursor, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;

use voxmpe::server::{self, handle, State};

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("voxmpe_srv_{tag}_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

fn model() -> Option<voxmpe_core::CrepeModel> {
    std::path::Path::new(voxmpe::model::DEFAULT_MODEL)
        .exists()
        .then(|| voxmpe::model::load_model(None).unwrap())
}

fn wav(secs: f32, amp: f32) -> Vec<u8> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 44_100,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut cur = Cursor::new(Vec::new());
    {
        let mut w = hound::WavWriter::new(&mut cur, spec).unwrap();
        for i in 0..(secs * 44_100.0) as usize {
            let t = i as f32 / 44_100.0;
            w.write_sample(amp * (2.0 * std::f32::consts::PI * 440.0 * t).sin())
                .unwrap();
        }
        w.finalize().unwrap();
    }
    cur.into_inner()
}

fn json(r: &server::Reply) -> serde_json::Value {
    serde_json::from_slice(&r.body).unwrap()
}

#[test]
fn serves_the_ui_and_404s_unknown_paths() {
    let mut st = State::new(None, temp_dir("ui"));
    let r = handle(&mut st, "GET", "/", b"");
    assert_eq!(
        (r.status, r.content_type),
        (200, "text/html; charset=utf-8")
    );
    assert_eq!(handle(&mut st, "GET", "/nope", b"").status, 404);
}

#[test]
fn takes_lists_only_wavs() {
    let dir = temp_dir("list");
    std::fs::create_dir_all(&dir).unwrap();
    for f in ["b.wav", "a.wav", "notes.txt", "a_studio.mid"] {
        std::fs::write(dir.join(f), b"x").unwrap();
    }
    let mut st = State::new(None, dir);
    let r = handle(&mut st, "GET", "/api/takes", b"");
    assert_eq!(json(&r), serde_json::json!(["a.wav", "b.wav"]));
}

#[test]
fn opening_rejects_path_parts() {
    let dir = temp_dir("trav");
    std::fs::create_dir_all(&dir).unwrap();
    let mut st = State::new(None, dir);
    for name in [
        "../secret.wav",
        "sub/x.wav",
        "%2E%2E%2Fsecret.wav",
        ".hidden.wav",
        "x.txt",
    ] {
        let r = handle(&mut st, "POST", &format!("/api/load?name={name}"), b"");
        assert_eq!(r.status, 400, "{name}");
    }
}

#[test]
fn uploads_are_sanitized_unique_and_saved_before_analysis() {
    let dir = temp_dir("up");
    let mut st = State::new(None, dir.clone());
    let a = handle(&mut st, "POST", "/api/load?name=my%20take!", &wav(0.1, 0.3));
    let b = handle(&mut st, "POST", "/api/load?name=my%20take!", &wav(0.1, 0.3));
    // No model: analysis fails with 500, but the recording is kept.
    assert_eq!((a.status, b.status), (500, 500));
    assert!(dir.join("my-take.wav").exists());
    assert!(dir.join("my-take-2.wav").exists());
    let c = handle(
        &mut st,
        "POST",
        "/api/load?name=..%2F..%2Fevil",
        &wav(0.1, 0.3),
    );
    assert_eq!(c.status, 500);
    assert!(
        dir.join("evil.wav").exists(),
        "path parts are stripped, file stays in takes/"
    );
}

#[test]
fn render_needs_the_current_take() {
    let mut st = State::new(None, temp_dir("409"));
    let body = serde_json::json!({ "take_id": 1, "settings": {} }).to_string();
    assert_eq!(
        handle(&mut st, "POST", "/api/render", body.as_bytes()).status,
        409
    );
}

#[test]
fn full_flow_with_the_model() {
    let Some(m) = model() else {
        eprintln!("skipping: model not found");
        return;
    };
    let dir = temp_dir("flow").join("missing-subdir");
    let mut st = State::new(Some(m), dir.clone());
    let r = handle(&mut st, "POST", "/api/load?name=tone", &wav(1.0, 0.3));
    assert_eq!(r.status, 200);
    let id = json(&r)["take_id"].as_u64().unwrap();

    let stale = serde_json::json!({ "take_id": id + 1, "settings": {} }).to_string();
    assert_eq!(
        handle(&mut st, "POST", "/api/render", stale.as_bytes()).status,
        409
    );

    let bad = serde_json::json!({ "take_id": id, "settings": { "tuning_scl": "not a scale" } })
        .to_string();
    let r = handle(&mut st, "POST", "/api/render", bad.as_bytes());
    assert_eq!(r.status, 400);
    assert!(json(&r)["error"].as_str().unwrap().contains("tuning"));

    let ok = serde_json::json!({ "take_id": id, "settings": { "hold_ms": 150.0 } }).to_string();
    let r = handle(&mut st, "POST", "/api/render", ok.as_bytes());
    assert_eq!(r.status, 200);
    assert_eq!(json(&r)["flags"], "--hold-ms 150");

    let r = handle(&mut st, "POST", "/api/export", ok.as_bytes());
    assert_eq!(r.status, 200);
    assert!(
        dir.join("tone_studio.mid").exists(),
        "export creates takes/ if missing"
    );
    let served = handle(&mut st, "GET", "/api/exported.mid", b"");
    assert_eq!(
        served.body,
        std::fs::read(dir.join("tone_studio.mid")).unwrap()
    );

    assert_eq!(
        handle(&mut st, "GET", "/api/audio", b"").content_type,
        "audio/wav"
    );
}

#[test]
fn bind_skips_a_busy_port() {
    let busy = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = busy.local_addr().unwrap().port();
    let (_server, got) = server::bind(port).unwrap();
    assert!(got > port);
}

#[test]
fn answers_over_real_http() {
    let (srv, port) = server::bind(0).unwrap_or_else(|_| server::bind(47000).unwrap());
    let dir = temp_dir("http");
    std::thread::spawn(move || {
        let mut st = State::new(None, dir);
        server::serve(&srv, &mut st);
    });
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.write_all(
        format!("GET /api/takes HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n")
            .as_bytes(),
    )
    .unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    assert!(out.starts_with("HTTP/1.1 200"), "{out}");
    assert!(out.ends_with("[]"), "{out}");
}

#[test]
fn rejects_a_foreign_host_header() {
    let (srv, port) = server::bind(0).unwrap_or_else(|_| server::bind(47010).unwrap());
    let dir = temp_dir("http_forbidden");
    std::thread::spawn(move || {
        let mut st = State::new(None, dir);
        server::serve(&srv, &mut st);
    });
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.write_all(b"GET /api/takes HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n")
        .unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    assert!(out.starts_with("HTTP/1.1 403"), "{out}");
}

#[test]
fn allowed_checks_host_and_post_origin() {
    let port = 4000;
    // Good hosts, case-insensitive, no Origin.
    assert!(server::allowed("GET", Some("127.0.0.1:4000"), None, port));
    assert!(server::allowed("GET", Some("LOCALHOST:4000"), None, port));
    assert!(server::allowed("POST", Some("127.0.0.1:4000"), None, port));
    // Wrong host, wrong port, missing host.
    assert!(!server::allowed(
        "GET",
        Some("evil.example:4000"),
        None,
        port
    ));
    assert!(!server::allowed("GET", Some("127.0.0.1:4001"), None, port));
    assert!(!server::allowed("GET", None, None, port));
    // POST with a foreign Origin is rejected even with a good Host.
    assert!(!server::allowed(
        "POST",
        Some("127.0.0.1:4000"),
        Some("http://evil.example"),
        port
    ));
    // GET with a foreign Origin but a good Host is allowed (Origin only gates POST).
    assert!(server::allowed(
        "GET",
        Some("127.0.0.1:4000"),
        Some("http://evil.example"),
        port
    ));
    // POST with our own Origin, either host form, is allowed.
    assert!(server::allowed(
        "POST",
        Some("localhost:4000"),
        Some("http://localhost:4000"),
        port
    ));
}
