//! voxmpe in the browser. [`engine`] is plain Rust, tested natively; on wasm32
//! the `bindings` module exposes it to the pitch and studio Web Workers.

mod engine;

pub use engine::*;

#[cfg(target_arch = "wasm32")]
mod bindings {
    use wasm_bindgen::prelude::*;

    use crate::engine::{tunings_json, Engine, Pitch};

    fn js(e: anyhow::Error) -> JsError {
        JsError::new(&format!("{e:#}"))
    }

    fn idle() -> JsError {
        JsError::new("no take is being analyzed")
    }

    /// CREPE tiny for one pitch worker.
    #[wasm_bindgen]
    pub struct PitchWorker(Pitch);

    #[wasm_bindgen]
    impl PitchWorker {
        #[wasm_bindgen(constructor)]
        pub fn new(model: &[u8]) -> Result<PitchWorker, JsError> {
            Pitch::new(model).map(PitchWorker).map_err(js)
        }

        pub fn run(&self, audio16: &[f32], indices: &[u32]) -> Result<Vec<f32>, JsError> {
            self.0.run(audio16, indices).map_err(js)
        }
    }

    /// The open take, for the studio worker.
    #[wasm_bindgen]
    pub struct Studio(Engine);

    #[wasm_bindgen]
    impl Studio {
        #[allow(clippy::new_without_default)]
        #[wasm_bindgen(constructor)]
        pub fn new() -> Studio {
            Studio(Engine::new())
        }

        /// Decode and prepare a take; then read `audio16()` and `active()`.
        pub fn load(&mut self, name: &str, wav: Vec<u8>) -> Result<(), JsError> {
            self.0.load(name, wav).map(|_| ()).map_err(js)
        }

        pub fn audio16(&self) -> Result<Vec<f32>, JsError> {
            self.0
                .prepared()
                .map(|p| p.audio16.clone())
                .ok_or_else(idle)
        }

        pub fn active(&self) -> Result<Vec<u32>, JsError> {
            self.0.prepared().map(|p| p.active.clone()).ok_or_else(idle)
        }

        pub fn finish(&mut self, results: &[f32]) -> Result<String, JsError> {
            self.0.finish(results).map_err(js)
        }

        pub fn restore(
            &mut self,
            name: &str,
            wav: Vec<u8>,
            frames: &[f32],
        ) -> Result<String, JsError> {
            self.0.restore(name, wav, frames).map_err(js)
        }

        pub fn frames(&self) -> Result<Vec<f32>, JsError> {
            self.0.frames().map_err(js)
        }

        pub fn render(&self, settings: &str) -> Result<String, JsError> {
            self.0.render(settings).map_err(js)
        }

        pub fn export(&self, settings: &str, format: &str) -> Result<Vec<u8>, JsError> {
            self.0.export(settings, format).map_err(js)
        }
    }

    #[wasm_bindgen]
    pub fn tunings() -> String {
        tunings_json()
    }
}
