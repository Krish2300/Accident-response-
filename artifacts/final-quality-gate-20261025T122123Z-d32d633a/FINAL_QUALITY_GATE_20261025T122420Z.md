# RESUS final quality gate and submission freeze

**Repository:** `F:\minor`  
**Branch / HEAD:** `main` / `121d7933ae3edcd478089343fdc493f2757d2ad8`  
**Gate result:** passed for the intended isolated, synthetic college demonstration. This is not production or clinical readiness.

The pre-run worktree contained 168 status entries: 71 modified, 97 untracked, zero staged, and zero deleted. All pre-existing modified/untracked work was preserved. The only source-code files edited were the two requested lint experiment scripts; the new report, logs, and build outputs are additive files in this fresh quality-gate directory. `artifacts/final-quality-gate-current.txt` points to that directory. The existing `docs/FINAL_ACCEPTANCE_REPORT.md`, previous final-submission report, and presentation checklist were not overwritten. No services were started, restarted, stopped, or otherwise disrupted. The already-running demo pair remained available at loopback ports 4000 and 5173.

## Lint fix

The two errors were empty `catch {}` blocks around alternate Whisper JSON result-file reads. Each loop tries its first candidate, then falls back to the alternate path when the first file is absent. The smallest correction was to ignore only `ENOENT`, preserving that fallback behavior, and rethrow other filesystem errors instead of silently swallowing them.

Changed files:

- `artifacts/canonical-english-recognition-4796c0f777094375a47e38ad5ec446c8/run-experiment.mjs`
- `artifacts/offline-whisper-control-20261025-49381978e33047a587f90a6ac4e6c21e/run-control.mjs`

Targeted ESLint passed with **0 errors, 0 warnings**. `node --check` passed on both scripts. No test was added: these are standalone diagnostic scripts and the correction changes only expected-missing-file handling; it does not modify application behavior or recognition settings.

## Final gate results

| Check | Result |
| --- | --- |
| Full Vitest run with isolated composition/outcome/dashboard gates | **89 files passed, 1 skipped; 855 tests passed, 1 skipped; exit 0.** The skip is the opt-in live Module 3 classifier suite. |
| `npm run typecheck` | Passed; exit 0. |
| Backend esbuild bundle | Passed; exit 0. Output: `server/server.js` in this directory. |
| Dashboard Vite production build | Passed; exit 0. Output: `apps/dashboard/artifacts/final-quality-gate-20261025T122123Z-d32d633a/dashboard/` because the Vite config root is `apps/dashboard`. Normal `dist` was not overwritten. |
| `npm run lint` | **0 errors, 49 warnings; exit 0.** |
| `npm run protocols:validate` | **5 protocols, 33 steps, 0 errors, 3 warnings; exit 0.** The five protocol sets remain unreviewed. |
| Existing demo `npm run demo:verify` | **28/28 passed; exit 0** against the already-running backend/dashboard. No service restart occurred. |
| `git diff --check` | Passed; exit 0. Git reported existing LF/CRLF normalization notices. |
| Changed diagnostic scripts syntax | Both `node --check` commands passed. |

Full logs: [Vitest](./vitest-full.log), [typecheck](./typecheck.log), [targeted lint and syntax](./targeted-lint-and-syntax.log), [full lint](./lint-full.log), [backend build](./server-build.log), [dashboard build](./dashboard-build.log), [protocol validation](./protocols-validate.log), [demo verifier](./demo-verify.log), and [diff check](./diff-check.log).

### Commands executed

```powershell
npx eslint artifacts/canonical-english-recognition-4796c0f777094375a47e38ad5ec446c8/run-experiment.mjs artifacts/offline-whisper-control-20261025-49381978e33047a587f90a6ac4e6c21e/run-control.mjs
node --check artifacts/canonical-english-recognition-4796c0f777094375a47e38ad5ec446c8/run-experiment.mjs
node --check artifacts/offline-whisper-control-20261025-49381978e33047a587f90a6ac4e6c21e/run-control.mjs
```

```powershell
$env:RESUS_RUN_ISOLATED_COMPOSITION_TEST = 'true'
$env:RESUS_RUN_ISOLATED_OUTCOME_TEST = 'true'
$env:RESUS_RUN_ISOLATED_OUTCOME_API_TEST = 'true'
$env:RESUS_RUN_ISOLATED_OUTCOME_GRANT_TEST = 'true'
$env:RESUS_RUN_DASHBOARD_LIVE_TEST = 'true'
npx vitest run --reporter=dot
```

The runner removed those five opt-in environment variables after the test process exited.

```powershell
npm run typecheck
npm run lint
npm run protocols:validate
git diff --check
npx esbuild apps/server/src/main.ts --bundle --platform=node --target=node20 --format=esm --packages=external --outfile="artifacts/final-quality-gate-20261025T122123Z-d32d633a/server/server.js" --sourcemap --log-level=warning
npx vite build --config apps/dashboard/vite.config.ts --outDir "artifacts/final-quality-gate-20261025T122123Z-d32d633a/dashboard" --emptyOutDir
```

Vite resolved that relative output directory beneath its configured `apps/dashboard` root. The resulting dashboard bundle is at `apps/dashboard/artifacts/final-quality-gate-20261025T122123Z-d32d633a/dashboard/`.

Demo verification used the existing private server log via `DEMO_SERVER_LOG`; credentials are intentionally omitted from this report and logs summary. The variable was removed after verification.

## Module status summary

| Module | Verified status | Remaining boundary |
| --- | --- | --- |
| 1 — Emergency intake | Automated/composition-tested; synthetic intake visible in browser demo | Loopback transport only; no live PBX/media test. |
| 2 — Speech | Speech ports and loopback path tested; canonical offline English experiment reproducible | Whisper remains **3/7 normalized matches**; no live caller audio or acceptance improvement. |
| 3 — NLP | Candidate/classifier routes tested | Live Python classifier suite skipped; classifier feature disabled by default. |
| 4 — Conversation support | Configuration, localization, silence handling tested and composed | No reviewed production localization config or bystander UI. |
| 5 — Bystander assistance | Session/protocol behavior tested; sole clinical authority preserved | Catalogue is unreviewed; disconnect policy requires protocol-owner decisions. |
| 6 — Ambulance management | Fleet, explicit assignment/dispatch, driver role, simulated GPS tested/demoed | Automatic dispatch disabled; no physical device validation. |
| 7 — Hospital intelligence | Resource updates and explicit selection tested/demoed | No hospital integration; auto-selection disabled; not clinical advice. |
| 8 — Route optimization | Mock routing, recalculation and fallback tested/demoed | No live routing provider; auto-route disabled. |
| 9 — Corridor coordination | Simulation and fail-closed behavior tested | No traffic control or real police messaging. |
| 10 — Lifecycle | Read-only event projection, provenance, ordering and idempotency tested/demoed | Milestones are operator attestations, not independent arrival/handover verification. |
| 11 — Database/events | Isolated SQLite/Prisma, migration and event/outcome suites passed | Single-node prototype; no production, multi-tenant, or HA assurance. |
| 12 — Dashboard/analytics | Frontend tests and live local Vite proxy/browser verification passed | Learning remains disabled; admin grant UI not browser-walkthrough tested. |

## Reproducible presentation commands

These are instructions only; this quality gate did not start services. Check ports first and do not stop any process that is not yours.

**PowerShell terminal 1 — isolated backend:**

```powershell
$env:RESUS_DEMO_ISOLATED = 'true'
npm run demo:server
```

**PowerShell terminal 2 — dashboard:**

```powershell
node .\node_modules\vite\bin\vite.js --config apps/dashboard/vite.config.ts --host 127.0.0.1 --port 5173 --strictPort
```

Open `http://127.0.0.1:5173` and use the current run’s dispatcher credentials privately. Optional verification in another terminal:

```powershell
$env:DEMO_SERVER_LOG = '<private current-run server log path>'
npm run demo:verify
Remove-Item Env:DEMO_SERVER_LOG
```

For a demo instance you started, stop Vite with Ctrl+C and stop the backend with Ctrl+C or its owned sentinel (default port 4000):

```powershell
New-Item -ItemType File "$env:TEMP\resus-demo-server-4000.stop"
```

The backend sentinel removes only that process’s owned temporary database. The pair that was already running during this quality gate was left running and undisturbed.

## Explicit limits and readiness

- **College demonstration:** ready for the controlled synthetic workflow; the verifier passed 28/28 against the existing local pair.
- **Speech:** 3/7 normalized matches on the canonical English set. Human review may establish intelligibility, but does not turn this measured recognition score into acceptance.
- **Telephony:** live Asterisk call and two-way AudioSocket media remain unverified. No call was placed.
- **Clinical and Module 5:** content remains unreviewed; no clinical validation or protocol-owner approval of disconnect decisions is claimed.
- **Dispatch and external actions:** dispatch simulation only; no emergency services, vehicles, police, traffic systems, or external providers were contacted.
- **Security/deployment:** local role checks are not independent security validation. No deployment, production hardening, high availability, or production-readiness claim is made.

**Submission judgment:** suitable for the intended synthetic college demo. Not cleared for clinical use, live emergency operations, or production deployment.
