# Stage 4.19 local prototype demo guide

This guide describes the isolated software prototype only. It does not establish clinical validity, real emergency-service readiness, survival prediction, live traffic control, or production readiness.

## Prerequisites

- Node.js 20 or newer and the repository's already-installed npm dependencies.
- Flutter installed only when running the driver-app checks.
- A local SQLite-capable Prisma engine. The repository's Prisma schema and migration history are under `modules/module_11_database_event_system/prisma`.

Check local versions with `node --version`, `npm --version`, `npx prisma -v`, and, when applicable, `flutter --version`. This project does not require dependency installation as part of the demo.

The local backend defaults to port `4000`; Vite serves the dashboard on its configured local port (`5173`) and proxies `/api` and `/ws` to `127.0.0.1:4000`. For any manually started isolated session, explicitly set these process environment values before each process starts:

| Variable | Safe local value or rule |
| --- | --- |
| `DATABASE_URL` | Absolute URL for a newly created disposable SQLite file; never omit or use the repository's shared database. |
| `JWT_SECRET` | A newly generated, temporary local secret; never put it in source control or this guide. |
| `HOST` / `PORT` | `127.0.0.1` / `4000` for a local-only backend. |
| `TRANSPORT_PROVIDER` | `loopback` for software-only calls. |
| `MODULE3_NLP_ENABLED` | `false` unless an explicitly isolated local classifier is being tested. |
| `MODULE6_AUTO_DISPATCH_ENABLED` | `false`. |
| `MODULE7_AUTO_SELECT_ENABLED` | `false`. |
| `MODULE8_PROVIDER` / `MODULE8_AUTO_ROUTE_ENABLED` | `mock` / `false`. |
| `MODULE9_CORRIDOR_ENABLED` | `false`. |
| `MODULE12_LEARNING_ENABLED` | `false`. |

## Safest reproducible integrated demonstration

The supported acceptance test creates a uniquely owned SQLite database under the operating-system temporary directory, initializes and verifies it, sets `DATABASE_URL` explicitly, applies only the existing migrations to that file, creates test-only users and fixtures, and removes only its owned database artifacts after the test. It also explicitly disables Module 6–9 automation and injects deterministic mock routing. It does not use `dev.db`, run the general seed, listen on a network port, or call external providers.

Run from the repository root in PowerShell:

```powershell
$env:RESUS_RUN_ISOLATED_COMPOSITION_TEST = 'true'
node .\node_modules\vitest\vitest.mjs run tests/serverCompositionAmbulanceWorkflow.integration.test.ts
```

The test creates its own disposable login accounts with the repository's bcrypt password-hashing mechanism. Credentials are test-only constants in the test source; do not reuse them or copy them into a real environment. The workflow verifies Fastify authentication, emergency intake, final transcript persistence, explicit normalized classification, Module 5 session access, driver assignment response, explicit dispatch, hospital selection, deterministic mock routing, simulated police-notification records, operator-reported lifecycle milestones, Module 10 projection, and the dashboard API client routed through Fastify's in-process injector.

The in-process test is the only currently supported reproducible end-to-end setup that provisions all required fixtures. The server composition waits for Module 10 replay before the Fastify app is returned to the test. It is not a browser test and does not verify device GPS.

## Optional local browser demonstration

`npm run demo:server` (exactly `RESUS_DEMO_ISOLATED=true` required) starts the real Fastify composition against a disposable SQLite database it creates and owns under the OS temporary directory, provisions fixtures through the authenticated API, and listens on loopback only. It refuses to start without the explicit environment flag and never touches `dev.db`, the general seed, an external provider or telephony transport. Module 6–9 automation stays disabled, NLP and learning stay off, and routing is the deterministic mock. Stopping the process (Ctrl+C or the printed sentinel file) deletes the owned database.

```powershell
$env:RESUS_DEMO_ISOLATED = 'true'; npm run demo:server
```

The process prints its test-only accounts, demo emergency, ambulance and hospital identifiers exactly once to its own stdout; they are generated per run, never stored, and never put in source control. `DEMO_PORT` (default `4000`) and `DEMO_DASHBOARD_URL` (default `http://127.0.0.1:5173`) may override the loopback ports.

Serve the dashboard with the workspace Vite config, which proxies `/api` and `/ws` to the local backend:

```powershell
npm run dev --prefix apps/dashboard
# or from the repository root:
npx vite --config apps/dashboard/vite.config.ts
```

Then open the printed local URL (`http://127.0.0.1:5173`; the Vite config binds IPv4 loopback explicitly), sign in with a printed account, and select the printed emergency. The token stays in page memory only. Lifecycle arrival, onboard, hospital-arrival and operational-completion records are explicit operator reports; they are not independently verified and completion is not a patient outcome. Route records show their actual `isLiveTraffic` value (false for the mock). Corridor activation does not prove signal control or delivery of a real notification.

### Login and roles

Sign in on the dashboard with one of the accounts printed by `demo:server` (generated per run; never reuse or copy them):

| Account | Role | Demonstrates |
| --- | --- | --- |
| `dispatcher@demo.test` | `DISPATCHER` | Live emergencies, dispatch/route/milestone panels, fleet view |
| `operator@demo.test` | `OPERATOR` | Read-only lifecycle and classification views |
| `driver@demo.test` | `DRIVER` | Driver assignment/acceptance; cannot record milestones (403) |

### Demonstration sequence and expected outputs

1. Sign in as the dispatcher → the live list shows the printed emergency (`CARDIAC_ARREST · CRITICAL`) and the fleet shows the printed ambulance with a fresh location.
2. Select the emergency → the lifecycle panel lists the final transcript, an `OPERATOR`-sourced classification, and all four milestones labelled "operator reported", each `Observed`; completion states `OPERATIONAL COMPLETION RECORDED — this is not a patient outcome`.
3. Attempt a duplicate milestone (or sign in as the driver and try to record one) → duplicate returns the same event id (`duplicate: true`); the driver gets a visible 403.
4. Dispatch workflow panel → the route record shows `provider: mock` and `isLiveTraffic: false`; any police notice is labelled simulated (`MOCK_POLICE_CONTROL_ROOM`, `realPoliceContacted: false`).
5. Learning/analytics endpoints stay admin-only; learning samples are empty.

`npm run demo:verify` re-checks a running demo pair over real sockets — HTTP authentication/authorization failures, lifecycle evidence semantics, duplicate-milestone idempotency, fleet freshness after an authorized GPS report, learning isolation — and, unless `DEMO_SKIP_BROWSER=true`, the same checks inside the already-installed Microsoft Edge driven over its DevTools protocol, without downloading or installing any browser tooling. It reads the per-run credentials from the demo server's own stdout log (`DEMO_SERVER_LOG`) or from `DEMO_DISPATCHER_*`/`DEMO_DRIVER_*` environment variables; set `DEMO_BASE_URL`/`DEMO_DASHBOARD_URL` when the ports were overridden.


## Reproducible live integration test

`tests/dashboardLiveProxy.integration.test.ts` starts an isolated Fastify backend process and the real Vite dev server itself, both stopped by the test, on a uniquely owned disposable SQLite database. It drives the dashboard's own API client through the Vite `/api` proxy: authentication, invalid-credential and unauthorized failures, emergency intake, assignment, acceptance, dispatch, hospital selection, mock routing, authorized GPS updates with freshness, all four operator-reported lifecycle milestones with idempotency and conflict handling, Module 10 projection, and confirmation that learning samples stay empty. It is not a browser test and does not verify device GPS.

```powershell
$env:RESUS_RUN_DASHBOARD_LIVE_TEST = 'true'
node .\node_modules\vitest\vitest.mjs run tests/dashboardLiveProxy.integration.test.ts
```


## Driver application

Run `flutter test --no-pub` and `flutter analyze --no-pub` from `apps/driver` when Flutter is available. If the parallel test run hangs, run `flutter test --no-pub --concurrency=1`; the suites pass sequentially. The app can be configured to reach a local backend, but a physical device/emulator acceptance run is not part of the isolated Fastify composition test. Test coordinates in automated tests are labelled simulation and do not demonstrate physical GPS, background delivery, or network conditions.

## Focused regression checks

```powershell
node .\node_modules\vitest\vitest.mjs run modules/module10/module10/tests/lifecycleProjection.test.ts modules/module_12_dashboard_analytics/tests/dashboardFrontend.test.ts
npm run typecheck
npx prisma validate --schema modules/module_11_database_event_system/prisma/schema.prisma
git diff --check
```

Set `DATABASE_URL` to a throwaway `file:` URL before `prisma validate` so schema validation can never target a shared database; validation does not create or open the file for writing. Database-backed regression tests must use `tests/helpers/isolatedTestDatabase.ts` or another independently verified isolated harness. Do not use `dev.db`, fixed shared test databases, migrations against the repository default, reset commands, or the general seed.


## Verification record (2026-10-23, Stage 4.19 continuation)

Executed on this machine with the repository's existing dependencies; no external provider was contacted and no shared database was opened.

| Command | Result |
| --- | --- |
| Full vitest run with `RESUS_RUN_ISOLATED_{OUTCOME_GRANT,OUTCOME_API,OUTCOME,COMPOSITION}_TEST=true` and `RESUS_RUN_DASHBOARD_LIVE_TEST=true` | 85 files passed, 1 skipped · 829 tests passed, 1 skipped (the skip is `module3Classifier.live`, gated by `MODULE3_LIVE_TEST=1` by design) |
| Focused batches: composition workflows, dashboard live proxy, Module 10 projection, Module 11 transactions, outcome governance, ambulance assignment/dispatch, routing, dashboard API, isolated-database harness | 46 files / 341 tests across batches, all passing |
| `demo:server` (isolated flag) + Vite + `demo:verify` | 28/28 PASS — 18 HTTP checks on real sockets + 10 headless-Edge browser checks (installed Edge via its DevTools protocol; nothing downloaded) |
| Demo shutdown via stop sentinel | `disposed owned database … stopped (stop-file)`; owned DB deleted; ports 4000/5173 freed |
| `npm run typecheck` | exit 0, clean |
| `npx prisma validate` with an explicit throwaway `DATABASE_URL` | exit 0, schema valid, no file created |
| `flutter test --no-pub --concurrency=1` / `flutter analyze --no-pub` (apps/driver) | 4/4 passed · no issues found |
| `git diff --check` | exit 0 (repo-wide CRLF warnings only, pre-existing) |

Physical-device GPS, live OSRM/Google routing, live telephony, real police/signal systems, and the live Module 3 classifier remain unverified — mocked, loopback, or absent by design. This record documents prototype verification only, not clinical validation or production readiness.


## Boundaries and troubleshooting

- Automatic dispatch, hospital selection, route generation, and corridor coordination remain disabled by default. The integrated test uses explicit operator actions and deterministic mocks.
- Module 5 remains the sole protocol authority. Its catalogue includes content marked `UNREVIEWED`; a successful session/API test is not clinical approval.
- Module 3 extraction is optional and disabled by default. A candidate is not a normalized classification.
- Outcome assertions are append-only and require independent review before learning eligibility. Simulation/test/pending/superseded/unverified data must not be described as training evidence.
- Google Routes, OSRM, telephony, police recipients, external notifications, traffic controllers, and live signals are not contacted by the acceptance test.
- If a migration target is ambiguous, an isolated database cannot be verified, or a provider is not mocked, stop instead of proceeding with the demo.
- `demo:server` fails with `EADDRINUSE` when its port is taken: start it with `DEMO_PORT=4021` (or another free loopback port) and pass the same port to `demo:verify` via `DEMO_BASE_URL`. The stop sentinel is printed per port (`%TEMP%\resus-demo-server-<port>.stop`).
- If Vite reports a different port than 5173, use the `Local:` URL it prints; the config binds `127.0.0.1` explicitly, so `http://127.0.0.1:<port>` always matches.
- If the dashboard loads but every API call fails, confirm the demo backend is still running and that you are opening the Vite URL (not the backend URL) in the browser.
- The per-run credentials are printed once on the demo server's stdout and are not stored; restart `demo:server` if they are lost. Stopping it deletes only the database it created and owns.
- The environment table above applies to manually started sessions; `demo:server` sets all of those safety flags internally for its own disposable database.

## Live WSL dashboard/auth check — P2 closed (2026-10-23)

Verification used the live WSL backend (`Ubuntu`, `/home/resus/resus`, port 4000), not `demo:server`. The keeper was present, `resus-server.service` was active, and `/api/health` returned HTTP 200 with 71 routes. Asterisk, Whisper, and eSpeak status endpoints were live. The Windows Vite dashboard used its default proxy target `http://127.0.0.1:4000`; its `/api/health` proxy returned the same live WSL payload.

### Provisioning and credentials

The ignored WSL `.env` contained no dispatcher/driver demo password keys. Available temporary demo-server logs contained `@demo.test` accounts for disposable isolated databases, not the WSL `@resus.local` users, so the existing passwords were not recoverable through the documented path.

The existing `scripts/provision-demo-accounts.ts` was extended to accept `DEMO_DISPATCHER_EMAIL` and `DEMO_DRIVER_EMAIL`, while keeping the roles fixed to `DISPATCHER` and `DRIVER`. It continues to require environment-supplied passwords of at least 12 characters, hash them with bcrypt via Module 11 `users.create`, skip existing users, and never reset passwords. It created two new users: `p2-dispatcher-20261023@resus.local` (`DISPATCHER`) and `p2-driver-20261023@resus.local` (`DRIVER`). Random passwords are in the Git-ignored root `.env`; no credential values appear in this guide or tool output.

### Live verification

Run the non-mutating authentication and browser checks from `F:\minor`:

```powershell
$env:DEMO_AUTH_ONLY = 'true'
npm run demo:verify
Remove-Item Env:DEMO_AUTH_ONLY
```

Actual result: **23/23 PASS**, exit 0. The script used live WSL (`http://127.0.0.1:4000`) and Vite (`http://127.0.0.1:5173`) with installed headless Edge. It verified successful dispatcher/driver login, invalid-password rejection for both, JWT `/me` handling and expiry, role claims, anonymous/invalid-token handling, dispatcher dashboard access, driver dashboard denial and assignment access, denials across dispatcher/driver-only routes, and denial of an ADMIN-only route to the dispatcher. The browser rendered the sign-in form and error, authenticated the dispatcher live view, then authenticated the driver and visibly showed the expected 403 for operator-only dashboard data. Neither token was persisted in local or session storage.

Redacted output:

```text
PASS live backend health — HTTP 200, routes=71
PASS anonymous dashboard request rejected — HTTP 401
PASS invalid dispatcher password rejected — HTTP 401
PASS invalid driver password rejected — HTTP 401
PASS dispatcher authenticates with DISPATCHER role — HTTP 200
PASS driver authenticates with DRIVER role — HTTP 200
PASS dispatcher JWT session validated — HTTP 200
PASS driver JWT session validated — HTTP 200
PASS malformed JWT rejected — HTTP 401
PASS dispatcher dashboard read allowed — HTTP 200
PASS driver dashboard read denied — HTTP 403
PASS driver assignment read allowed — HTTP 200
PASS dispatcher admin-only grants read denied — HTTP 403
PASS driver dispatcher-only dispatch denied — HTTP 403
PASS dispatcher driver-only accept denied — HTTP 403
PASS both JWTs have a future expiry — token values suppressed
PASS browser loads the dashboard shell
PASS browser shows the rejected sign-in — Invalid email or password.
PASS browser authenticates against the listening backend
PASS token is not persisted in web storage — 0 entries
PASS dispatcher dashboard shell is visible
PASS driver login succeeds but dashboard data is role-denied — HTTP 403 shown
PASS driver token is not persisted in web storage — 0 entries
[demo-verify] 23/23 checks passed
```

Database counts before → after were emergencies `133 → 133`, transcripts `145 → 145`, system events `724 → 724`, call sessions `126 → 126`, and users `3 → 5`. The only database change was the two new active accounts; all three existing accounts remained active and unchanged. No operational records or authentication events were written. The dashboard keeps tokens in memory and clears its password state after login.

P2 is closed. This demonstrates software authentication and authorization only. After P2, the next roadmap task is P4: one controlled MicroSIP call proving caller audio → Whisper transcript → Module 5 progression → audible TTS → clean hangup. No P3, P4, or P5 work was started here.
