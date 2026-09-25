// Test audio for the scripts: a 16-bit mono WAV writer and a sung-like phrase.

/** 16-bit PCM mono WAV bytes. */
export function wav16(samples, sr) {
  const data = samples.length * 2;
  const b = new DataView(new ArrayBuffer(44 + data));
  const text = (o, s) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  text(0, "RIFF");
  b.setUint32(4, 36 + data, true);
  text(8, "WAVE");
  text(12, "fmt ");
  b.setUint32(16, 16, true);
  b.setUint16(20, 1, true);
  b.setUint16(22, 1, true);
  b.setUint32(24, sr, true);
  b.setUint32(28, sr * 2, true);
  b.setUint16(32, 2, true);
  b.setUint16(34, 16, true);
  text(36, "data");
  b.setUint32(40, data, true);
  samples.forEach((s, i) => b.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 32767, true));
  return new Uint8Array(b.buffer);
}

/** A4, a short silence, then C5 with vibrato: 1.4 s. */
export function phrase(sr) {
  const out = new Float32Array(Math.round(sr * 1.4));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    if (t >= 0.5 && t < 0.7) continue;
    const hz = t < 0.5 ? 440 : 523.25 * (1 + 0.01 * Math.sin(t * 35));
    phase += (2 * Math.PI * hz) / sr;
    out[i] = 0.3 * (Math.sin(phase) + 0.5 * Math.sin(2 * phase));
  }
  return out;
}
