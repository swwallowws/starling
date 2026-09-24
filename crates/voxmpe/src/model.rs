//! Locating and loading the CREPE model.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use voxmpe_core::CrepeModel;

/// Where the model lives in a repo checkout (see models/README.md).
pub const DEFAULT_MODEL: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../../models/crepe-full.onnx");

/// Load CREPE from `path`, else `$VOXMPE_MODEL`, else [`DEFAULT_MODEL`].
pub fn load_model(path: Option<&Path>) -> Result<CrepeModel> {
    let p: PathBuf = match path {
        Some(p) => p.to_path_buf(),
        None => std::env::var_os("VOXMPE_MODEL")
            .map(PathBuf::from)
            .unwrap_or_else(|| DEFAULT_MODEL.into()),
    };
    if !p.exists() {
        bail!(
            "CREPE model not found at {}. See models/README.md for how to get it.",
            p.display()
        );
    }
    CrepeModel::from_path(&p.to_string_lossy()).with_context(|| format!("loading {}", p.display()))
}
