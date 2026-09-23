#!/usr/bin/env python3
"""Export torchcrepe's pretrained `full` model to ONNX and validate f0 on a synthetic tone.

Writes ../models/crepe-<capacity>.onnx. Needs: pip install torch torchcrepe onnxruntime
Usage: python scripts/export_crepe.py [full|large|medium|small|tiny]

CREPE contract (must be mirrored in the Rust preprocessor):
  - input audio sample rate: 16000 Hz
  - frame length: 1024 samples, hop: 160 samples (10 ms)
  - per-frame normalization: subtract mean, divide by std (clamped)
  - model output: (N, 360) activations in [0,1]; bin i -> cents = CENTS_0 + 20*i
  - f0 from local weighted average of cents around the argmax bin; confidence = peak activation
"""
import os
import numpy as np
import torch
import torchcrepe

import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# Capacity: 'full' (default, best accuracy, slower) | 'large' | 'medium' | 'small' | 'tiny'.
CAPACITY = sys.argv[1] if len(sys.argv) > 1 else "full"
OUT = os.path.join(HERE, "..", "models", f"crepe-{CAPACITY}.onnx")

SAMPLE_RATE = 16000
WINDOW = 1024
CENTS_0 = 1997.3794084376191  # cents of bin 0 (CREPE constant)
CENTS_PER_BIN = 20.0


def cents_to_hz(cents):
    return 10.0 * 2.0 ** (cents / 1200.0)


def hz_to_cents(hz):
    return 1200.0 * np.log2(hz / 10.0)


def load_model():
    torchcrepe.load.model(torch.device("cpu"), CAPACITY)
    model = torchcrepe.infer.model
    model.eval()
    return model


def frame_and_normalize(audio):
    """Replicate torchcrepe preprocessing for raw 16k mono audio -> (N,1024) normalized frames."""
    audio = torch.tensor(audio, dtype=torch.float32)[None]  # (1, T)
    # center padding
    pad = WINDOW // 2
    audio = torch.nn.functional.pad(audio, (pad, pad))
    hop = SAMPLE_RATE // 100  # 160
    frames = audio.unfold(1, WINDOW, hop)[0]  # (N, 1024)
    frames = frames.clone()
    frames -= frames.mean(dim=1, keepdim=True)
    frames /= torch.clamp(frames.std(dim=1, keepdim=True), min=1e-10)
    return frames


def decode_f0(activation):
    """activation: (N,360) numpy -> (f0_hz, confidence) using local weighted average."""
    bins = np.arange(360)
    cents_grid = CENTS_0 + CENTS_PER_BIN * bins
    argmax = activation.argmax(axis=1)
    f0 = np.zeros(len(activation))
    conf = activation.max(axis=1)
    for i, c in enumerate(argmax):
        lo, hi = max(0, c - 4), min(360, c + 5)
        w = activation[i, lo:hi]
        cents = (cents_grid[lo:hi] * w).sum() / max(w.sum(), 1e-10)
        f0[i] = cents_to_hz(cents)
    return f0, conf


def main():
    model = load_model()

    # --- export ---
    dummy = torch.randn(1, WINDOW, dtype=torch.float32)
    # sanity: confirm pretrained weights are actually loaded (full CREPE ~22M params)
    nparams = sum(p.numel() for p in model.parameters())
    print(f"model params: {nparams:,}")
    torch.onnx.export(
        model, dummy, OUT,
        input_names=["frames"], output_names=["activation"],
        dynamic_axes={"frames": {0: "N"}, "activation": {0: "N"}},
        opset_version=10,  # Pad uses attributes (1 input) at <=10; tract-friendly
        dynamo=False,  # legacy TorchScript exporter: embeds weights, IR<=9 (tract + ort compatible)
    )
    print(f"exported -> {OUT} ({os.path.getsize(OUT)} bytes)")

    # --- validate on synthetic tones ---
    import onnxruntime as ort
    sess = ort.InferenceSession(OUT, providers=["CPUExecutionProvider"])

    print("\nfreq_in  median_f0  median_conf")
    for target in [110.0, 220.0, 440.0, 880.0]:
        t = np.arange(int(SAMPLE_RATE * 1.0)) / SAMPLE_RATE
        sig = 0.5 * np.sin(2 * np.pi * target * t).astype(np.float32)
        frames = frame_and_normalize(sig).numpy()
        act = sess.run(["activation"], {"frames": frames})[0]
        f0, conf = decode_f0(act)
        # ignore edge frames
        f0m = np.median(f0[5:-5])
        cm = np.median(conf[5:-5])
        err_cents = 1200 * np.log2(f0m / target)
        flag = "OK" if abs(err_cents) < 30 and cm > 0.5 else "BAD"
        print(f"{target:6.1f}  {f0m:8.2f}  {cm:9.3f}  ({err_cents:+.1f} cents) {flag}")


if __name__ == "__main__":
    main()
