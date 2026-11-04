# RESUS — Pre-Hospital Emergency Response System (12 modules, integrated)

Call → Understand → Interact → Assist → Find help → Plan route → Prepare corridor → Coordinate → Store → Visualise.

**Runs on Windows with no Ubuntu/WSL, no Asterisk and no API keys.** The phone call happens in the browser at `/call`
(microphone + speech recognition + spoken replies). The Module 10 orchestrator then drives the whole response automatically.

> ⚠️ Research prototype. Protocol text is `UNREVIEWED` and must not be used for real emergencies.

## Quick start (Windows PowerShell, macOS or Linux)

Requires **Node.js 20+** (https://nodejs.org). Then, from the repository folder:

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
