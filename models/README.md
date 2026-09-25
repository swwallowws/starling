# CREPE model

voxmpe needs `crepe-full.onnx` (85 MB) in this folder.

Export it yourself (needs Python with torch, torchcrepe, onnxruntime):

    python scripts/export_crepe.py

It writes `models/crepe-full.onnx` and checks its pitch accuracy on test tones.

The browser studio (`npm run build:web` in `studio-ui/`) uses CREPE tiny (2 MB)
instead. Make it the same way:

    python scripts/export_crepe.py tiny

CREPE (Jong Wook Kim et al., 2018) and torchcrepe (Max Morrison, 2020) are MIT licensed.
