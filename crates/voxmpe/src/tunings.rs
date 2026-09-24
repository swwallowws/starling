//! Built-in tunings, so common microtonal scales work without finding a `.scl`.
//! Each is generated as Scala `.scl` text and goes through the same parser as a
//! loaded file. `id` is what `--tuning` accepts and what the studio stores.

/// One built-in tuning.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Preset {
    pub id: &'static str,
    pub name: &'static str,
    pub scl: String,
}

const PURE_FIFTH: f64 = 701.955_000_865_387_4; // 1200 * log2(3/2)
const QUARTER_COMMA_FIFTH: f64 = 696.578_428_466_208_7; // 1200 * log2(5^(1/4))

/// All built-in tunings, in the order the studio lists them.
pub fn presets() -> Vec<Preset> {
    vec![
        preset(
            "53-edo",
            "Turkish makam, 53 commas (53-EDO)",
            edo(53, 1200.0),
            "2/1",
        ),
        preset(
            "aeu-24",
            "Turkish makam, Arel-Ezgi-Uzdilek 24",
            chain(PURE_FIFTH, -12, 11),
            "2/1",
        ),
        preset("24-edo", "Quarter tones (24-EDO)", edo(24, 1200.0), "2/1"),
        Preset {
            id: "just-12",
            name: "Just intonation (5-limit)",
            scl: scl_ratios(
                "just-12",
                "Just intonation, 5-limit, 12 tones",
                &[
                    "16/15", "9/8", "6/5", "5/4", "4/3", "45/32", "3/2", "8/5", "5/3", "9/5",
                    "15/8", "2/1",
                ],
            ),
        },
        preset(
            "pythagorean-12",
            "Pythagorean",
            chain(PURE_FIFTH, -5, 6),
            "2/1",
        ),
        preset(
            "meantone-12",
            "Quarter-comma meantone",
            chain(QUARTER_COMMA_FIFTH, -3, 8),
            "2/1",
        ),
        preset("19-edo", "19-EDO", edo(19, 1200.0), "2/1"),
        preset("31-edo", "31-EDO", edo(31, 1200.0), "2/1"),
        preset(
            "bohlen-pierce",
            "Bohlen-Pierce (repeats at the twelfth)",
            edo(13, 1200.0 * 3f64.log2()),
            "3/1",
        ),
    ]
}

fn preset(id: &'static str, name: &'static str, cents: Vec<f64>, period: &str) -> Preset {
    Preset {
        id,
        name,
        scl: scl_cents(id, name, &cents, period),
    }
}

/// Degrees of `n` equal steps of `period` cents, without 0 and the period.
fn edo(n: u32, period: f64) -> Vec<f64> {
    (1..n).map(|k| period * k as f64 / n as f64).collect()
}

/// A chain of fifths from `lo` to `hi` steps, folded into one octave, without 0.
fn chain(fifth: f64, lo: i32, hi: i32) -> Vec<f64> {
    let mut c: Vec<f64> = (lo..=hi)
        .map(|k| (k as f64 * fifth).rem_euclid(1200.0))
        .filter(|&c| c > 1e-6)
        .collect();
    c.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
    c
}

fn scl_cents(id: &str, desc: &str, cents: &[f64], period: &str) -> String {
    let mut s = format!("! {id}.scl\n{desc}\n {}\n", cents.len() + 1);
    for c in cents {
        s.push_str(&format!(" {c:.6}\n"));
    }
    s.push_str(&format!(" {period}\n"));
    s
}

fn scl_ratios(id: &str, desc: &str, ratios: &[&str]) -> String {
    let mut s = format!("! {id}.scl\n{desc}\n {}\n", ratios.len());
    for r in ratios {
        s.push_str(&format!(" {r}\n"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scala::Scale;

    fn degrees(id: &str) -> Vec<f64> {
        let p = presets()
            .into_iter()
            .find(|p| p.id == id)
            .unwrap_or_else(|| panic!("no {id}"));
        Scale::parse(&p.scl)
            .unwrap_or_else(|e| panic!("{id}: {e}"))
            .degrees
    }

    fn has(d: &[f64], cents: f64) -> bool {
        d.iter().any(|&c| (c - cents).abs() < 0.05)
    }

    #[test]
    fn every_preset_parses_with_the_expected_size() {
        for (id, n) in [
            ("24-edo", 24),
            ("53-edo", 53),
            ("aeu-24", 24),
            ("just-12", 12),
            ("pythagorean-12", 12),
            ("meantone-12", 12),
            ("19-edo", 19),
            ("31-edo", 31),
            ("bohlen-pierce", 13),
        ] {
            assert_eq!(degrees(id).len(), n, "{id}");
        }
    }

    #[test]
    fn scales_contain_their_defining_intervals() {
        assert!(has(&degrees("24-edo"), 350.0), "neutral third");
        assert!(has(&degrees("53-edo"), 22.642), "one Holdrian comma");
        let aeu = degrees("aeu-24");
        assert!(has(&aeu, 90.225) && has(&aeu, 113.685), "limma and apotome");
        assert!(has(&degrees("just-12"), 386.314), "pure major third 5/4");
        assert!(
            has(&degrees("pythagorean-12"), 407.820),
            "Pythagorean third 81/64"
        );
        assert!(has(&degrees("meantone-12"), 696.578), "quarter-comma fifth");
        assert!(has(&degrees("31-edo"), 387.097));
    }

    #[test]
    fn bohlen_pierce_repeats_at_the_twelfth() {
        let p = presets()
            .into_iter()
            .find(|p| p.id == "bohlen-pierce")
            .unwrap();
        let s = Scale::parse(&p.scl).unwrap();
        assert!((s.period - 1901.955).abs() < 0.01);
    }

    #[test]
    fn ids_are_unique_and_flag_safe() {
        let ps = presets();
        let mut ids: Vec<_> = ps.iter().map(|p| p.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), ps.len());
        assert!(ps.iter().all(|p| p
            .id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')));
    }
}
