# RESUS — Pre-Hospital Emergency Response System (12 modules, integrated)

Call → Understand → Interact → Assist → Find help → Plan route → Prepare corridor → Coordinate → Store → Visualise.

**Runs on Windows with no Ubuntu/WSL, no Asterisk and no API keys.** The phone call happens in the browser at `/call`
(microphone + speech recognition + spoken replies). The Module 10 orchestrator then drives the whole response automatically.

> ⚠️ Research prototype. Protocol text is `UNREVIEWED` and must not be used for real emergencies.

## Quick start (Windows PowerShell, macOS or Linux)

Requires **Node.js 22+** (https://nodejs.org). Then, from the repository folder:

```bash
npm install
```

```bash
npm run dev:full
```

Then open:

| URL | What |
|---|---|
| http://localhost:4000/call | **Caller phone** (Chrome or Edge: allow microphone + location, press 📞 Call, and speak) |
| http://localhost:5173 | **Dispatcher dashboard** (login `operator@resus.local` / `ChangeMe!2024`) |
| http://localhost:4000/police | **Kerala Police Control Room console** (needs a POLICE_CONTROL_ROOM account, see below) |
| http://localhost:4000/api/health | Health check and mounted modules |

The first run creates `.env`, applies the database migrations and seeds 6 hospitals and 6 ambulances when the database is empty.

### Automated end-to-end test

With the system running, in a second terminal:

```bash
npm run test:e2e
```

The test places a call and follows it through every stage until `COMPLETED`. It prints the event timeline and exits with 0 on success.
Unit and integration tests:

```bash
npm test
```

## Sabarimala deployment

The region is configured in `packages/core/src/regions/sabarimala.ts`:

- **The whole pilgrim area, not only the Sannidhanam.** The gazetteer has about 40 landmarks with English and Malayalam names across every route:
  - Road approaches: Kottayam, Ponkunnam, Kanjirappally, Mundakayam, Erumely, Mukkoottuthara, Kanamala, Nilakkal, and Pathanamthitta via Ranni and Laha.
  - Nilakkal to Pampa: Attathode and Chalakayam.
  - Main trek: Pampa, Neelimala, Appachimedu, Sabari Peedam, Marakoottam, Saramkuthi, Sannidhanam.
  - Traditional forest path from Erumely: Perurthode, Kalaketty, Azhutha, Karimala, Valiyanavattam and the others along it.
  - Pullumedu route: Vandiperiyar, Sathram, Pullumedu, Uppupara.
- **Phone callers are located by what they say.** A caller with no GPS who says "near Appachimedu" or "അഴുത" is placed at that landmark. Mentions after "to / towards" are treated as destinations, not the caller's position. Later mentions are recorded as location candidates for an officer to confirm.
- **Seed data:** 13 hospitals and emergency medical centres and 19 ambulance posts along the routes, including off-road/stretcher units on the trek.
  **The coordinates are approximate and the list is a planning baseline.** Verify both with Kerala Police, the Health Department and the Travancore Devaswom Board before operational use.

### Many calls at the same time
- Every call is independent: its own case number, protocol session and ambulance.
- When all suitable units are busy, the emergency waits in a priority queue (CRITICAL first, then oldest). It is assigned automatically as soon as a unit becomes free.
- Verify on your machine with `npm run test:load` while the system is running (`LOAD_CALLS=50 npm run test:load` for more). With 30 simultaneous calls, all 30 completed and 5 of them waited in the queue.
- SQLite is fine for a pilot. For a large multi-site deployment move Module 11 to PostgreSQL.

### Case numbers and the Police Control Room
- Every call is allotted a case number such as `SBM-2026-000123`. It is shown on the caller page, so callers and officers can quote it.
- Officers use **http://<server>/police**. They see live calls (refreshed every 4 s), can search by case number, phone number or place, and can open the **complete record of any call at any time**. The record includes:
  - caller number and channel, location and landmark
  - full transcript and the system event timeline
  - ambulance assignment and GPS trail, hospital, routes and corridor
  - protocol sessions and location candidates
- Records can be exported as JSON.
- **Every access is written to an append-only audit table** (user, action, time, IP address). The database itself rejects any edit or delete of audit rows. The "Access log" button shows who has viewed a case.
- Create officer accounts. There is no self-registration, and a one-time strong password is printed:

```bash
npm run user:add -- --email si.pampa@keralapolice.gov.in --name "SI Pampa Control Room" --role POLICE_CONTROL_ROOM
```
```bash
npm run user:disable -- --email si.pampa@keralapolice.gov.in
```
```bash
npm run user:list
```

### Dedicated helpline number (Exotel)
1. Rent a virtual number from Exotel (KYC required). Create a call flow with the **Voicebot** applet pointing to
   `wss://<your-server>/telephony/exotel/stream?token=<EXOTEL_STREAM_TOKEN>`.
2. In `.env` set `EXOTEL_ENABLED=true` and set `EXOTEL_STREAM_TOKEN` to a random value of at least 24 characters.
3. Configure the offline speech engines: `SPEECH_PROVIDER=whisper` with `WHISPER_CPP_BINARY`/`WHISPER_CPP_MODEL`, and `SPEECH_SYNTHESIS_PROVIDER=espeak`. Both run natively on Windows.
4. The server must be reachable over HTTPS from the internet (for example a cloud VM or a reverse proxy).

Pilgrims dial the helpline. The caller's number is captured, which police and dispatchers see in full and other roles see masked. Their speech goes through the same pipeline as a web call.
**The Exotel message format follows their Voicebot/AgentStream protocol. Verify it against your account's documentation when the number is provisioned.**
Until then, use the browser call page `/call` (for example via QR codes on signboards along the route).

### Security measures
- Role-based access. Only `POLICE_CONTROL_ROOM` and `ADMIN` can read call records. Caller numbers are masked for other roles.
- Sign-in lockout after 5 failed attempts (15 min). Sign-ins and failures are audited. Police sessions sign out automatically after 15 min idle.
- Rate limits per IP (sign-in, opening calls, overall). Strict security headers and Content-Security-Policy on the console. API responses are never cached.
- The password-less developer token route is off unless `RESUS_DEV_TOOLS=true`, and always off in production.
- There is no default JWT secret. `npm run start:full` generates a strong one. Production refuses to start with a placeholder secret or `CORS_ORIGIN=*`.
- Web calls are protected by an unguessable id plus a per-call bearer token. The Exotel stream requires a shared secret token.

**Production checklist:**
- set `NODE_ENV=production` and serve over HTTPS (TLS) behind a reverse proxy with `TRUST_PROXY=true`
- change `SEED_OPERATOR_PASSWORD`, then create named officer accounts
- encrypt the disk or database at rest and take regular backups
- restrict server access to the police network or VPN, and keep the OS and Node updated
- run a security audit or penetration test before go-live

No system can honestly be called 100 % secure. These measures, plus a professional audit, are the responsible path.

## What happens on a call (module by module)

| # | Module | Implementation | During a call |
|---|---|---|---|
| 1 | Emergency call | `modules/module_01_emergency_call` + `apps/server/src/webcall` (browser `WEBRTC` transport) | Opens the call and the emergency at the caller's GPS location |
| 2 | Speech | Browser Web Speech API, or server **whisper.cpp** (`SPEECH_PROVIDER=whisper`) / **eSpeak NG** | Speech to text and text to speech |
| 3 | NLP / classification | Local LLM (Ollama) if running, otherwise the offline rule triage (`apps/server/src/orchestrator/triageClassifier.ts`, English, Malayalam and Hindi keywords). The optional Python service `modules/module3_emergency_nlp` is recorded as evidence when `MODULE3_NLP_ENABLED=true` | `EMERGENCY_CLASSIFIED` with type and severity |
| 4/5 | Conversation + protocols | `apps/server/src/conversation`, `modules/module_05_bystander_assistance` | Asks the next question or gives the next first-aid/CPR step |
| 6 | Ambulance | `modules/module_06_ambulance_management` | Assigns the nearest available unit carrying the required equipment (for example a defibrillator for cardiac arrest) |
| 7 | Hospital | `modules/module_07_hospital_intelligence` | Scores hospitals on capability, resources and distance |
| 8 | Route | `modules/module_08_route_optimization` (`mock`, `osrm` or `google`) | Response route and transport route with ETAs |
| 9 | Corridor | `modules/module_09_corridor_coordination` | Geofence corridor + simulated road-user/police notifications |
| 10 | Orchestrator | `apps/server/src/orchestrator/autonomousOrchestrator.ts` + lifecycle observer | Accepts offers for unstaffed crews, dispatches, drives the unit, records scene arrival, patient onboard, hospital arrival and completion |
| 11 | Database + events | `modules/module_11_database_event_system` (Prisma, SQLite by default, PostgreSQL optional) | Every step is an append-only event |
| 12 | Dashboard | `apps/dashboard` + `modules/module_12_dashboard_analytics` | Live map, status and analytics |

If an ambulance has a **driver account**, the driver accepts the offer in the driver app (`/driver`) and the phone reports real GPS.
Module 10 then only performs the dispatch step. Ambulances without a driver account are driven by the simulator.

## Optional upgrades (all native on Windows)

- **Better understanding (LLM):** install Ollama (https://ollama.com), then run `ollama pull qwen3:8b`. The system uses it automatically.
- **Offline server speech:** download a whisper.cpp Windows release and a model. Set `SPEECH_PROVIDER=whisper`, `WHISPER_CPP_BINARY`
  and `WHISPER_CPP_MODEL` in `.env`, then pick "Server Whisper" on the call page. Install eSpeak NG and set `SPEECH_SYNTHESIS_PROVIDER=espeak` for server voice.
- **Real road routes:** set `MODULE8_PROVIDER=osrm` (needs internet).
- **Real phone line (SIP/Asterisk):** still supported (`TRANSPORT_PROVIDER=asterisk`, see `docs/asterisk-setup.md`), but no longer required.

## Configuration

Everything is in `.env` (see `.env.example`). `npm run dev:full` turns on the automation switches
(`MODULE6_AUTO_DISPATCH_ENABLED`, `MODULE7_AUTO_SELECT_ENABLED`, `MODULE8_AUTO_ROUTE_ENABLED`, `MODULE9_CORRIDOR_ENABLED`,
`MODULE10_AUTONOMOUS_ENABLED`). Set `RESUS_FULL_AUTOMATION=false` to keep the manual dispatcher gates.
`npm run dev` starts the server with the manual gates, as before. To reset the database, run `npm run db:reset` and then `npm run db:seed`.

## Legacy prototypes

Standalone prototypes live under `modules/` (`module5`, `module_4`, `Module 8`, `module_9`, `Module_2_Zipped`, `Module 7_Zipped`) and at the root
(`app.py`, `engine.py`, `llm.py`, `models.py`). They are superseded by the integrated TypeScript modules above and are not part of the running system.
