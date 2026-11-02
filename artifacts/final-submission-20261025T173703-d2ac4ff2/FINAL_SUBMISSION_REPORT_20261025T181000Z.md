# RESUS final submission status

**Repository:** `F:\minor`  
**Branch / HEAD:** `main` / `121d7933ae3edcd478089343fdc493f2757d2ad8`  
**Status:** suitable for a controlled, synthetic college demonstration after presenter rehearsal; not validated or cleared for clinical or production use.

This report supplements the existing acceptance evidence. It does not replace or edit `docs/FINAL_ACCEPTANCE_REPORT.md`. At the start of this verification, 168 modified or untracked worktree entries were present; all were preserved. No staging, branch changes, reset, clean, commit, push, deployment, real calls, or live service integrations occurred.

## Verification performed

| Check | Actual result |
| --- | --- |
| Branch and HEAD | `main`, `121d7933ae3edcd478089343fdc493f2757d2ad8` |
| Full Vitest suite with isolated integration gates enabled | **89 files passed, 1 skipped; 855 tests passed, 1 skipped**; exit 0. Skip: opt-in live Module 3 classifier suite. |
| TypeScript typecheck | `npm run typecheck` passed; exit 0. |
| Backend bundle | esbuild to this report directory passed; exit 0. |
| Dashboard production build | Vite build to this report directory passed; exit 0. |
| Full repository lint | **Failed**: 2 `no-empty` errors and 49 warnings. The two errors are in existing untracked Whisper experiment scripts, not changed by this work: `artifacts/canonical-english-recognition-4796c0f777094375a47e38ad5ec446c8/run-experiment.mjs:56` and `artifacts/offline-whisper-control-20261025-49381978e33047a587f90a6ac4e6c21e/run-control.mjs:42`. They were preserved. |
| Protocol catalogue validation | 5 protocols / 33 steps; 0 errors, 3 warnings. All five catalogues remain unreviewed; warnings concern critical escalation rules without a named escalation step. |
| Live local synthetic demo | `npm run demo:verify`: **28/28 passed** using the local backend socket and headless Edge. Verified auth failures/success, synthetic emergency and fleet, simulated GPS freshness, operator-reported milestone projection, idempotency, role denial, mock route provenance, browser display, and no token in browser storage. No phone call or external service was used. |
| `git diff --check` | Exit 0; Git emitted existing line-ending normalization notices. |

Full command output is retained in [vitest-full-gated.log](./vitest-full-gated.log), [typecheck.log](./typecheck.log), [lint.log](./lint.log), [protocols-validate.log](./protocols-validate.log), and [demo-verify.log](./demo-verify.log). The backend bundle is `server/server.js`; the dashboard bundle is under `apps/dashboard/artifacts/final-submission-20261025T173703-d2ac4ff2/web/` because the Vite config sets `apps/dashboard` as its root. Normal `dist` outputs were not overwritten.

Exact regression/build commands used:

```powershell
$env:RESUS_RUN_ISOLATED_COMPOSITION_TEST = 'true'
$env:RESUS_RUN_ISOLATED_OUTCOME_TEST = 'true'
$env:RESUS_RUN_ISOLATED_OUTCOME_API_TEST = 'true'
$env:RESUS_RUN_ISOLATED_OUTCOME_GRANT_TEST = 'true'
$env:RESUS_RUN_DASHBOARD_LIVE_TEST = 'true'
npx vitest run --reporter=dot
```

```powershell
npm run typecheck
npm run lint
npm run protocols:validate
git diff --check
npx esbuild apps/server/src/main.ts --bundle --platform=node --target=node20 --format=esm --packages=external --outfile="artifacts/final-submission-20261025T173703-d2ac4ff2/server/server.js" --sourcemap --log-level=warning
npx vite build --config apps/dashboard/vite.config.ts --outDir "artifacts/final-submission-20261025T173703-d2ac4ff2/web" --emptyOutDir
```

## Modules 1–12

| Module | Verified status in this submission | Boundary / remaining limitation |
| --- | --- | --- |
| 1 — Emergency call intake | Implemented; automated and composition-tested; synthetic intake/transcript visible in demo | Telephony is loopback; no PBX call/media verified. |
| 2 — Speech processing | Ports and loopback path tested; offline English Whisper comparison is reproducible | Whisper human-review gate remains 3/7 normalized match; no live caller audio. TTS/Whisper engines are not the demo path. |
| 3 — NLP extraction | Candidate/classifier routes tested | Live Python classifier suite is skipped unless explicitly opted in; feature disabled by default. |
| 4 — Conversation support | Configuration, localization, silence behavior tested and composition-wired | Inert without reviewed config; no bystander browser UI. |
| 5 — Bystander assistance | Protocol engine/session and trust handling tested; sole clinical authority preserved | Protocol catalogue is unreviewed and not clinically validated. Disconnect policy decisions remain unresolved; no owner approval inferred. |
| 6 — Ambulance management | Fleet, explicit assignment/dispatch, driver role, simulated GPS, and safety gates tested; demo workflow verified | Automatic dispatch remains disabled. No physical driver device/GPS validation. |
| 7 — Hospital intelligence | Resource updates and explicit selection tested; simulated demo workflow verified | Automatic selection disabled; no hospital system integration; suitability is not clinical advice. |
| 8 — Route optimization | Mock route generation/recalculation and fallback tested; browser shows mock provenance | No live routing provider; auto-route disabled. |
| 9 — Corridor coordination | Simulated corridor/notification behavior and safeguards tested | No traffic control, road-user feed, or real police messaging. |
| 10 — Lifecycle orchestration | Read-only event projection, provenance, ordering/idempotency behavior tested and shown in demo | Milestones are operator attestations, not independently verified arrival/handover facts; legacy FSM remains unwired. |
| 11 — Database and events | Isolated SQLite/Prisma persistence, migrations through disposable tests, event and outcome governance suites passed | Single-node prototype; no production/multitenant/HA assurance. Shared development DB was not used. |
| 12 — Dashboard and analytics | Frontend tests and live Vite proxy/demo browser path passed | Learning remains disabled; ADMIN grant UI not included in browser demo verification. |

## Changes made and protected boundaries

The demo-only scripts were previously changed with explicit approval: all four demo fixture paths are marked simulated; the demo verifier GPS update is simulated; the isolated demo enables only the simulation modes needed for explicit operator-triggered route/hospital demonstrations and includes simulated data in the dashboard. Automatic dispatch, auto-selection, auto-routing, Module 12 learning, speech settings, VAD settings, and Module 5 policy remain unchanged. `tests/demoServerSimulationFlags.test.ts` has focused source-guard regression coverage. Focused tests after those changes passed: 10 files / 65 tests, plus the isolated composition workflow tests (2/2).

## Reproducible presentation commands

Run from `F:\minor` in separate PowerShell terminals, after checking that ports 4000 and 5173 are free. Do not stop processes you did not start.

**Terminal 1 — isolated backend with disposable database:**

```powershell
$env:RESUS_DEMO_ISOLATED = 'true'
npm run demo:server
```

Use the per-run dispatcher account printed by the backend privately; do not paste credentials into this report. The server binds to loopback and creates an owned temporary database. Keep the terminal open.

**Terminal 2 — dashboard on loopback:**

```powershell
node .\node_modules\vite\bin\vite.js --config apps/dashboard/vite.config.ts --host 127.0.0.1 --port 5173 --strictPort
```

Open `http://127.0.0.1:5173`, sign in with the current run’s dispatcher account, and present the synthetic emergency, fleet freshness, simulated dispatch/route provenance, and operator-reported lifecycle evidence. The route remains mock (`isLiveTraffic: false`).

**Optional automated verification** (third terminal while both services are running):

```powershell
$env:DEMO_SERVER_LOG = '<private path to this run’s server log>'
npm run demo:verify
Remove-Item Env:DEMO_SERVER_LOG
```

Avoid copying the server log into shared reports because it contains per-run credentials. Expected result: 28/28 checks pass.

**Shutdown:** press Ctrl+C in the Vite terminal. For the demo backend, create the sentinel for the selected backend port (default 4000); it removes only the database owned by this process:

```powershell
New-Item -ItemType File "$env:TEMP\resus-demo-server-4000.stop"
```

Confirm the owned backend has stopped and its port is free. Do not terminate an unrelated process.

## Known gaps and claims not made

- **Clinical:** Module 5 content is unreviewed; no clinical/protocol-owner approval or clinical validation. Disconnect policy decisions are unresolved.
- **Speech:** synthetic English samples received human intelligibility review, but Whisper scored 3/7 normalized matches on the canonical set. No transcription improvement or caller-audio accuracy is established.
- **Telephony:** no PBX call, live AudioSocket two-way session, PSTN, or emergency number was exercised.
- **Security:** role/API and browser token-storage checks passed locally; this is not independent security testing, penetration testing, or production hardening.
- **Deployment:** no deployment, external-service integration, multi-tenant assurance, high availability, or production-readiness validation.
- **Testing:** the live Module 3 classifier suite was skipped. Flutter driver checks are documented in prior acceptance evidence, not rerun in this final pass. Full lint remains red for the two existing experiment-script errors and 49 warnings.

## Next action

Rehearse the documented synthetic demo once from a clean start, then complete the separate human-reviewed Whisper audio gate if recognition is part of the presentation. Do not present simulated behavior as live telephony or clinical decision support.
