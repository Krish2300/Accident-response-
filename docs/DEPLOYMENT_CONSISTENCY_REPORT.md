# Deployment Consistency Report

**Date:** 2026-10-22
**Scope:** Reconcile the WSL deployment at `/home/resus/resus` with the intended full repository build at `F:\minor`, close the remaining live-audio validation gaps, and document the outcome.

This report is a **development / deployment artifact**. It does not claim production readiness, clinical validation, or medical-device status.

---

## 1. Baseline — repository versus WSL deployment (before reconciliation)

> This section records the **pre-deployment** state that motivated the work. §3 documents the reconciliation that has since been applied.

The WSL deployment was **not** the intended full build. It was a substantially older source snapshot (roughly the 2026-10-04…10-15 era) into which only the three conversation-defect fixes (Modules 2 and 5) had been synced. Everything else in WSL lagged the repository.

### 1.1 Composition root (`apps/server/src/app.ts`)

| | Full repository | WSL deployment |
| --- | --- | --- |
| Size | 426 lines | 228 lines (a minimal bootable reconstruction written during the prior session) |
| Modules composed | 1, 2, 5, 6, **7, 8, 9, 12**, **Module 10 observer**, **Module 3 nlp classifier**, **Module 4 `ConversationSupportAdapter`** | 1, 2, 5, 6, 11, 12 only |

The WSL `app.ts` deliberately omits Modules 3, 7, 8, 9, 10 and the Module 4 conversation layer because their source was absent from the WSL tree at the time. It also starts Asterisk **without** the `ConversationSupportAdapter` (the `conversation` port is optional in `startAsteriskRuntime`).

### 1.2 Module source directories

| Module | Repo directory | WSL directory | Status |
| --- | --- | --- | --- |
| 1 Emergency call | `module_01_emergency_call` | present, **`audioBridge.ts` differs** | behind |
| 2 Speech | `module_02_speech_processing` | present, identical (Defect 1 fix synced) | current |
| 3 NLP | `module3_emergency_nlp` (legacy dir) + `apps/server/src/nlp/` | legacy dir present; **`apps/server/src/nlp/` MISSING** | missing classifier |
| 4 Conversation | `apps/server/src/conversation/` (5 files) | only `protocolTurnOrchestrator.ts` | missing `conversationSupport.ts`, `index.ts`, `localizer.ts`, `timeoutPolicy.ts` |
| 5 Bystander | `module_05_bystander_assistance` | present, identical (Defect 2/3 fixes synced) | current |
| 6 Ambulance | `module_06_ambulance_management` | present, **`routes.ts`, `assignmentService.ts`, `config.ts`, `fleetService.ts` differ; `dispatch/` MISSING** | behind |
| 7 Hospital | `module_07_hospital_intelligence` (2.2 M) | **MISSING** (only legacy `Module 7_Zipped`) | missing |
| 8 Route | `module_08_route_optimization` (2.9 M) | **MISSING** (only legacy `Module 8`) | missing |
| 9 Corridor | `module_09_corridor_coordination` (2.9 M) | **MISSING** (only legacy `module_9`) | missing |
| 10 Lifecycle | `modules/module10/module10/src/lifecycle/` (observer, routes, mapper, reducer, types) | **`lifecycle/` MISSING**; `state/machine.ts`, `utils/logger.ts` differ | missing observer |
| 11 Database/events | `module_11_database_event_system` (19 src files) | 17 src files; **`notificationRepository.ts`, `learningSampleSeedPolicy.ts` MISSING**; 12 files differ | behind — **no `notifications` port** (Module 9 needs it) |
| 12 Dashboard | `module_12_dashboard_analytics` | present, **`routes.ts`, `config.ts`, `learningService.ts` differ** | behind |
| core | `packages/core/src` | present, **`enums.ts`, `events.ts`, `models.ts`, `providerPorts.ts` differ** | behind |

### 1.3 TypeScript path mappings (`tsconfig.json`)

The full repository maps `@resus/hospital`, `@resus/routing`, `@resus/corridor` to Modules 7/8/9. **WSL is missing all three**, so even if the module source were present the imports would not resolve.

### 1.4 Prisma schema and database

| | Full repository | WSL deployment |
| --- | --- | --- |
| Migrations on disk | 10 | 5 |
| Applied to `dev.db` | — | 5 (`init`, `append_only_event_log`, `module_07_08_09_entities`, `add_driver_assignment` ×2) |
| Pending | `outcome_history_foundation`, `outcome_correction_reason`, `outcome_review_reason`, `learning_sample_outcome_link`, `outcome_access_grants` | — |
| Generated client | has `OutcomeAssertion` etc. | does **not** have outcome-governance models |
| `dev.db` size | 602 KB (older) | **770 KB** (newer — holds this session's test data: `EMG-2D9A14E52D0001`, `CALL-36E41E7F530003`, transcripts) |

The repository's Module 11 source references `OutcomeRepository['recordAssertion']` / `recordReview`, so deploying the repo Module 11 **requires** the 5 pending migrations to be applied to the preserved `dev.db`.

### 1.5 Dependencies, protocols, toolchain

- `package.json`: **identical** — no new npm dependencies are needed.
- `modules/module_05_bystander_assistance/protocols/`: **identical** (5 protocols).
- `whisper-cli`: present at `/home/resus/whisper.cpp/build/bin/whisper-cli`.
- `espeak-ng`: present at `/usr/bin/espeak-ng`.
- `ffmpeg`: **not installed** (available via apt). Not required for the live AudioSocket path — Whisper consumes the raw PCM/wav the bridge produces; `ffmpeg` is only referenced for the HTTP audio-upload route's container conversion.
- `.env`: WSL copy (7 428 B) is **newer and carries the fixed AMI secret** plus the full Asterisk + Whisper/espeak configuration. The repo `.env` (4 089 B) is older and must **not** overwrite it.

### 1.6 Is the reduced deployment suitable only for telephony testing?

**Yes.** The reduced build (Modules 1/2/5/6/11/12) is sufficient for telephony conversation testing — the exact scope the earlier live MicroSIP calls exercised. It is **missing functionality required by the full prototype**:

- Module 7 — hospital suitability scoring, live resource tracking, auto-select.
- Module 8 — route planning, provider provenance, recalculation.
- Module 9 — simulated corridors, road-user geofence, police-notification records (needs Module 11's `notifications` port, which the old WSL Module 11 lacks).
- Module 10 — read-only lifecycle projection.
- Module 3 — operator-triggered NLP classification.
- Module 4 — conversation localisation + caller-silence retry around the live controller.
- Module 11 outcome governance — outcome assertions, reviews, access grants (backing the dashboard outcome UI).

`docs/FINAL_ACCEPTANCE_REPORT.md` confirms all twelve modules are part of the accepted prototype, so the reduced WSL tree is a **telephony-test subset**, not the intended build.

---

## 2. Chosen deployment strategy

**Deploy the actual repository build into WSL, preserving the WSL `.env` (AMI-secret fix, Asterisk/Whisper/espeak config) and `dev.db` (accumulated test data).** This removes the undocumented reconstructed `app.ts` in favour of the repository's own composition root.

### 2.1 What will be copied (repo → WSL)

- `packages/core/src/` (full — Modules 7/8/9 import from `@resus/core`).
- Every canonical `modules/*/src/` (01, 02, 05, 06, **07, 08, 09**, **module10/module10/src incl. `lifecycle/`**, 11, 12) plus each module's `prisma/schema.prisma` + `prisma/migrations/` + `protocols/`.
- `apps/server/src/` in full (the 426-line `app.ts`, `nlp/`, all five `conversation/` files, `asterisk/`, `config.ts`, `main.ts`, `http/`, `dev/`, `realtime/`).
- Root `tsconfig.json` (adds the three missing `@resus/*` path mappings).
- `package.json` (identical, no-op) and `vitest.config.ts`.

### 2.2 What will be preserved (never overwritten)

- `/home/resus/resus/.env` — carries the fixed 48-char `ASTERISK_AMI_SECRET` and the full telephony/speech configuration.
- `/home/resus/resus/modules/module_11_database_event_system/prisma/dev.db` — the live test database (770 KB, this session's emergencies/calls/transcripts).
- `node_modules/` — `package.json` is identical, so the installed tree already matches.
- Asterisk configuration (`/etc/asterisk/*`) and the MicroSIP configuration on Windows — external to the repo.

### 2.3 Backups (taken before any change)

Under `/home/resus/resus/.backup-<timestamp>/`:

- `app.ts` (the current minimal reconstruction)
- `tsconfig.json`
- `modules/module_11_database_event_system/src/` (full tree)
- `modules/module10/module10/src/` (full tree)
- `modules/module_11_database_event_system/prisma/dev.db` (database safety copy)
- `.env` (redundant safety copy — also left in place)
- `modules/module_01_emergency_call/src/`, `modules/module_06_ambulance_management/src/`, `modules/module_12_dashboard_analytics/src/`, `packages/core/src/` (the drifted trees)

### 2.4 Schema reconciliation (non-destructive)

The preserved `dev.db` has 5 migrations applied; the repository has 10. The 5 pending migrations are **additive** (they create the outcome-governance tables `OutcomeAssertion`, `OutcomeReview`, `EmergencyOutcomeGrant` and link columns; they do not drop or rewrite existing rows). They will be applied with `prisma migrate deploy`, which only runs forward migrations and preserves every existing row. `prisma generate` then regenerates the client to match.

### 2.5 Safety invariants held throughout

- No `git reset` / `clean` / `stash` / `commit` / `push` / branch switch.
- No database reset, drop, or destructive migration.
- Automatic dispatch stays disabled and fail-closed (`MODULE6_AUTO_DISPATCH_ENABLED=false`, Module 7 auto-select / Module 8 auto-route / Module 9 corridor all default-off, Module 12 learning disabled).
- No real emergency numbers; the live call uses local SIP extension 1001 only.
- No patient data; all calls are `isSimulation: true`.
- The AMI secret and SIP credentials are never printed or logged.

---

## 3. Execution results

### 3.1 Deployment applied

- **Backups first**, at `/home/resus/resus/.backup-20261022T082519Z/`: `app.ts`, `tsconfig.json`, `.env`, `modules/module_11_database_event_system/prisma/dev.db` (770 048 B), and the drifted `src` trees for Modules 1 / 6 / 11 / 12, Module 10 and `packages/core`.
- `rsync -a --delete` (excluding `node_modules`, `*.db`, `*.db-journal`) copied repo → WSL: `packages/`, `modules/`, `apps/server/`. A second pass added the repo's `tests/` (26 files, incl. `tests/helpers/isolatedTestDatabase.ts`), `scripts/` (5 files), `apps/dashboard/` (4 files) and the root `tsconfig.base.json`, `eslint.config.js`, `vitest.config.ts`. *(The first pass omitted `tests/`, which initially left `npm run typecheck` failing on a missing `isolatedTestDatabase` import — corrected.)*
- **Preserved, never overwritten:** `.env` (7 428 B — fixed AMI secret + Asterisk/Whisper/espeak config) and `modules/module_11_database_event_system/prisma/dev.db`.
- **Result:** composition root is now the repo's **426-line `app.ts`**; `tsconfig.json` carries the three previously-missing `@resus/hospital|routing|corridor` mappings (17 `module_*` paths total).
- **Schema:** `npx prisma generate` + `npx prisma migrate deploy` applied the 5 pending outcome-governance migrations (additive only). Prior rows preserved (106 emergencies / 99 call sessions / 125 transcripts at migration time); outcome tables created; generated client now exposes `OutcomeAssertion`.

### 3.2 Service boot verification

`GET /api/health` →

```json
{"status":"ok","env":"development","routes":71,
 "modules":["module_01","module_02","module_03","module_05","module_06","module_07",
            "module_08","module_09","module_10","module_11","module_12"], ...}
```

71 routes; every canonical module registered (module_04 is the in-server conversation layer, not a separate registered module). Module-specific routes present: hospital-selection, `routes/recalculate`, corridor, police-notifications, lifecycle, `dashboard/*`, `analytics/learning/*`, classify, outcomes/grants/reviews.

### 3.3 Modules 1 / 2 / 5 wiring verification

- **Module 1:** `{"provider":"asterisk","isLive":true,"reachable":true}`
- **Module 2:** `{"speech":{"provider":"whisper","isLive":true,"languages":["en","ml"]},"synthesis":{"provider":"espeak","isLive":true}}`
- **Module 5:** 5 protocols / 33 steps; `ProtocolTurnOrchestratorImpl` wired at `apps/server/src/app.ts:166`.

### 3.4 Controlled live-call evidence

Safety held throughout: every call `isSimulation: true`; signalling only local SIP extension **1001** (MicroSIP); dispatch / auto-select / auto-route stay fail-closed; no real emergency numbers; no patient data; AMI and SIP secrets never printed.

**Call 1 — outbound to a real MicroSIP softphone (full path).**
`POST /calls {callerId:"1001", incidentType:"CARDIAC_ARREST", isSimulation:true}` → 201 `CALL-F89765A2530003` / `EMG-0E836C90830001`. MicroSIP auto-answered; `PJSIP/1001-… Up AudioSocket(...)`; TCP ESTAB :9092; protocol `PSE-6F5297C1540006` CARDIAC_ARREST ACTIVE; step-1 TTS espeak `durationMs 8787` played to the phone; SYSTEM transcript row persisted; `POST /calls/:id/hangup` (`-d '{}'`) → ENDED `durationMs 101252`, `closed:true`; cleanup verified (0 channels, 0 legs, no :9092 sockets).

**Whisper defect found and fixed (Defect 4).** Before the fix, *every* transcription — API and live — returned `text:""`, `confidence:0.2` (NO_SCORE), `band:UNUSABLE`, `accepted:false`. **Root cause:** the provider invoked `whisper-cli … -oj`, and on the deployed build (whisper.cpp **1.9.5-dev**) plain `-oj` emits only `timestamps/offsets/text` — **no token probabilities, `avg_logprob`, or `no_speech_prob`** — so `parseWhisperJson` found the text but zero scores and always fell back to `NO_SCORE_CONFIDENCE` (0.2, below the discard threshold). **Fix** in `modules/module_02_speech_processing/src/providers/whisperProvider.ts`: request **`-ojf`** (`--output-json-full`), which emits `transcription[0].tokens[].p`, with an `-oj` retry for builds that predate `-ojf`. Verified: a clean 16 kHz JFK wav now transcribes to `confidence 0.911, band HIGH, accepted:true` and persists.

**Call 2 — inbound caller-sim playing real human speech (JFK recording).**
`channel originate Local/1000@resus-inbound application Playback rj` → `;1 Up Playback(rj)` + `;2 Up AudioSocket(…)`, TCP ESTAB :9092. Protocol `PSE-34A9E6836F000C` ACTIVE; step-1 TTS espeak `durationMs 12153`. Post-fix transcriptions **accepted**: `accepted:true, confidence:0.692, band:LOW, characters:25` and `accepted:true, confidence:0.599, band:LOW, characters:8` (no discards). Persisted **CALLER** rows: `"and so my fellow America."` (0.692) and `"ASK NOT!"` (0.599) — genuine fragments of the JFK recording. Module 5 re-prompted step 1 (the fragments contain no location — correct behaviour). Auto-hangup `durationMs 10984`; cleanup 0 channels / 0 sockets.

**Call 3 — inbound caller-sim stating an address (Module 5 advancement).**
`Playback addr` (espeak *"We are at 123 Main Street apartment four"* → 8 kHz + trailing silence) → accepted `confidence:0.784, band:HIGH, characters:38`. Transcripts:

1. `SYSTEM` — step 1 "Get the exact location first…"
2. `CALLER` — **"We are at 123 Main Street apartment 4."** (0.784)
3. `SYSTEM` — **"Check that the scene is safe for you before you go to the person…" (step 2)** — Module 5 advanced past step 1 (second TTS `durationMs 8001` ≠ step 1's `12153`).

Cleanup 0 channels / 0 sockets; `durationMs 10158`.

**Evidence split:** Calls 1–3 are **real-call** evidence. The `/speech/transcribe` HTTP probe is **API-level** evidence (isolates Whisper from telephony).

### 3.5 Test / typecheck / regression counts (intended build)

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` (`tsc --noEmit -p tsconfig.json`) | **PASS** — exit 0, no errors |
| Focused (whisper fix) | `npx vitest run modules/module_02_speech_processing` | **67 passed** (2 files), exit 0 |
| Full regression | see below | **764 passed / 66 skipped / 0 failed** (77 passed / 9 skipped files), 127.80 s |

Full-suite command (the telephony integration tests assert the repo's `loopback` defaults *and* bind their own AudioSocket, so the live service must be stopped and the live providers overridden):

```bash
sudo systemctl stop resus-server.service
TRANSPORT_PROVIDER=loopback SPEECH_PROVIDER=loopback SPEECH_SYNTHESIS_PROVIDER=loopback npx vitest run
sudo systemctl start resus-server.service   # restore deployed state
```

With the service stopped and default (loopback) providers → **764 passed / 66 skipped / 0 failed**. For contrast, running with the live `.env` active (asterisk/whisper/espeak + the service holding :9092) yields 746 passed / 6 failed / 78 skipped; those 6 are environment artifacts — `module01CallIntegration` asserts `transport: LOOPBACK` and `module02SpeechIntegration` needs port 9092 — not code defects. A `python` → `python3` symlink was added at `/usr/local/bin/python` because `tests/helpers/isolatedTestDatabase.ts` invokes `python`.

### 3.6 Remaining blockers / caveats

- **None blocking the telephony conversation path** — inbound/outbound audio, Whisper recognition of real speech, transcript persistence, Module 5 advancement, TTS, and hangup/cleanup are all demonstrated above.
- **Inbound human microphone not exercised:** Call 1's *outbound* leg to a real MicroSIP softphone was live, but the *inbound* caller direction was fed by recorded/synthesised audio (JFK / espeak) played through an Asterisk Local channel rather than a second live human microphone. The recognition itself is of real human speech (JFK) and of a synthesised address.
- **Ollama `qwen3:8b` not pulled** → NLP classification logs `primary LLM provider unavailable` and falls back to the heuristic classifier (expected degraded mode; not a telephony blocker).
- **ffmpeg not installed** → affects only the HTTP audio-upload container-conversion path; the live AudioSocket path does not use it.
- This document makes **no** production, clinical, or medical-device claims.

---

## 4. Safe demo instructions

### 4.1 Preconditions — WSL lifecycle (root-caused and fixed 2026-10-23, audit blocker P1)

**Root cause — two independent layers. The systemd unit itself is healthy** (`Type=simple`, `Restart=on-failure`, `RestartSec=3`; it exits 0 on SIGTERM, so `on-failure` correctly does not restart it; asterisk likewise):

| Layer | What happens without the fix | Evidence (2026-10-23) | Fix |
| --- | --- | --- | --- |
| **A — VM lifetime** | WSL2 terminates the VM seconds after the last console session exits (default idle timeout). systemd then runs an orderly poweroff and SIGTERMs `resus-server.service`. The next `wsl` command cold-boots a fresh VM where the enabled units start again — the observed "SIGTERM ~15 s after ready" was simply one interactive batch's wall-clock. | `journalctl --list-boots`: dozens of 15 s–2 min boots; boot −1 tail: `Reached target poweroff.target` → `Shutting down` → `Journal stopped`; server log: `received signal SIGTERM` → `Deactivated successfully` (exit 0) | `vmIdleTimeout=-1` under `[wsl2]` in `C:\Users\sanja\.wslconfig` (applied 2026-10-23; verified: kernel boot time continuous across >12 min idle) |
| **B — Windows→WSL relay** | With Layer A fixed the VM stays up, but WslService still marks the distro "Stopped" ~after the last session exits and tears down the mirrored-mode localhost relay. Windows `curl http://127.0.0.1:4000` then fails although the server answers inside the VM. Re-attaching any session restores the relay instantly. | after 90 s idle without a session: Windows curl exit 7 + `wsl -l -v` reports `Stopped`, yet `uptime -s` shows the same kernel boot; with one attached session: HTTP 200 | hold **one attached session** for the whole demo — a hidden `wsl -d Ubuntu -- sleep infinity` process on Windows |

The previous in-VM `nohup sleep infinity &` keeper (this report's earlier text, telephony report §3/§8) is **superseded**: it kept the VM alive (Layer A) but not the Windows→WSL relay (Layer B).

**The `.wslconfig` change (one line; already applied on this machine):**

- File `C:\Users\sanja\.wslconfig`, section `[wsl2]`, key `vmIdleTimeout=-1`.
- **Lifecycle:** read at VM boot; takes effect after `wsl --shutdown` / `wsl --terminate` and the next start; the setting persists across Windows reboots, but the VM does not — it must be started again (by design; nothing auto-starts on login).
- **Permissions:** ordinary per-user file, no administrator rights to edit; `wsl --terminate` / `wsl --shutdown` need no admin. The keeper runs as the current Windows user and, inside the distro, as the default user `resus` (a plain `sleep`, no privileges).
- **Shutdown behaviour:** `wsl --terminate Ubuntu` ends the keeper session and the VM; systemd stops `resus-server` and `asterisk` cleanly (orderly poweroff, SQLite durable). Windows logoff or reboot also ends the VM.

**Start (PowerShell):**

```powershell
# 1. Keeper: one attached session keeps the distro "Running" and the relay registered
Start-Process wsl.exe -ArgumentList "-d","Ubuntu","--","sleep","infinity" -WindowStyle Hidden
Start-Sleep -Seconds 14    # VM boot; systemd auto-starts asterisk + resus-server (both enabled)

# 2. Health gate — all three must succeed before the demo proceeds
curl.exe -s http://127.0.0.1:4000/api/health              # expect "status":"ok", routes:71
curl.exe -s http://127.0.0.1:4000/calls/transport/status  # expect asterisk isLive:true reachable:true
curl.exe -s http://127.0.0.1:4000/speech/status           # expect whisper + espeak isLive:true
```

**Stop (PowerShell):**

```powershell
wsl --terminate Ubuntu    # keeper session + VM + services, orderly
```

**Troubleshooting:**

| Symptom | Cause | Action |
| --- | --- | --- |
| Windows curl exit 7 (cannot connect) | keeper died → distro marked "Stopped" → relay torn down | re-run the Start block; `wsl -l -v` must show `Running` |
| Distro `Running` but health fails | service crash inside the VM | inside: `systemctl is-active resus-server.service asterisk.service`; `sudo journalctl -u resus-server.service -b` |
| Services not auto-started | unit disabled | inside: `sudo systemctl enable --now resus-server.service asterisk.service` |
| After a Windows reboot | VM does not auto-start (by design) | re-run the Start block |
| `vmIdleTimeout=-1` line removed | Layer A returns: services reaped seconds after every batch | restore the line, then `wsl --shutdown` |

- MicroSIP on Windows with `autoAnswer=all`, registered to Asterisk extension **1001**.
- Optional caller-sim sounds in `/usr/share/asterisk/sounds/`: `rj.wav` (JFK, 8 kHz) and `addr.wav`.

### 4.2 Outbound controlled call (Call 1)

```bash
TOKEN=$(curl -s -X POST localhost:4000/api/auth/dev-token -H 'Content-Type: application/json' \
  -d '{"email":"operator@resus.dev","role":"OPERATOR"}' | grep -oE '"token":"[^"]*"' | cut -d'"' -f4)

curl -s -X POST localhost:4000/calls -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"callerId":"1001","latitude":12.9716,"longitude":77.5946,"incidentType":"CARDIAC_ARREST","isSimulation":true}'
# MicroSIP auto-answers; watch for AudioSocket + TTS, then hang up:
curl -s -X POST localhost:4000/calls/<CALL-ID>/hangup -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}'
```

### 4.3 Inbound caller-sim with real speech (Calls 2–3)

```bash
sudo asterisk -rx "channel originate Local/1000@resus-inbound application Playback rj"    # JFK  -> CALLER rows
sudo asterisk -rx "channel originate Local/1000@resus-inbound application Playback addr"  # address -> Module 5 step 2

# verify persisted transcripts:
curl -s -H "Authorization: Bearer $TOKEN" localhost:4000/api/emergencies/<EMG>/transcripts
# log evidence:
sudo journalctl -u resus-server.service --since '2 minutes ago' \
  | grep -E 'transcribed a caller|spoke a protocol|started a protocol'
```

### 4.4 Regression

Use the exact commands in §3.5 (service stopped + loopback providers).

### 4.5 Safety reminders

Keep `isSimulation: true`; SIP extension 1001 only; dispatch stays fail-closed; never print the AMI/SIP secrets. This is a development demo — no production or clinical claims.
