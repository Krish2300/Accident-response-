# Offline decoding option comparison

- Created: 2026-10-25T11:00:04.854Z
- Input set: existing canonical 7 WAVs; original files unchanged.
- Preprocessing: provider helper functions; 16 kHz mono PCM WAV.
- Model SHA-256: a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002
- Configurations: default beam search (bs=5, bo=5) vs greedy (bs=1, bo=1).
- Results: {"default-beam5":{"exact":3,"normalized":3,"failures":0},"greedy-bestof1":{"exact":3,"normalized":3,"failures":0}}

See experiment-results.json for per-sample transcripts, matching, hashes, commands, and technical logs.
