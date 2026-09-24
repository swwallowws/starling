//! Ensure ui-dist/ exists so include_dir! compiles before `npm run build`.
use std::{fs, path::Path};

const FALLBACK: &str = "<!doctype html><meta charset=utf-8><title>voxmpe</title>\
<p>The studio UI is not built yet. Run <code>npm install &amp;&amp; npm run build</code> \
in <code>studio-ui/</code>, then rebuild voxmpe.</p>";

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("ui-dist");
    if !dir.join("index.html").exists() {
        fs::create_dir_all(&dir).expect("create ui-dist");
        fs::write(dir.join("index.html"), FALLBACK).expect("write fallback index.html");
    }
    println!("cargo:rerun-if-changed=ui-dist");
}
