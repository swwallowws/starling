//! Scala `.scl` tuning import.
//!
//! A `.scl` defines INTERVALS, not absolute pitches. It becomes concrete only with
//! an anchor (see [`crate::pitch::cents_to_freq`]). Cents entries (with a `.`) and
//! ratio entries (`a/b` or a bare integer) collapse to one normalized cents path.
//!
//! Format recap: `!` lines are comments; first non-comment line is the description;
//! second is the note count; then `count` pitch lines. The LAST pitch is the period
//! (octave `2/1`, tritave `3/1`, …); degree 0 (`1/1` = 0 cents) is implicit.

use voxmpe_core::interval::ratio_to_cents;

/// Whether the tuning behaves like a harmonic *mode* (harmony in the degree layout)
/// or an *equal division* (needs ratio-target chords). Drives chord routing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScaleKind {
    Mode,
    EqualDivision,
}

/// How the kind was decided — surfaced so a misroute is visible, not silent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KindSource {
    Declared,
    Inferred,
}

/// A parsed Scala scale, normalized to cents.
#[derive(Debug, Clone)]
pub struct Scale {
    pub description: String,
    /// Degrees within one period, in cents, starting at 0.0 (the implicit 1/1).
    /// Length == the Scala note count.
    pub degrees: Vec<f64>,
    /// The period in cents (1200 for octave scales, ~1902 for a 3/1 tritave).
    pub period: f64,
    /// Declared kind from a `! kind: mode|edo` comment, if any.
    pub declared_kind: Option<ScaleKind>,
}

impl Scale {
    /// Parse one degree token: cents if it contains '.', else a ratio (`a/b` or int).
    fn parse_pitch(tok: &str) -> Result<f64, String> {
        let tok = tok.split_whitespace().next().unwrap_or("");
        if tok.contains('.') {
            tok.parse::<f64>().map_err(|e| format!("bad cents '{tok}': {e}"))
        } else if let Some((n, d)) = tok.split_once('/') {
            let n: f64 = n.parse().map_err(|e| format!("bad ratio num '{tok}': {e}"))?;
            let d: f64 = d.parse().map_err(|e| format!("bad ratio den '{tok}': {e}"))?;
            if d == 0.0 {
                return Err(format!("zero denominator in '{tok}'"));
            }
            Ok(ratio_to_cents(n / d))
        } else {
            let n: f64 = tok.parse().map_err(|e| format!("bad ratio '{tok}': {e}"))?;
            Ok(ratio_to_cents(n)) // bare integer k == k/1
        }
    }

    /// Parse the text of a `.scl` file.
    pub fn parse(text: &str) -> Result<Scale, String> {
        let mut declared_kind = None;
        let mut data = Vec::new(); // non-comment payload lines
        for raw in text.lines() {
            let line = raw.trim();
            if line.starts_with('!') {
                // Comment — but sniff a `! kind: mode|edo` override.
                let c = line.trim_start_matches('!').trim().to_ascii_lowercase();
                if let Some(v) = c.strip_prefix("kind:") {
                    declared_kind = match v.trim() {
                        "mode" => Some(ScaleKind::Mode),
                        "edo" | "et" | "equal" => Some(ScaleKind::EqualDivision),
                        other => return Err(format!("unknown kind '{other}'")),
                    };
                }
                continue;
            }
            data.push(line);
        }
        if data.len() < 2 {
            return Err("scl needs a description line and a note count".into());
        }
        let description = data[0].to_string();
        let count: usize = data[1]
            .split_whitespace()
            .next()
            .unwrap_or("")
            .parse()
            .map_err(|e| format!("bad note count '{}': {e}", data[1]))?;
        let pitches = &data[2..];
        if pitches.len() < count {
            return Err(format!("declared {count} notes, found {}", pitches.len()));
        }
        let entries: Vec<f64> = pitches[..count]
            .iter()
            .map(|l| Scale::parse_pitch(l))
            .collect::<Result<_, _>>()?;
        let (period, period_slice) = entries
            .split_last()
            .ok_or("scale has no pitches")?;
        // Degrees within a period: implicit 0.0 plus every entry except the period.
        let mut degrees = Vec::with_capacity(count);
        degrees.push(0.0);
        degrees.extend_from_slice(period_slice);
        Ok(Scale {
            description,
            degrees,
            period: *period,
            declared_kind,
        })
    }

    /// Classify this scale, honoring a declared kind before inferring. Returns the
    /// kind AND how it was decided so callers can log the routing decision.
    pub fn classify(&self) -> (ScaleKind, KindSource) {
        if let Some(k) = self.declared_kind {
            return (k, KindSource::Declared);
        }
        (self.infer_kind(), KindSource::Inferred)
    }

    /// Heuristic: near-uniform steps AND cardinality >= 12 => equal division.
    fn infer_kind(&self) -> ScaleKind {
        let n = self.degrees.len();
        if n < 12 {
            return ScaleKind::Mode;
        }
        // Steps between successive degrees, plus the wrap step back to the period.
        let mut steps: Vec<f64> = self
            .degrees
            .windows(2)
            .map(|w| w[1] - w[0])
            .collect();
        steps.push(self.period - self.degrees[n - 1]);
        let max = steps.iter().cloned().fold(f64::MIN, f64::max);
        let min = steps.iter().cloned().fold(f64::MAX, f64::min);
        if min > 0.0 && max / min < 1.1 {
            ScaleKind::EqualDivision
        } else {
            ScaleKind::Mode
        }
    }
}
