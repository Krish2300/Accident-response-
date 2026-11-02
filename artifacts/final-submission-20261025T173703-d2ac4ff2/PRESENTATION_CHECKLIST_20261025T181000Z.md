# RESUS synthetic presentation checklist

This checklist is for an isolated local demo only. Do not use real caller data, real emergency services, live traffic systems, or real dispatch. Keep all generated records synthetic/simulated.

## Before the presentation

- [ ] Confirm branch and inspect `git status`; preserve all existing modified/untracked work.
- [ ] Confirm ports 4000 and 5173 are free; do not stop unrelated processes.
- [ ] Start the isolated backend in Terminal 1:
  ```powershell
  $env:RESUS_DEMO_ISOLATED = 'true'
  npm run demo:server
  ```
- [ ] Start the dashboard in Terminal 2:
  ```powershell
  node .\node_modules\vite\bin\vite.js --config apps/dashboard/vite.config.ts --host 127.0.0.1 --port 5173 --strictPort
  ```
- [ ] Open `http://127.0.0.1:5173` and use the current run’s dispatcher credentials privately.
- [ ] Optionally run `npm run demo:verify` with `DEMO_SERVER_LOG` pointing to the private current-run log. Expected: 28/28.

## Presentation flow

- [ ] Show the synthetic emergency and its transcript/classification; identify speech/transcript as demo data.
- [ ] Show the simulated ambulance and fresh location timestamp.
- [ ] Show the explicit assignment/dispatch workflow as simulated; automatic dispatch is disabled.
- [ ] Show mock route provenance and `isLiveTraffic: false`.
- [ ] Show lifecycle projection and state that all four milestones are operator-reported attestations.
- [ ] Show role denial/idempotency only if useful; do not imply independent arrival or patient outcome verification.
- [ ] State that no live PBX call, real dispatch, live routing, or clinical validation was performed.

## Shutdown

- [ ] Stop Vite with Ctrl+C in its terminal.
- [ ] Stop the demo backend using Ctrl+C or its owned sentinel:
  ```powershell
  New-Item -ItemType File "$env:TEMP\resus-demo-server-4000.stop"
  ```
- [ ] Confirm ports used by this demo are free and the owned disposable database was removed.

## Separate English speech gate

- [ ] Listen to all seven canonical WAV files using the existing playback script.
- [ ] Complete human intelligibility and phrase-match judgments on the canonical checklist; do not auto-mark pass.
- [ ] Current measured Whisper result is 3/7 normalized matches. Do not describe it as accepted or improved without completing the documented gate.
