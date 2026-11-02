#!/usr/bin/env bash
set -euo pipefail
run_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
cd /mnt/f/minor
samples=(sample-01.wav sample-02.wav sample-03.wav)
for sample in "${samples[@]}"; do
  if [[ -e "$run_dir/$sample" ]]; then
    printf 'Refusing to overwrite existing audio: %s\n' "$run_dir/$sample" >&2
    exit 2
  fi
done
cleanup() { rm -- "$run_dir/sample-01.wav" "$run_dir/sample-02.wav" "$run_dir/sample-03.wav"; }
trap cleanup EXIT
phrases=(
  'This is a synthetic audio recognition test.'
  'A blue kite is flying above the quiet park.'
  'The library opens at nine on Tuesday morning.'
)
for i in 0 1 2; do
  espeak-ng -v en-gb -s 145 -p 50 -a 110 -w "$run_dir/${samples[$i]}" "${phrases[$i]}"
done
python3 - "$run_dir" <<'PY'
import glob, math, os, struct, sys, wave
for p in sorted(glob.glob(os.path.join(sys.argv[1], 'sample-*.wav'))):
    with wave.open(p, 'rb') as w:
        assert (w.getframerate(), w.getnchannels(), w.getsampwidth()) == (22050, 1, 2)
        raw = w.readframes(w.getnframes())
    values = struct.unpack('<' + 'h' * (len(raw) // 2), raw)
    rms = math.sqrt(sum(x*x for x in values) / len(values))
    assert rms > 0 and max(map(abs, values)) > 0
print('WAV validation: PASS (3 files, mono S16LE 22050 Hz, non-silent)')
PY
node --import /home/resus/resus/node_modules/tsx/dist/loader.mjs "$run_dir/run-control.mjs"
