// The engine this build talks to. Vite's web mode aliases this file to
// wasm-backend.ts; everything else (the local studio, tests) gets the server.
export { serverBackend as backend } from "./server-backend";
