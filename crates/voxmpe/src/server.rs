//! The studio's local server: a pure `handle()` plus a thin tiny_http loop.

use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{bail, Result};
use include_dir::{include_dir, Dir};
use serde::Deserialize;
use voxmpe_core::CrepeModel;

use crate::session::Session;
use crate::settings::Settings;

static UI: Dir = include_dir!("$CARGO_MANIFEST_DIR/ui-dist");

pub struct State {
    pub model: Option<CrepeModel>,
    pub takes_dir: PathBuf,
    pub session: Option<Session>,
    pub take_id: u64,
    pub last_export: Option<PathBuf>,
}

pub struct Reply {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
    pub headers: Vec<(&'static str, String)>,
}

#[derive(Deserialize)]
struct WithSettings {
    take_id: u64,
    #[serde(default)]
    settings: Settings,
}

impl State {
    pub fn new(model: Option<CrepeModel>, takes_dir: PathBuf) -> State {
        State {
            model,
            takes_dir,
            session: None,
            take_id: 0,
            last_export: None,
        }
    }

    /// Open a take given on the command line (trusted path, may be outside takes/).
    pub fn preload(&mut self, path: &Path) -> Result<()> {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        self.open(&name, std::fs::read(path)?)
    }

    fn open(&mut self, name: &str, wav: Vec<u8>) -> Result<()> {
        let Some(model) = &self.model else {
            bail!("the CREPE model is not loaded")
        };
        self.session = Some(Session::load(name, wav, model)?);
        self.take_id += 1;
        Ok(())
    }
}

fn reply(status: u16, content_type: &'static str, body: Vec<u8>) -> Reply {
    Reply {
        status,
        content_type,
        body,
        headers: vec![],
    }
}

fn ok_json(v: impl serde::Serialize) -> Reply {
    reply(
        200,
        "application/json",
        serde_json::to_vec(&v).unwrap_or_default(),
    )
}

fn err(status: u16, msg: impl std::fmt::Display) -> Reply {
    reply(
        status,
        "application/json",
        serde_json::json!({ "error": msg.to_string() })
            .to_string()
            .into_bytes(),
    )
}

/// A take file name: letters, digits, '-', '_', one ".wav", no path parts.
fn valid_take_file(name: &str) -> bool {
    name.len() <= 100
        && !name.starts_with('.')
        && name.ends_with(".wav")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}

/// Turn any requested name into a safe file stem.
fn sanitize_stem(raw: &str) -> String {
    let base = raw
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim_end_matches(".wav");
    let s: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let s = s
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if s.is_empty() {
        "take".into()
    } else {
        s.chars().take(60).collect()
    }
}

/// Create a new, never-before-seen `<stem>[-N].wav` in `dir` and write `body` into it.
/// Uses `create_new` so two concurrent uploads can never clobber each other or an
/// existing take: a name collision retries the next `-N` instead of overwriting.
fn save_new_wav(dir: &Path, stem: &str, body: &[u8]) -> std::io::Result<PathBuf> {
    let mut p = dir.join(format!("{stem}.wav"));
    let mut n = 2;
    loop {
        match OpenOptions::new().write(true).create_new(true).open(&p) {
            Ok(mut f) => {
                f.write_all(body)?;
                return Ok(p);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                p = dir.join(format!("{stem}-{n}.wav"));
                n += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

/// Decode `%XX` escapes and `+` in a query value (byte-wise, so any input is safe).
fn percent_decode(s: &str) -> String {
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 3 <= b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query_param(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        (k == key).then(|| percent_decode(v))
    })
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript",
        Some("css") => "text/css",
        Some("svg") => "image/svg+xml",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
}

pub fn handle(state: &mut State, method: &str, url: &str, body: &[u8]) -> Reply {
    let path = url.split('?').next().unwrap_or("/");
    match (method, path) {
        ("GET", "/api/takes") => {
            let _ = std::fs::create_dir_all(&state.takes_dir);
            let mut names: Vec<String> = std::fs::read_dir(&state.takes_dir)
                .map(|rd| {
                    rd.filter_map(|e| e.ok())
                        .map(|e| e.file_name().to_string_lossy().into_owned())
                        .filter(|n| valid_take_file(n))
                        .collect()
                })
                .unwrap_or_default();
            names.sort();
            ok_json(names)
        }
        ("POST", "/api/load") => {
            let requested = query_param(url, "name").unwrap_or_default();
            let (name, wav) = if body.is_empty() {
                if !valid_take_file(&requested) {
                    return err(400, format!("not a take name: {requested}"));
                }
                match std::fs::read(state.takes_dir.join(&requested)) {
                    Ok(w) => (requested, w),
                    Err(e) => return err(404, format!("{requested}: {e}")),
                }
            } else {
                if let Err(e) = std::fs::create_dir_all(&state.takes_dir) {
                    return err(500, e);
                }
                let path = match save_new_wav(&state.takes_dir, &sanitize_stem(&requested), body) {
                    Ok(p) => p,
                    Err(e) => return err(500, e),
                };
                (
                    path.file_name().unwrap().to_string_lossy().into_owned(),
                    body.to_vec(),
                )
            };
            match state.open(&name, wav) {
                Ok(()) => ok_json(serde_json::json!({
                    "take_id": state.take_id,
                    "info": state.session.as_ref().map(|s| s.info()),
                })),
                Err(e) => err(
                    500,
                    format!("{name} was saved but could not be analyzed: {e}"),
                ),
            }
        }
        ("POST", "/api/render") | ("POST", "/api/export") => {
            let req: WithSettings = match serde_json::from_slice(body) {
                Ok(r) => r,
                Err(e) => return err(400, e),
            };
            let Some(session) = state
                .session
                .as_ref()
                .filter(|_| req.take_id == state.take_id)
            else {
                return err(409, "that take is no longer open");
            };
            if let Err(e) = req.settings.tuning() {
                return err(400, format!("tuning: {e}"));
            }
            if path == "/api/render" {
                return match session.render(&req.settings) {
                    Ok(r) => ok_json(r),
                    Err(e) => err(400, e),
                };
            }
            let bytes = match session.export_mid(&req.settings) {
                Ok(b) => b,
                Err(e) => return err(400, e),
            };
            let stem = session.name.trim_end_matches(".wav").to_string();
            if let Err(e) = std::fs::create_dir_all(&state.takes_dir) {
                return err(500, e);
            }
            let out = state.takes_dir.join(format!("{stem}_studio.mid"));
            if let Err(e) = std::fs::write(&out, bytes) {
                return err(500, e);
            }
            let file_name = out.file_name().unwrap().to_string_lossy().into_owned();
            let full = std::fs::canonicalize(&out).unwrap_or(out.clone());
            state.last_export = Some(full.clone());
            ok_json(
                serde_json::json!({ "path": full.display().to_string(), "file_name": file_name }),
            )
        }
        ("GET", "/api/current") => match &state.session {
            Some(s) => ok_json(serde_json::json!({ "take_id": state.take_id, "info": s.info() })),
            None => reply(204, "application/json", vec![]),
        },
        ("GET", "/api/audio") => match &state.session {
            Some(s) => reply(200, "audio/wav", s.wav.clone()),
            None => err(409, "no take is open"),
        },
        ("GET", "/api/exported.mid") => match state
            .last_export
            .as_ref()
            .and_then(|p| std::fs::read(p).ok().map(|b| (p, b)))
        {
            Some((p, b)) => {
                let mut r = reply(200, "audio/midi", b);
                let name = p.file_name().unwrap().to_string_lossy().into_owned();
                r.headers.push((
                    "Content-Disposition",
                    format!("attachment; filename=\"{name}\""),
                ));
                r
            }
            None => err(404, "nothing exported yet"),
        },
        ("POST", "/api/reveal") => match &state.last_export {
            Some(p) => {
                let _ = std::process::Command::new("open").arg("-R").arg(p).spawn();
                ok_json(serde_json::json!({}))
            }
            None => err(404, "nothing exported yet"),
        },
        ("GET", p) => {
            let file = if p == "/" {
                "index.html"
            } else {
                p.trim_start_matches('/')
            };
            match UI.get_file(file) {
                Some(f) => reply(200, content_type(file), f.contents().to_vec()),
                None => err(404, format!("not found: {p}")),
            }
        }
        _ => err(404, format!("not found: {method} {path}")),
    }
}

/// Bind to 127.0.0.1 on `start_port`, or the next free port among 20. Port 0 = any.
pub fn bind(start_port: u16) -> Result<(tiny_http::Server, u16)> {
    let tries = if start_port == 0 { 1 } else { 20 };
    for port in (0..tries).map(|i| start_port.saturating_add(i)) {
        if let Ok(s) = tiny_http::Server::http(("127.0.0.1", port)) {
            let actual = s.server_addr().to_ip().map(|a| a.port()).unwrap_or(port);
            return Ok((s, actual));
        }
    }
    bail!(
        "no free port from {start_port} to {}",
        start_port.saturating_add(19)
    )
}

/// Reject bodies larger than this before they ever reach `handle`.
const MAX_BODY: u64 = 256 * 1024 * 1024;

/// Does this request's `Host` (and, for POST, `Origin`) header match this server's
/// own origin? Blocks cross-origin POSTs from another page (CSRF: uploading into
/// takes/, triggering /api/reveal, overwriting an export) and DNS-rebinding reads
/// of responses such as /api/audio, without touching any other request handling.
pub fn allowed(method: &str, host: Option<&str>, origin: Option<&str>, port: u16) -> bool {
    let is_own = |h: &str| {
        let h = h.to_ascii_lowercase();
        h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}")
    };
    let Some(host) = host else { return false };
    if !is_own(host) {
        return false;
    }
    if method.eq_ignore_ascii_case("POST") {
        if let Some(origin) = origin {
            let origin = origin.to_ascii_lowercase();
            let ok = origin == format!("http://127.0.0.1:{port}")
                || origin == format!("http://localhost:{port}");
            if !ok {
                return false;
            }
        }
    }
    true
}

fn header_value<'a>(headers: &'a [tiny_http::Header], name: &'static str) -> Option<&'a str> {
    headers
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str())
}

fn respond(req: tiny_http::Request, r: Reply) {
    let mut resp = tiny_http::Response::from_data(r.body).with_status_code(r.status);
    if let Ok(h) = tiny_http::Header::from_bytes("Content-Type", r.content_type) {
        resp.add_header(h);
    }
    for (k, v) in r.headers {
        if let Ok(h) = tiny_http::Header::from_bytes(k, v.as_bytes()) {
            resp.add_header(h);
        }
    }
    let _ = req.respond(resp);
}

/// Answer requests one at a time until the process exits.
pub fn serve(server: &tiny_http::Server, state: &mut State) {
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
    for mut req in server.incoming_requests() {
        let method = req.method().as_str().to_owned();
        let host = header_value(req.headers(), "Host").map(str::to_owned);
        let origin = header_value(req.headers(), "Origin").map(str::to_owned);
        if !allowed(&method, host.as_deref(), origin.as_deref(), port) {
            respond(req, err(403, "forbidden: wrong host or origin"));
            continue;
        }

        let mut body = Vec::new();
        let read = req.as_reader().take(MAX_BODY + 1).read_to_end(&mut body);
        if read.is_err() || body.len() as u64 > MAX_BODY {
            respond(req, err(413, "request body too large"));
            continue;
        }

        let url = req.url().to_owned();
        let r = handle(state, &method, &url, &body);
        respond(req, r);
    }
}
