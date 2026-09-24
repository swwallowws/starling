use std::io::Cursor;
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_voxmpe");

#[test]
fn help_lists_convert() {
    let out = Command::new(BIN).arg("--help").output().unwrap();
    assert!(String::from_utf8_lossy(&out.stdout).contains("convert"));
}

#[test]
fn missing_model_points_to_the_readme() {
    let out = Command::new(BIN)
        .args(["convert", "in.wav", "--model", "/nonexistent/crepe.onnx"])
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("models/README.md"));
}

#[test]
fn convert_writes_a_midi_file() {
    if !std::path::Path::new(voxmpe::model::DEFAULT_MODEL).exists() {
        eprintln!("skipping: model not found");
        return;
    }
    let dir = std::env::temp_dir().join(format!("voxmpe_cli_{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let input = dir.join("in.wav");
    let output = dir.join("out.mid");
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 44_100,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cur = Cursor::new(Vec::new());
    {
        let mut w = hound::WavWriter::new(&mut cur, spec).unwrap();
        for i in 0..44_100 {
            let t = i as f32 / 44_100.0;
            w.write_sample((0.3 * (2.0 * std::f32::consts::PI * 440.0 * t).sin() * 32767.0) as i16)
                .unwrap();
        }
        w.finalize().unwrap();
    }
    std::fs::write(&input, cur.into_inner()).unwrap();
    let st = Command::new(BIN)
        .args([
            "convert",
            input.to_str().unwrap(),
            "-o",
            output.to_str().unwrap(),
            "--legato",
        ])
        .status()
        .unwrap();
    assert!(st.success());
    assert!(midly::Smf::parse(&std::fs::read(&output).unwrap()).is_ok());
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn studio_has_help() {
    let out = Command::new(BIN)
        .args(["studio", "--help"])
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(
        text.contains("--port") && text.contains("--no-open"),
        "{text}"
    );
}
