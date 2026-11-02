# Telephony Integration Test Report (Phase 3–4)

**Date:** 2026-10-21; controlled P4 retests: 2026-10-23
**Verdict:** Historical 2026-10-21 call passed its documented checks. The latest controlled P4 call on 2026-10-23 **FAILED acceptance**: live SIP/RTP/AudioSocket operated, but the requested phrase was not recognized and Module 5 escalated after blank/incorrect utterances. MicroSIP audibility remains **BLOCKED pending user confirmation**, and protocol-session cleanup did not occur. See §13.

---

## 1. Executive Summary

A controlled local test call through the RESUS server → Asterisk → MicroSIP path was completed end-to-end. The call was originated via `POST /calls`, auto-answered by MicroSIP, bridged over AudioSocket with greeting audio and a protocol session, and cleanly torn down via authenticated `POST /calls/:id/hangup`. Duration recorded: 145 231 ms. All gates passed (typecheck clean, module_01 vitest 85/85, no repo edits).

## 2. Root Cause (layered)

| # | Layer | Root cause | Fix |
|---|-------|-----------|-----|
| 1 | Network | WSL2 `networkingMode=mirrored` drops Windows→WSL packets to WSL services bound `127.0.0.1` and Windows-LAN-IP; WSL→Windows works only when receiver binds `0.0.0.0` | Run the server **inside WSL** (existing `resus-server.service` at `/home/resus/resus`); use loopback for SIP (MicroSIP binds `0.0.0.0` on Windows) |
| 2 | SIP | MicroSIP registered against LAN IP unreachable from WSL | `microsip.ini`: `server=127.0.0.1`, `domain=127.0.0.1`, `publicAddr=127.0.0.1` |
| 3 | AMI | Server ran on Windows; AMI bound `127.0.0.1:5038` inside WSL — unreachable across the mirrored boundary | Server moved into WSL (no code change) |
| 4 | AMI auth | `/home/resus/resus/.env` had a 16-char secret; `manager.conf` `[resus]` had the real 48-char secret → `Authentication failed`, service crash-looped (restart counter 102+) | Secret replaced in `.env` from `manager.conf` (never printed); backup taken |
| 5 | PJSIP | AOR `max_contacts=1`; each MicroSIP restart left a stale contact → Asterisk INVITEed a dead port (`Down` state) | `max_contacts=2`; wait for natural expiry (~90 s) after restarts |
| 6 | MicroSIP AA | `autoAnswer=1` is **not a valid value**. Source (`on_incoming_call`): only `"all"`, `"button"`, `"header"` are recognised. `"1"` silently disables auto-answer | `autoAnswer=all` in `microsip.ini` |
| 7 | AMI Originate | `asteriskProvider.originate()` waits for `Event: OriginateResponse` with matching `ActionID`. Asterisk sends this only when the callee **answers or fails** — never while merely ringing. With no answer, the 10 s `ASTERISK_AMI_ACTION_TIMEOUT_MS` fires → `PROVIDER_UNAVAILABLE` | Resolved by making the callee actually answer (fix #6) |

## 3. Changes Made (all external — no repo edits)

| File | Change | Backup |
|------|--------|--------|
| `C:\Users\sanja\AppData\Roaming\MicroSIP\microsip.ini` | `server/domain/publicAddr=127.0.0.1`; `autoAnswer=all`; `autoAnswerCalls=*`; `autoAnswerDelay=0` | `.bak.20261021T141155Z`, `.bak.autoanswer.20261021T222204Z`, `.bak.aa-all.20261021T225836Z` |
| `/etc/asterisk/pjsip.conf` (WSL) | AOR 1001 `max_contacts=1` → `2` | `.bak.20261021T143637Z` |
| `/home/resus/resus/.env` (WSL) | `ASTERISK_AMI_SECRET` replaced with the value from `manager.conf` `[resus]` | `.env.bak.ami-fix.<ts>` |
| (process) | Started `nohup sleep infinity` (PID 568) in WSL to keep the distro alive across `wsl` invocations | — |

**Untouched:** `F:\minor` git working tree (135 pre-existing porcelain entries unchanged), `manager.conf`, Asterisk dialplan, server source.

## 4. E2E Test Evidence (captured 2026-10-21 17:29–17:32 UTC)

### 4.1 Call open
```
POST /calls  →  201
{
  "emergency": { "id": "EMG-02396FB2B10010", "incidentType": "CARDIAC_ARREST", "isSimulation": true },
  "session":   { "id": "CALL-3D3DA1EA450012", "status": "ACTIVE", "startedAt": "2026-10-21T17:29:34.213Z" },
  "isLiveTransport": true, "provider": "asterisk", "transport": "SIP"
}
```

### 4.2 Channel + AudioSocket
```
PJSIP/1001-00000007    s@resus:3    Up    AudioSocket(f7f70980-ecf0-401e-...)
ss: ESTAB 127.0.0.1:9092 ↔ 127.0.0.1:44794  users:(("node",pid=5183,fd=42))
module show like audiosocket: app_audiosocket.so Use Count 1 Running
```

### 4.3 Server log sequence
```
17:29:34  originated an Asterisk call leg          channel=PJSIP/1001-00000007 uuid=f7f70980-…
17:29:34  AudioSocket channel connected            remote=127.0.0.1:44794
17:29:34  emergency call opened                    transport=SIP provider=asterisk isLiveTransport=true
17:29:34  Asterisk media stream bound to a call session
17:29:34  started a protocol session               PSE-FBD682A95B0015  CARDIAC_ARREST
17:29:34  spoke a protocol instruction             provider=espeak  durationMs=8787
17:31:59  Asterisk media stream ended
17:31:59  emergency call closed                    durationMs=145231
```

### 4.4 Hangup
```
POST /calls/CALL-3D3DA1EA450012/hangup   Authorization: Bearer <dev-token>
→ {"session":{"status":"ENDED","endedAt":"2026-10-21T17:31:59.444Z"},"durationMs":145231,"closed":true}
```

### 4.5 Teardown verification
```
core show channels | grep pjsip  →  (none)
ss | grep 9092                   →  (none)
GET /calls/transport/status      →  {"provider":"asterisk","isLive":true,"reachable":true,
                                     "detail":"Asterisk AMI reachable; 0 call leg(s) tracked."}
```

## 5. Gates

| Gate | Result |
|------|--------|
| `npm run typecheck` | Clean |
| `npx vitest run modules/module_01_emergency_call` | **85 passed** (4 files) |
| `git diff --check` | Clean (only pre-existing LF/CRLF warnings) |
| Repo edits this session | **0** |

## 6. Safe Start / Stop Procedure

### Start
```powershell
# 1. Ensure WSL is running (or start it via any wsl command)
wsl -d Ubuntu -e bash -c "echo ok"

# 2. Asterisk (inside WSL)
wsl -d Ubuntu -e bash -c "sudo -n asterisk"

# 3. RESUS server (inside WSL)
wsl -d Ubuntu -e bash -c "sudo -n systemctl start resus-server.service"

# 4. MicroSIP (on Windows)
Start-Process -FilePath "F:\minor\MicroSIP\MicroSIP.exe"
```

### Verify ready
```bash
# Inside WSL
curl -s http://127.0.0.1:4000/calls/transport/status
# Expect: {"provider":"asterisk","isLive":true,"reachable":true,...}

sudo -n asterisk -rx "pjsip show contacts"
# Expect: 1001 … Avail
```

### Test call
```bash
curl -s -X POST http://127.0.0.1:4000/calls \
  -H "Content-Type: application/json" \
  -d '{"callerId":"1001","latitude":12.9716,"longitude":77.5946,
       "incidentType":"CARDIAC_ARREST","isSimulation":true}'
```

### Stop
```powershell
# MicroSIP
Get-Process -Name MicroSIP -ErrorAction SilentlyContinue | Stop-Process -Force
# Server
wsl -d Ubuntu -e bash -c "sudo -n systemctl stop resus-server.service"
# Asterisk
wsl -d Ubuntu -e bash -c "sudo -n asterisk -rx 'core stop now'"
```

## 7. Security Notes

- **SIP credentials** (`1001` / `resus-emergency`) are development-only; rotate before any shared or networked use.
- **AMI secret** (48 chars, `[resus]` in `manager.conf`) is bound to `127.0.0.1:5038` — never exposed beyond loopback. It was read programmatically for the `.env` fix and never printed or logged.
- **`pjsip set logger`** may still be enabled from earlier debugging — disable after testing: `asterisk -rx "pjsip set logger off"`.
- **Dev-token route** (`POST /api/auth/dev-token`) is gated by `NODE_ENV=development`; it returns 404 in production.
- **No real emergency numbers** were dialled; all calls used local extension 1001.
- **Auto-answer** (`autoAnswer=all`) is appropriate for the controlled prototype only; production deployments should use `"header"` mode (requires `Call-Info: Auto Answer` or `X-AUTOANSWER: TRUE` SIP header).

## 8. Known Limitations / Blockers (documented, not blocking)

- **LLM provider unavailable** during the test: `ollama pull qwen3:8b` not run. The protocol session fell back to `espeak` for the greeting (expected in this environment).
- **WSL lifecycle (remediated 2026-10-23)**: root-caused as two layers — WSL VM idle-termination after the last session (systemd then poweroffs and SIGTERMs the service cleanly) and WslService tearing down the Windows→WSL relay once the distro is marked "Stopped". Fixed via `vmIdleTimeout=-1` in `C:\Users\sanja\.wslconfig` plus one attached keeper session; verified 90 s idle persistence and Windows health probes. The in-VM `nohup sleep infinity` keeper referenced in §3 is superseded (it held the VM but not the relay). Current start/stop/troubleshooting commands: `docs/DEPLOYMENT_CONSISTENCY_REPORT.md` §4.1.
- **Stale PJSIP contacts** after MicroSIP restarts expire naturally (~90–120 s); Asterisk 22 has no CLI command to remove a contact manually.
- **OriginateResponse semantics**: the provider correctly waits for call completion (answer/fail), not merely queueing. Any future automated test must ensure the callee answers within `ASTERISK_AMI_ACTION_TIMEOUT_MS` (currently 10 000 ms).

## 9. Artifacts

- Helper scripts: `C:\Users\sanja\AppData\Local\Temp\opencode\` (`test_call_autoanswer.sh`, `hangup_with_token.sh`, `capture_evidence_hangup.sh`, `call_body.json`, …)
- Config backups: listed in §3
- Server journal: `sudo -n journalctl -u resus-server.service`
- This report: `F:\minor\docs\TELEPHONY_E2E_TEST_REPORT.md`

## 10. Fresh P4 MicroSIP acceptance run (2026-10-23)

**Result: PARTIAL / FAILED ACCEPTANCE.** This run used the live WSL backend and the already-running local MicroSIP client, not `demo:server`. No code, dependency, or telephony configuration was changed. The test utterances were synthetic and played through the workstation's default audio output; no transcript text was posted or injected.

### Readiness and pre-call state

| Check | Actual result |
|---|---|
| Git state before test | Branch `main`; 150 porcelain entries; 0 staged. Existing edits and untracked files were preserved. |
| WSL / keeper | Ubuntu Running (WSL 2); existing `sleep infinity` keeper present. |
| Services | `resus-server.service=active`; `asterisk.service=active`. |
| Backend health | Windows and WSL health gates HTTP 200; `status=ok`, `routes=71`. |
| Speech providers | `/speech/status` HTTP 200; Whisper and eSpeak report `isLive=true`; `/usr/bin/espeak-ng` exists in WSL. |
| Asterisk / AudioSocket | AMI reachable; AudioSocket listener on `0.0.0.0:9092`; `app_audiosocket.so` and supporting modules loaded. Before the call: 0 channels and 0 tracked call legs. |
| MicroSIP | Process running; extension 1001 contact registered; `autoAnswer=all`; call was answered. Input/output device settings were blank, so MicroSIP used Windows defaults. The host exposes a Realtek microphone array and speakers. |
| Safety | No Module 6–9 enable flags were present in the deployment `.env`; existing fail-closed defaults were retained. |

Read-only database baseline: `emergencies=133`, `call_sessions=126`, `transcripts=145`, `protocol_sessions=19`, `protocol_steps=27`, `system_events=724`.

### Fresh call and live evidence

One call was opened at `2026-10-23 08:33:36.833 UTC` using `POST /calls` with `callerId=1001`, `incidentType=CARDIAC_ARREST`, `isSimulation=true`, and synthetic coordinates `(0,0)`. The backend returned `provider=asterisk`, `transport=SIP`, `isLiveTransport=true`, and an ACTIVE call session `CALL-0DFE5A8D11000A` linked to `EMG-ED99C6CA690008`.

Redacted live server journal evidence:

```text
originated an Asterisk call leg  callSessionId=CALL-0DFE5A8D11000A channel=PJSIP/1001-00000000
AudioSocket channel connected    remote=127.0.0.1:<ephemeral>
Asterisk media stream bound to a call session  callSessionId=CALL-0DFE5A8D11000A
started a protocol session       protocolSessionId=PSE-386E4CA0ED000D status=ACTIVE
spoke a protocol instruction to the caller  provider=espeak durationMs=8787
transcribed a caller utterance from the live call  provider=whisper accepted=true confidence=0.787992 characters=13
spoke a protocol instruction to the caller  provider=espeak durationMs=11277
```

Two generated synthetic audio files were played via `ffplay` to the Windows default output while this MicroSIP call was active. The second contained: “One two three. This is a synthetic demonstration. The person is unconscious and is not breathing normally. They are on the floor.” Whisper did **not** return that utterance. It persisted `[BLANK_AUDIO]`; despite the provider's `accepted=true` and high confidence value, this is not a usable transcript. The first synthetic sentence also produced no usable caller text. Thus actual caller speech into Whisper is **FAILED / UNVERIFIED** for this run; audio delivery at the workstation output and acoustic pickup by MicroSIP were not proven by the `ffplay` exit status.

The Module 5 protocol session `PSE-386E4CA0ED000D` started at `confirm-arrest`, then remained `WAITING_FOR_RESPONSE` at `confirm-arrest`, with `clarificationCount=1`. It did not advance from a recognized synthetic utterance. Database transcript rows for this call are in correct sequence order:

```text
1 SYSTEM  Shout for help, then check whether the person is unresponsive and not breathing normally. …
2 CALLER  [BLANK_AUDIO]  confidence=0.78799225
3 SYSTEM  Shout for help, then check whether the person is unresponsive? …
```

The two eSpeak instruction records show that speech was synthesized and sent through the live AudioSocket path. There was no MicroSIP output loopback recording or independent listener confirmation, so TTS being **actually audible at the MicroSIP client is UNVERIFIED**.

### Hangup, cleanup, and database result

The Asterisk channel was explicitly requested to hang up with `channel request hangup PJSIP/1001-00000000`. The server logged `Asterisk media stream ended` and `emergency call closed`. The call row is `ENDED` (started `08:33:37.731 UTC`, ended `08:36:11.216 UTC`, duration 153,485 ms). After hangup, Asterisk reported no active channels and `ss -Htnp state established '( sport = :9092 )'` returned 0 AudioSocket TCP connections. The AMI adapter status still reported one tracked call-leg entry; its `hungUp` retention cache is not a live Asterisk channel or socket. The protocol session remained waiting for a response; no neutral media-hangup cancellation was performed because the available Module 5 cancel action is documented as “professional help has arrived.” Protocol-session closure is therefore **UNVERIFIED / INCOMPLETE**.

Post-call read-only counts: `emergencies=134`, `call_sessions=127`, `transcripts=148`, `protocol_sessions=20`, `protocol_steps=28`, `system_events=739`. The deltas include the one synthetic call and its protocol/transcript records; no rows were reset or deleted. Each of the three transcript rows for the test belongs to `CALL-0DFE5A8D11000A`; no transcript from another call was attached to it.

During the same interval, a separate pre-existing simulated call `CALL-5F50FCE7270003` (started `08:03:21.596 UTC`) transitioned to `ENDED` at `08:33:44.362 UTC`. It was not initiated or hung up by this P4 procedure; the cause was not established. This is an incidental state change and is recorded for review.

### Commands and remaining blocker

Checks executed: `git status --short --branch`; `wsl -l -v`; `systemctl is-active resus-server.service asterisk.service`; HTTP GETs to `/api/health`, `/calls/transport/status`, and `/speech/status`; `asterisk -rx "pjsip show contacts"`, `"core show channels concise"`, and `"module show like audiosocket"`; read-only SQLite count/row queries; and filtered `journalctl -u resus-server.service` for the test call. No tests were run because no code changed.

**Next P4 step:** verify MicroSIP's actual microphone and speaker routing with a controlled synthetic acoustic source and capture the client output (or have an authorized local listener confirm it). Then repeat one fresh call and verify Whisper returns the intended utterance, Module 5 moves beyond `confirm-arrest`, TTS is audible, and the protocol session closes through a semantically appropriate supported path. Do not claim full audio acceptance until each is evidenced. No P3 or P5 work was started.

## 11. P4 audio-path diagnosis (2026-10-23)

This was a read-only diagnosis of the prior failed live-WSL call. No settings, code, services, database records, or call state were changed, and no new call was placed. Results below distinguish current-state checks from evidence that was not retained during the original call.

### Client device routing

The local MicroSIP profile was inspected without exposing credentials. Per-application `audioInputDevice` and `audioOutputDevice` are both blank, so MicroSIP follows the Windows default devices. Its configured codec list is `PCMA/8000/1 PCMU/8000/1`, input/output volume are 100, VAD is off, echo cancellation is on, and single-call mode is on. These are configuration observations, not proof of the historical negotiated codec.

Read-only Windows Core Audio inspection found the default playback endpoint was `HDMI (NVIDIA High Definition Audio)` with mute off and volume 0.940. The default capture endpoint was `Microphone Array (Realtek(R) Audio)` with mute off and volume 1.000. Microphone privacy access was allowed. Realtek speakers and Epson projection audio endpoints were also present, but the inspection cannot establish which endpoint is physically connected to an audible speaker. The prior synthetic clips were played to the Windows default output; no contemporaneous capture proved that the sound reached the selected microphone. The combination of an implicit HDMI playback route, Realtek capture, and echo cancellation enabled is the most likely acoustic-path mismatch, but remains a **probable cause, not a confirmed root cause**. No local audio recording, input loopback, or user/listener confirmation is available.

MicroSIP's documented codec list and Asterisk endpoint configuration overlap on G.711 PCMA/PCMU at 8 kHz mono. Asterisk endpoint `1001` currently permits `ulaw|alaw`; however, there was no active channel when inspected and `pjsip show channelstats` returned “No objects found.” The historical channel's negotiated codec, SDP, and RTP counters were not retained, so exact negotiation and RTP packet/byte/loss statistics are **UNVERIFIED**. Current registration/contact state is not evidence of an active media path.

### AudioSocket receive and Whisper boundary

The parser expects AudioSocket PCM frames and represents caller audio as mono signed 16-bit little-endian PCM. The `0x10` frame type is 8 kHz signed-linear PCM; other sample-rate frame types are supported. Utterance assembly computes RMS and compares it with the configured speech threshold, but this path does not log per-frame payload length, sample rate, channel count, RMS, peak, or aggregate utterance metrics, and does not retain raw audio. No such measurements can be recovered from the prior call.

For the test call, the live Whisper transcription event and persisted `[BLANK_AUDIO]` row show that an utterance reached the transcription/persistence path; the adapter's finalization path requires at least one frame to meet its RMS threshold. That is an inference from code flow, not proof of intelligible caller speech. Whisper produced no usable words, so successful microphone capture of the intended utterance is **FAILED**. No mismatched-sample-rate warning was found for the call UUID in the available service journal, but absence of that warning does not establish frame integrity or audio content.

### Outgoing eSpeak and client rendering

The live call logged two eSpeak instructions (`durationMs=8787` and `11277`). The inspected provider converts eSpeak WAV output (22.05 kHz) to mono signed-linear 16-bit PCM at 8 kHz. AudioSocket output uses type `0x10`, 320-byte PCM payloads (160 samples, 20 ms) paced at 20 ms. The live journal's “spoke a protocol instruction” records establish synthesis and a send attempt on the connected AudioSocket. There are no per-frame send-byte/acknowledgement counters or endpoint-render metrics. No MicroSIP recording, loopback capture, or listener confirmation was made. Thus TTS generation/format conversion and transport send attempt are **OBSERVED**, while receipt, decode/render, and audibility at MicroSIP are **UNVERIFIED**.

### Hangup, protocol state, and call-leg bookkeeping

At diagnosis time Asterisk had no active channels and the AudioSocket listener had zero established connections. The previous call's retained AMI call-leg count is an in-memory bookkeeping record; Asterisk's channel and socket observations show it was not a live channel/socket. In the audio bridge close path, the UUID mapping and conversation-controller per-call mapping are deleted, pending silence timers are cleared, and the conversation controller's `forget(callSessionId)` removes its per-call map entry. This does not close or cancel the persistent Module 5 protocol session. The controller has no neutral call-ended/caller-hangup transition; the available protocol cancel action has different semantics. The remaining `WAITING_FOR_RESPONSE` protocol row is therefore a **real incomplete protocol lifecycle**, not evidence of an open media resource.

The separate simulated call `CALL-5F50FCE7270003` ended at `08:33:44.362 UTC`, during the live-call interval. The available correlation shows its own earlier start and an end event, but no explicit reason/actor tying that transition to the P4 call. Its termination cause remains **UNKNOWN** and is not attributed to this test.

### Diagnosis and next action

Most likely audio blocker: MicroSIP did not have explicit device selections; Windows routed playback to the NVIDIA HDMI endpoint while capture used the Realtek microphone array. The synthetic sound's acoustic arrival at that mic is unproven, and echo cancellation was enabled. This is consistent with Whisper's blank result, but cannot be confirmed without observing the client path.

Before another call, open **MicroSIP → Settings → Audio** and explicitly select the microphone physically used for the test (the observed `Microphone Array (Realtek(R) Audio)` if that is the intended mic) and the playback endpoint physically connected to the test speaker/headset. In **Windows Settings → System → Sound**, select the same intended input/output devices, confirm their levels are nonzero and neither is muted, and keep microphone privacy access enabled. Do not assume the HDMI endpoint is audible; select it only if the physical playback device is actually connected there. Keep the existing codec list and safety settings unchanged. If negotiated-codec display is needed, MicroSIP's documentation says codec visibility can be enabled by disabling single-call mode; alternatively collect live Asterisk channel statistics during the next call. Do not change this setting solely for diagnosis without deciding it is needed.

After the device selection has been checked and confirmed, the next specific test is one short controlled call with a person speaking a harmless synthetic phrase into that microphone (no injected text and no speaker-played clip as a substitute), while capturing live Asterisk RTP statistics and AudioSocket frame count/size/rate/RMS/peak at the actual receive boundary. Separately record or have an authorized listener confirm the TTS at the MicroSIP client. Verify transcript ordering, Module 5 state, hangup, and zero active channels/sockets afterward. Do not place that follow-up call until the device routing has been confirmed. The Module 5 neutral-hangup lifecycle gap remains separate from the acoustic diagnosis and requires a supported lifecycle design before it can be closed.

No code, device settings, database content, or services were changed during the diagnosis. No tests were run. Controlled retest preflight results are recorded in §12. P3 and P5 were not started.

## 12. Controlled P4 retest preflight (2026-10-23)

**Retest result: BLOCKED before call setup pending user audio-device confirmation.** This was read-only preflight. No call was initiated, no transcript was injected, and no audio settings were changed. The prior call results in §10 remain historical evidence and are not retest results.

| Preflight check | Actual result |
|---|---|
| Repository preservation | `main...origin/master`; the existing modified and untracked worktree files remain present. No branch, reset, cleanup, commit, or push action was taken. |
| WSL / keeper | Ubuntu was `Running` (WSL 2); existing `sleep infinity` process was present. |
| Backend | `resus-server.service` active; `GET /api/health` HTTP 200 with `status=ok`, `routes=71`. |
| Asterisk / transport | `asterisk.service` active; `GET /calls/transport/status` HTTP 200, `provider=asterisk`, `isLive=true`, `reachable=true`; status reports 1 tracked call leg. |
| Channel and AudioSocket | Asterisk reported `0 active channels`, `0 active calls`; established TCP connections on port 9092: 0. Listener is bound on `0.0.0.0:9092`; AudioSocket modules are loaded. |
| Extension / MicroSIP | Contact `1001` exists (`NonQual`, qualification disabled); MicroSIP process is running and responsive. |
| Speech providers | `GET /speech/status` HTTP 200; Whisper and eSpeak both `isLive=true` for `en` and `ml`. |
| MicroSIP device configuration | Profile still has blank `audioInputDevice` and `audioOutputDevice`, codecs `PCMA/8000/1 PCMU/8000/1`, VAD off, echo cancellation on, single-call mode on, input/output volume 100. These values do not establish the physical devices, moving microphone meter, or audible speaker output. |
| Supported workflow | Repository search found no dedicated live MicroSIP retest script. The existing documented live workflow is local simulated `POST /calls` to extension 1001 with `isSimulation:true` (telephony report §6 and deployment report §4); it was not invoked. The isolated `demo:server` workflow is not a live telephony substitute. |

The server journal also contains the separate simulated call `CALL-5F50FCE7270003` closing at `08:33:44.362 UTC`, followed by the warning `closed call(s) that exceeded the maximum duration` with `count=1` and `maxCallDurationMinutes=30`. Its recorded duration is 1,822,766 ms (over 30 minutes). The warning has no call ID, but its timing, count, and duration strongly correlate that closure with the maximum-duration watcher. This is better-supported than the earlier “cause unknown” note, though the warning itself does not identify the call ID.

### Required user confirmation before any test call

1. Select the actual microphone and physically connected speaker/headset in **MicroSIP → Settings → Audio**.
2. In **Windows Settings → System → Sound**, speak and confirm that the selected microphone's input meter moves.
3. Use the Windows test sound for the selected output and confirm that you can hear it.

Those three checks are **NOT VERIFIED** by this preflight. After confirmation, perform one live synthetic call and ask the user to say: “Hello, this is a test call. I am checking the RESUS audio system.” Collect live channel/RTP and AudioSocket measurements where available, Whisper's persisted result, Module 5 state, eSpeak send evidence plus an independent audible-playback confirmation, and post-hangup call-leg/protocol state. If the caller audio is blank, isolate the failure boundary from actual measurements before proposing a code change.

No test call was made, so retest transcription, Module 5 progression, and TTS audibility are **BLOCKED / NOT MEASURED**. P4 remains **BLOCKED**, not accepted. No code/configuration changes or tests were made; no service was restarted.

## 13. Controlled live P4 E2E retest (2026-10-23)

**Result: FAIL acceptance; TTS audibility BLOCKED pending the caller's confirmation.** Exactly one new `isSimulation=true` call was created through the documented live local `POST /calls` workflow. This used the running WSL backend, Asterisk, and MicroSIP extension 1001. No demo server, injected utterance, dispatch, real contact, service restart, or database reset was used. The AppData MicroSIP profile still reported blank per-app input/output device selections; this may mean Windows-default routing, but no independent capture of the selections made during the call is available.

### Preflight and call setup

| Check | Result |
|---|---|
| Git preservation | Branch remained `main`; pre-existing modified/untracked files were preserved. No reset, clean, revert, branch switch, commit, or push. |
| WSL and services | Ubuntu Running; `resus-server.service` and `asterisk.service` active. Neither was restarted. |
| Backend and speech | `/api/health` HTTP 200 (`status=ok`, `routes=71`); `/calls/transport/status` HTTP 200 (`provider=asterisk`, `isLive=true`, `reachable=true`); `/speech/status` HTTP 200 with Whisper/eSpeak `isLive=true` for English and Malayalam. |
| Asterisk / AudioSocket before call | 0 active channels/calls; AudioSocket modules loaded and listener bound on `0.0.0.0:9092`; no established AudioSocket connection. Extension 1001 registered; MicroSIP process responsive. |
| Safety gates | Module 6–9 automation variables were unset in the live environment; no dispatch or external service call was made. |
| Database baseline | `emergencies=134`, `call_sessions=127`, `transcripts=148`, `protocol_sessions=20`, `protocol_steps=28`, `system_events=739`. Read-only counts only. |
| Call | `POST /calls` returned 201 at `2026-10-23T09:53:52.157Z`: `CALL-D4B43310F30020`, `EMG-5ABD7A5BDD001E`, `CARDIAC_ARREST`, local caller 1001, `isSimulation=true`, `isLiveTransport=true`, `provider=asterisk`, `transport=SIP`. Exactly one call was started. |

### Media and speech evidence

Redacted correlated journal evidence and live CLI observations:

```text
09:53:52 originated an Asterisk call leg   CALL-D4B43310F30020 PJSIP/1001-00000001
09:53:52 AudioSocket connected/bound       UUID 186bbc12-f0dd-46e5-9a36-6dcd95fe12b3
09:53:52 started protocol                  PSE-74EAB80EE70023 ACTIVE
09:53:52 eSpeak instruction sent           durationMs=8787
09:53:59 PJSIP channel stats               codec ulaw; RX 312, lost 0; TX 288, lost 0
09:54:00–09:54:06 Whisper caller turns       several finalized; one [BLANK_AUDIO]; Module 5 turns and eSpeak prompts followed
09:54:46 PJSIP channel stats               codec ulaw; RX 2681, lost 0; TX 2362, lost 0
09:55:03 Asterisk media stream ended        CALL-D4B43310F30020
09:55:03 emergency call closed              durationMs=71088
```

The live PJSIP channel was `PJSIP/1001-00000001`, `Up`, using negotiated G.711 `ulaw`; Asterisk reported zero packet loss in both directions at the observed samples. The AudioSocket TCP connection was established for UUID `186bbc12-f0dd-46e5-9a36-6dcd95fe12b3` while the call was active. This proves RTP and AudioSocket transport activity, not the exact acoustic source. The receive path does not log per-frame payload size, PCM sample rate/channel count, RMS, peak, or raw audio; those metrics were unavailable. No sample-rate warning appeared in the correlated journal. Although the user reported configuring MicroSIP devices and checking the Windows input meter/output sound before this retest, the inspected AppData profile still had blank per-app device values; the selected devices during the call cannot be independently reconstructed.

Whisper produced persisted caller rows, so audio reached utterance assembly/transcription. However, the exact requested phrase **“Hello, this is a test call. I am checking the RESUS audio system.”** was not found in the persisted results. In transcript order (caller sequence numbers; interleaved system rows are omitted here):

```text
2  "on hand."                                                  confidence=0.640425
4  "are responding and are reading or reading."                confidence=0.878225
6  "to have a carpet, a carpet, a carpet, a carpet, a carpet." confidence=0.485697
8  [BLANK_AUDIO]                                                confidence=0.781792
10 "and not breathe in normally."                               confidence=0.666635
11–13 [BLANK_AUDIO]                                              confidence=0.844074 / 0.888657 / 0.834896
14 "That's called a vacation date."                             confidence=0.541795
15 "unconscious and is not breathing."                          confidence=0.695900
16 [BLANK_AUDIO]                                                confidence=0.875902
17 "creation is unconscious and is not waiting properly or waiting normally." confidence=0.803561
```

There were 17 total transcript rows, ordered and linked to this call. Some recognized phrases resemble the eSpeak prompt content; without raw audio or per-frame input metrics, microphone speech cannot be distinguished from possible acoustic echo with certainty. The most supportable result is **audio reached the pipeline, but the requested caller phrase was not recognized**. This is a **FAIL** for expected speech capture/transcription, despite RTP reception and nonblank Whisper outputs.

The protocol `PSE-74EAB80EE70023` remained at `confirm-arrest`, with `clarificationCount=3`, `collectedFacts.notes="[BLANK_AUDIO]"`, then entered `ESCALATED` at `09:54:06.419Z` because it could not confirm the required information. This is not successful semantic progression from the test phrase. No real dispatch or human handoff occurred. **Module 5 progression: FAIL.**

Five eSpeak instructions were logged as sent over AudioSocket: durations `8787`, `11277`, `11277`, `11277`, and `4582` ms. This verifies synthesis and send attempts. There was no client-side recording or playback telemetry, and the user has not yet confirmed hearing the prompt. **TTS generation/send: PASS; actual audibility: BLOCKED.**

### Hangup and cleanup

The supported authenticated hangup route returned `closed=true`, call state `ENDED`, and duration `71088` ms at `09:55:03.245Z`. The server logged `Asterisk media stream ended`. After hangup, Asterisk reported `0 active channels`, `0 active calls`, and zero established AudioSocket connections. Transport status returned to the pre-call count of `1` tracked leg. The count-only status does not expose leg identities; the provider's ordinary hangup path releases the current call's map entry. Thus live channel/socket cleanup **PASS**, tracked-call count returned to baseline **PASS with identity limitation**; the pre-existing entry remains and was not altered manually.

The protocol session remains stored as `ESCALATED`, `currentStep=confirm-arrest`, `completedAt=null`, and its step row remains `ACTIVE`. The controller has no neutral media-hangup transition; the operator cancel route has “professional help has arrived” semantics and was not misused. This is persistent protocol state, not an open Asterisk channel/socket. **Module 5 protocol cleanup: FAIL / incomplete by current lifecycle design.**

Post-call read-only counts are `emergencies=135`, `call_sessions=128`, `transcripts=165`, `protocol_sessions=21`, `protocol_steps=29`, and `system_events=777`; deltas correspond to this one synthetic call and its records. No pre-existing records were deleted or reset.

One read-only `GET /calls/:id` probe using the call-session ID returned `NOT_FOUND` (`Call session for emergency 'CALL-D4B43310F30020' was not found.`); this route resolves by emergency ID. Final call state was instead verified by the successful hangup response and the exact call row in the read-only database query. This lookup miss did not change state.

### Acceptance criteria

| Criterion | Result | Evidence / limitation |
|---|---|---|
| SIP call setup | **PASS** | One live local call answered on `PJSIP/1001-00000001`. |
| Asterisk RTP / AudioSocket connection | **PASS** | `ulaw`, RTP counters increased with 0 loss in sampled stats; AudioSocket established and then disconnected. |
| Actual caller audio reached transcription pipeline | **PASS, limited** | Final utterances were persisted; raw PCM/RMS/peak unavailable, so exact acoustic source is not independently identified. |
| Requested synthetic phrase recognized by Whisper | **FAIL** | No transcript matches the phrase; many incorrect fragments and `[BLANK_AUDIO]` rows. |
| Module 5 progression from recognized phrase | **FAIL** | Stayed at `confirm-arrest`, reached 3 clarifications, then `ESCALATED` using `[BLANK_AUDIO]`/`OTHER`. |
| eSpeak synthesis and transport send | **PASS** | Five live eSpeak send records with durations above. |
| eSpeak actually audible at MicroSIP | **BLOCKED** | Awaiting user confirmation; no independent client evidence. |
| Call ended / Asterisk and AudioSocket cleanup | **PASS** | `ENDED`, `closed=true`; 0 active channels/calls and 0 established sockets. |
| Current tracked call-leg cleanup | **PASS, limited** | Transport count returned to baseline 1; status is aggregate-only. |
| Module 5 session cleanup after hangup | **FAIL** | Persistent `ESCALATED` session, active step, `completedAt=null`; no neutral call-ended transition. |

No code/configuration changes were made and no regression tests were run. The missing raw audio/RMS metrics prevent definitive separation of microphone routing, acoustic echo, and segmentation quality; the recognized prompt-like fragments make echo plausible but not proven. Do not change Module 5 lifecycle semantics without a separate design for caller hangup versus a genuine operator escalation. P4 is **not accepted**. The remaining user action is to confirm whether the eSpeak prompt was audible at MicroSIP; that can resolve only the audibility criterion, not the failed phrase recognition or protocol cleanup.

## 14. P4 audio and protocol lifecycle diagnosis (2026-10-23)

**No new call was placed.** This diagnosis uses the existing correlated call evidence and the exact active source copied under `/home/resus/resus`. SHA-256 hashes for the active WSL and workspace copies matched for `audioBridge.ts` and `whisperProvider.ts`; the trace below therefore matches the source that handled the previous call. No services were restarted and no database state was changed.

### Audio path findings

| Boundary | Verified implementation / evidence |
|---|---|
| Asterisk → AudioSocket | AudioSocket framing is a 1-byte type, 2-byte big-endian payload length, and payload. Type `0x10` means 8 kHz SLIN; frame objects are documented as mono signed 16-bit little-endian PCM. The prior call negotiated RTP `ulaw`, had increasing RTP counters and zero reported loss, and established the AudioSocket UUID recorded in §13. RTP codec/counters do not prove PCM amplitude or intelligibility. |
| AudioSocket → utterance buffer | The bridge checks the frame sample rate and warns if it differs from 8 kHz; its VAD reads little-endian signed 16-bit samples. The live WSL `.env` values were `ASTERISK_SPEECH_RMS_THRESHOLD=700`, `ASTERISK_HANGOVER_MS=800`, `ASTERISK_MIN_UTTERANCE_MS=400`, and `ASTERISK_MAX_UTTERANCE_MS=30000`. No sample-rate warning appeared in the previous call journal. That supports an 8 kHz label, but no frame size, sample count, RMS, peak, clipping, or utterance-duration measurements were retained for that call. |
| Utterance → Whisper | Raw non-WAV audio is decoded as mono S16LE at an assumed 8 kHz, resampled to 16 kHz, wrapped in a 16-bit mono WAV, then passed to whisper.cpp. The temporary Whisper work directory, including the WAV/JSON, is removed in a `finally` block. No recoverable raw audio or Whisper input artifact exists for the prior call. |
| Whisper result | The persisted results listed in §13 show Whisper was invoked and returned text, but the requested phrase was not recognized. `[BLANK_AUDIO]` was stored with high confidence in several turns, so that marker was treated as a result rather than as proof the input buffer was silent. This explains why Module 5 received unusable text; it does not identify why the acoustics were wrong. |

**Transcription root-cause assessment: unresolved.** Silence/weak microphone capture, acoustic pickup of eSpeak, utterance segmentation, and a sample/format issue cannot be distinguished without the missing input measurements. Some returned fragments resemble spoken protocol prompts, which makes eSpeak echo a plausible hypothesis, not a verified cause. RTP loss is not supported by the observed counters. The previous run did not retain raw audio; it cannot be inspected retrospectively.

To collect the missing evidence without storing speech, the bridge now emits metadata only for a call whose database row is `isSimulation=true`: sample rate(s), mono channel count, signed-int16-LE format, sample count, payload bytes, duration, VAD duration, frame count/minimum/maximum frame payload size, RMS, peak, and clipped-sample ratio. It records the Module 2 round-trip time; the Whisper provider separately records source/target sample rates and counts, WAV size/format, and the whisper.cpp invocation duration. These logs contain no PCM, transcript text, or persistent audio. The diagnostic flag is forwarded only when both the call is marked simulation and the request explicitly selects `synthetic-test`.

One conditional code risk was found: audio frames received while the bridge is resolving a call are queued as bare buffers; replay labels them 8 kHz rather than preserving each frame's declared rate. The previous journal had no unexpected-rate warning, so there is no evidence this affected the failed call. No unrelated audio conversion behavior was changed.

### Protocol lifecycle findings

On AudioSocket close, the bridge removes the connection, marks it closed, clears its silence timer, and calls the conversation controller's `forget(callSessionId)`, which deletes the controller's in-memory `byCall` entry. The supported hangup also ended the `CallSession`; Asterisk had no active channel and AudioSocket had no established connection after hangup. The persistent Module 5 row remaining `ESCALATED`, with an active step and `completedAt=null`, is intentional under `SessionService.escalate`: its comment explicitly says escalation is deliberately non-terminal so the operator can still read the transcript and collected facts. The `cancel` action means professional help has arrived and is not an appropriate substitute for caller hangup.

**Protocol lifecycle assessment: PASS for the current retention semantics; no resource leak identified.** The database protocol record is intentionally retained and not marked completed. The app has no neutral caller-disconnected state; adding one would require a separate domain decision and is not justified as a cleanup fix by the current semantics. No lifecycle code was changed.

### Confirmation and result

The user has since confirmed hearing the eSpeak prompt clearly and speaking the full requested phrase during the call in §13. This supersedes §13's “audibility BLOCKED” entry: **human-confirmed playback audibility is PASS**, although no independent client recording or telemetry exists. It does not change the failed transcript or Module 5 progression.

| Criterion | Current result | Evidence |
|---|---|---|
| SIP/RTP/AudioSocket setup and teardown | **PASS** | §13: live channel, increasing RTP counters with zero reported loss, connected then disconnected AudioSocket. |
| Caller phrase capture and Whisper recognition | **FAIL** | User spoke the phrase; persisted caller rows contain incorrect fragments and `[BLANK_AUDIO]`, not the expected phrase. PCM levels were not measured on that run. |
| Module 5 progression from the expected phrase | **FAIL** | It stayed at `confirm-arrest` and escalated after three clarification attempts on unusable results. |
| eSpeak audible to MicroSIP | **PASS, human-confirmed** | User reports clearly hearing the prompt; no independent client-side recording exists. |
| Call/media cleanup | **PASS** | Hangup ended the call; Asterisk channels and established AudioSocket connections returned to zero. |
| Module 5 persistence/lifecycle | **PASS, retained by design** | Escalated session is deliberately non-completed for operator review; per-call in-memory mapping is forgotten on stream close. |

**P4 remains FAIL / not accepted** because the expected caller phrase was not recognized and Module 5 did not advance appropriately. Focused validation after metadata instrumentation: `npm test -- modules/module_01_emergency_call/tests/audioBridgeConversation.test.ts modules/module_02_speech_processing/tests/speechService.test.ts modules/module_02_speech_processing/tests/realSpeechProviders.test.ts` — 3 files, 76 tests passed; `npm run typecheck` — passed. No new live call was made.

**Next validation step:** after review/approval, make exactly one controlled synthetic MicroSIP call. Speak the same phrase while capturing the new synthetic-only AudioBridge metrics; verify the per-utterance sample rate is 8 kHz, frame sizes/count and PCM levels/duration are plausible during speech, the Whisper diagnostic shows 8 kHz input decoded and resampled to 16 kHz, and the invocation completes. Compare its persisted transcript with the phrase and Module 5 state. Confirm TTS audibility with the caller, then verify channel/socket cleanup and that an escalated protocol remains retained by design. Keep the original captured speech unrecorded and do not accept P4 unless all speech, progression, audibility, and lifecycle criteria pass.

## 15. Instrumented synthetic call validation (2026-10-23)

**Result: P4 FAIL / not accepted.** Exactly one new simulated call was placed after the diagnostics were verified active. No second call was made. No raw audio or transcript text was printed or added to this report.

### Preflight and activation

Initial read-only checks found the backend and Asterisk active, `GET /api/health` reporting `status=ok, routes=71`, transport reporting Asterisk reachable, and `/speech/status` reporting live Whisper and eSpeak. AudioSocket was listening on `0.0.0.0:9092`; Asterisk had no active channel and no established AudioSocket peer. MicroSIP was running and Asterisk showed a contact for extension 1001. The four diagnostic source files in WSL did not yet contain the diagnostic markers; the server runs `tsx` directly from `/home/resus/resus`, so the prior workspace-only changes were not active in the running service.

The WSL-to-workspace diff showed only the already-reviewed diagnostic additions in these four files. I copied those exact files into `/home/resus/resus` and restarted **only** `resus-server.service` once so `tsx` loaded them. Asterisk was not restarted. After restart, all three diagnostic markers were present; health remained `ok/71`, Asterisk transport remained reachable, Whisper/eSpeak remained live, and the AudioSocket listener remained bound. Automatic dispatch-related environment variables remained unset/default (fail-closed).

### One-call evidence

The supported authenticated local `POST /calls` workflow created exactly one `isSimulation=true` call to extension 1001 using synthetic coordinates `(0,0)`: call `CALL-63E5E987D00003`, emergency `EMG-1C29759BF50001`. It used live local Asterisk/SIP transport. Module 5 created protocol session `PSE-58201E211B0006`. The Asterisk channel was `PJSIP/1001-00000002`; AudioSocket UUID was `64c53b3f-7f5d-4109-98a8-fc710c6929b0`.

At the sampled 23-second point, Asterisk reported negotiated `ulaw`, RX `1112` packets / 0 lost, and TX `1065` / 0 lost. AudioSocket was established. eSpeak prompt sends were logged with durations `8787`, `11277`, `11277`, `11277`, and `4582` ms. Those logs prove synthesis/send; **audibility during this new call was not independently confirmed**. The user's earlier audibility confirmation applies to the earlier call only.

### Per-call audio and Whisper measurements

All diagnostic records below were filtered by this call ID and synthetic-test scope. The aggregate values cover **12** utterances; each had one ingress, one preprocessing, one Whisper invocation, and one Module 2 round-trip record.

| Boundary | Measured evidence | Assessment |
|---|---|---|
| AudioSocket/PCM ingress | All frames were 320 bytes; observed as 8 kHz, mono, signed-int16 little-endian. 12 buffers contained 6,720–41,440 samples (840–5,180 ms; 13,440–82,880 bytes), 42–259 frames each. | **PASS for expected format and active buffered input.** A 320-byte frame is 20 ms at 8 kHz × 2 bytes/sample × mono. No rate mismatch was observed. |
| PCM levels | Per-utterance aggregate RMS ranged 241–812; peak 1,980–7,676; clipped-sample ratio was 0. | **Non-silent signal observed; speech level remains ambiguous.** VAD compares individual frame RMS against 700, while these logged RMS values aggregate the utterance including trailing silence. They cannot be compared directly to the per-frame threshold. Each segment did trigger VAD, but these aggregate readings do not prove the intended phrase was acoustically clear. |
| Buffering / segmentation | 12 finalized buffers, each 840–5,180 ms, all above the configured 400 ms minimum and below the 30 s maximum. All frame payloads were 320 bytes. Live settings: threshold 700, hangover 800 ms, minimum 400 ms, maximum 30,000 ms. | **No evidence of format-size error or max-duration truncation.** Over-segmentation or acoustic echo remains unresolved; no per-frame level distribution or client-side recording was retained. |
| Whisper preprocessing | All 12 inputs decoded as 8 kHz, mono, 16-bit. Each resampled count was exactly double its decoded sample count at 16 kHz. WAV sizes matched `44 + 2 × resampledSampleCount`; zero format/count mismatches. | **PASS.** The measured input matched the adapter's raw PCM assumptions and its 16 kHz mono PCM WAV requirement. |
| Whisper invocation | 12/12 invocations completed; measured duration 1,647–5,758 ms. All Module 2 round-trip records were accepted; confidence ranged 0.5498–0.9400. Diagnostic records contain counts/confidence only, no transcript text. | **PASS for preprocessing/invocation; FAIL for useful recognition.** Completion and confidence do not establish transcript correctness. |

The persisted call transcript contains 17 ordered rows: 5 SYSTEM and 12 CALLER. Two caller rows were `[BLANK_AUDIO]`; the requested phrase was not present. The exact phrase check was performed in memory and only the result was recorded. Several caller outputs were unusable for the requested test, so they do not count as recognition. **Caller phrase recognition: FAIL.**

Module 5 session `PSE-58201E211B0006` remained at `confirm-arrest`, `clarificationCount=3`, `escalationRequired=true`, status `ESCALATED`, `completedAt=null`. **Appropriate progression from the requested phrase: FAIL.** This retained escalated state is intentional for operator review and was not modified. No dispatch or external contact occurred.

### Hangup and acceptance

The supported hangup returned `closed=true`, status `ENDED`, duration `109387` ms. The call record reports start `2026-10-23 10:13:04` and end `10:14:53` (host local time). After hangup, Asterisk reported 0 active channels/calls; established AudioSocket connections were 0; transport reported Asterisk reachable with 0 tracked call legs. Backend and Asterisk stayed active. The protocol session remains stored as `ESCALATED` by design.

| Criterion | Result |
|---|---|
| Backend/Asterisk/AudioSocket/Whisper/eSpeak preflight | **PASS** after activating the verified diagnostic source and restarting the backend once |
| One live local synthetic SIP call and teardown | **PASS** |
| AudioSocket sample rate/channel/format/frame shape | **PASS** |
| Nonzero PCM captured | **PASS**; intelligibility is not established by level metrics |
| PCM-to-Whisper preprocessing | **PASS**, no measured format or size mismatch |
| Whisper invocation | **PASS**, all 12 completed |
| Requested phrase recognized | **FAIL** |
| Module 5 advanced appropriately | **FAIL**; escalation after three clarifications |
| eSpeak audible during this call | **BLOCKED**; send evidence exists, current-call human confirmation is absent |
| Asterisk/AudioSocket/tracked-call cleanup | **PASS** |
| Escalated protocol record retained | **PASS by design** |
| Overall P4 | **FAIL / not accepted** |

**Root-cause assessment:** silence is not supported by the nonzero PCM and VAD segments; incorrect rate/channel/byte-order and Whisper preprocessing/invocation failure are not supported by measurements. The remaining failure is between acoustic content/segmentation and useful model recognition. The aggregate RMS is insufficient to separate weak microphone capture, echo, or segmentation; no raw audio was retained. No speculative fix was made.

**Next justified action:** do not place another call as part of this run. Review the current-call microphone/speaker confirmation and, only after approval, use one narrowly controlled experiment that adds per-frame RMS distribution (speech onset/active-frame levels) to distinguish weak capture from echo or utterance segmentation. Continue to avoid audio recording and transcript-text logging. Do not mark P4 accepted until the requested phrase is recognized, Module 5 advances appropriately, TTS audibility is confirmed for the tested call, and hangup cleanup passes.

## 16. P4 utterance metadata and offline recognizer check (2026-10-23)

**No call was placed.** No service was restarted, database was changed, or application source/configuration modified during this diagnosis. The user confirmed hearing eSpeak and speaking the requested synthetic phrase during `CALL-63E5E987D00003`; this supersedes §15's earlier audibility-blocked wording for that call. It does not change the failed transcription or overall P4 status.

### Per-utterance comparison

The journal has 12 ingress, 12 preprocessing, 12 invocation, and 12 round-trip records for this call. Rows below follow ingress-log order. Each preprocessing `inputBytes` matched its ingress `payloadBytes`; all records show 8 kHz mono S16LE decoded input, 16 kHz output, and resampled count exactly twice the decoded sample count. WAV sizes matched 44 bytes plus two bytes per output sample. All frames were 320 bytes (20 ms at 8 kHz mono S16LE).

| # | Samples | Duration/VAD | Frames | RMS | Peak | Clip ratio | 16 kHz samples |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 21,760 | 2,720 ms | 136 | 745 | 6,396 | 0 | 43,520 |
| 2 | 21,920 | 2,740 ms | 137 | 521 | 4,348 | 0 | 43,840 |
| 3 | 19,040 | 2,380 ms | 119 | 429 | 3,644 | 0 | 38,080 |
| 4 | 6,720 | 840 ms | 42 | 241 | 1,980 | 0 | 13,440 |
| 5 | 21,760 | 2,720 ms | 136 | 640 | 5,372 | 0 | 43,520 |
| 6 | 23,040 | 2,880 ms | 144 | 766 | 7,676 | 0 | 46,080 |
| 7 | 41,440 | 5,180 ms | 259 | 812 | 6,140 | 0 | 82,880 |
| 8 | 34,560 | 4,320 ms | 216 | 802 | 5,116 | 0 | 69,120 |
| 9 | 12,160 | 1,520 ms | 76 | 644 | 4,092 | 0 | 24,320 |
| 10 | 19,520 | 2,440 ms | 122 | 457 | 3,004 | 0 | 39,040 |
| 11 | 16,320 | 2,040 ms | 102 | 440 | 3,388 | 0 | 32,640 |
| 12 | 11,840 | 1,480 ms | 74 | 451 | 2,364 | 0 | 23,680 |

All durations are multiples of the 20 ms frame interval; no partial/differently sized frames, odd-byte PCM, clipping, sample-count mismatch, or max-duration truncation appeared. Segment 4 is shortest (840 ms) and has the lowest aggregate RMS/peak; it remains above the 400 ms minimum. Segments 7/8 are longest (5,180/4,320 ms) and have the highest RMS; segment 6 has the highest peak. Segments 1 and 5 have equal duration/sample/frame counts but different RMS/peak. These are observations, not evidence of speech quality or root cause. Aggregate RMS includes tail frames and is not comparable directly to the 700 per-frame VAD onset threshold.

Whisper invocation durations in journal order were 2,054, 3,059, 5,758, 2,637, 1,853, 1,791, 1,997, 1,840, 2,039, 1,647, 1,886, and 1,672 ms. All completed; round-trip durations were 1,667–5,790 ms. Invocation records have no input byte count, segment ordinal, or shared utterance ID, so exact per-segment timing matches cannot be recovered. Preprocessing can be matched by byte count, but two segments share 43,520 bytes.

### Source path and echo boundary

`audioSocket.ts` buffers TCP chunks and parses frames as one type byte, a big-endian 16-bit length, and that many payload bytes. Type `0x10` denotes 8 kHz signed-linear audio. The bridge processes each received payload as mono signed-int16 little-endian. Its VAD starts a buffer on a frame at/above the configured RMS threshold; earlier quiet frames are discarded. After onset it appends all frames, including low-level tail frames, and ends after 800 ms below threshold or at 30 seconds. Buffers under 400 ms are dropped. The saved logs do not include boundary timestamps/reason, segment number, or per-frame levels.

`decodeAudio` interprets raw input as mono S16LE at the supplied 8 kHz rate; the Whisper adapter resamples to 16 kHz, makes a mono 16-bit WAV, then runs whisper.cpp. Provider WAV/JSON temporary artifacts are removed in `finally`. No call audio was retained; no saved audio was used in this diagnosis.

`sendAudio` writes outbound PCM over the duplex AudioSocket; the bridge VAD sees only frames received from Asterisk and does not feed its own outbound buffer directly into recognition. Playback can still re-enter as inbound media if the softphone/OS loops it back or a speaker acoustically reaches the microphone. The received stream cannot distinguish that from caller speech, and the evidence does not establish echo as the cause.

### Isolated known-speech check

The configured local Whisper binary/model, `tsx`, `dotenv`, and eSpeak executable were present. Without a call, network access, dependency changes, or database access, installed eSpeak generated a temporary harmless English WAV and the actual WSL `WhisperSpeechProvider` consumed it using the configured local model. It completed in 2,217 ms with confidence 0.7388; an in-memory check matched 6/8 expected words but not the full phrase. Only match counts/confidence were printed; transcript text was not logged. The generated WAV and provider temporary files were removed. The WAV header rate was not separately recorded. This shows the adapter/model can process known synthetic speech, but does not prove telephony-path recognition or identify the live failure.

### Assessment and next step

**Confirmed:** observed frame sizes, rates, sample counts, mono S16LE interpretation, resampling and WAV sizes agree. Twelve VAD buffers were finalized (840–5,180 ms); all Whisper invocations completed; the requested phrase was absent and two caller rows were `[BLANK_AUDIO]`. The user confirmed speaking the phrase and hearing eSpeak. Module 5 remains intentionally `ESCALATED`. **Not established:** whether segments contain intelligible caller speech, whether pauses split the phrase, whether prompt echo entered, or whether acoustic/model mismatch caused the failures. No specific framing/format anomaly is supported.

Per-frame level summaries plus boundary reason and a synthetic-only monotonically increasing segment ordinal propagated through ingress/preprocessing/invocation/round-trip logs would resolve the current correlation gap and help distinguish weak activity from segmentation. They cannot alone distinguish speech from echo. After approval, the smallest useful live experiment is one call with an explicit silent interval during eSpeak playback followed by the same phrase after playback; measure per-frame RMS bins/quantiles, active/trailing frame counts and boundary reason, without retaining waveform or transcript. If echo must be proven, add an in-memory correlation against the outbound reference and log only a bounded score/lag; do not assume echo from the current results.

**P4 remains FAIL / not accepted.** Requested-phrase recognition and Module 5 progression failed. TTS audibility is user-confirmed for this call; call/media cleanup passed in §15; retaining the escalated protocol is intentional. No code/configuration changes or regression tests were made. P3 and P5 remain unstarted.

## 17. Synthetic VAD-to-Whisper segment correlation instrumentation (2026-10-23)

**P4 remains FAIL / not accepted. No live call was placed.** This change adds metadata-only diagnostics; it does not alter VAD thresholds, framing, PCM conversion, Whisper arguments, Module 5 behavior, or dispatch configuration. No database operations or service restarts occurred.

For each VAD onset, AudioBridge now assigns a per-call ID (`<callSessionId>:SEG-0001`, incrementing within that call stream). A synthetic-only ingress record carries segment start/end ISO timestamps, PCM duration and sample count, boundary reason (`silence-hangover`, `max-duration`, or `call-ended`), outcome (`submitted`, `dropped-too-short`, `dropped-missing-session`, or `discarded-call-ended`), and bounded frame summaries: frame count, trailing-silence frame count, RMS min/mean/max, frames above the existing VAD threshold, and peak min/mean/max. Incomplete speech at hangup is measured and labeled but remains untranscribed, preserving existing call semantics.

The same segment metadata is gated by `isSimulation` and explicit `synthetic-test` scope through SpeechService, then included in Whisper preprocessing, inference success/failure, and bridge round-trip records. Preprocessing logs its outcome and elapsed time; Whisper logs completed or failed inference duration. Empty audio and zero-sample preprocessing are handled with outcome records when diagnostic scope is enabled. No PCM, transcript text, error message, credential, or patient name is logged. Diagnostic log calls are guarded so a throwing logger cannot fail speech processing. Per-call diagnostic output is capped at 64 segments (at most one ingress, one preprocess, one inference, and one round-trip record per eligible segment); later segments continue through normal processing without diagnostic fields. No dependency was added.

**Focused validation:**

- `npm test -- modules/module_01_emergency_call/tests/audioBridgeConversation.test.ts modules/module_02_speech_processing/tests/speechService.test.ts modules/module_02_speech_processing/tests/realSpeechProviders.test.ts modules/module_02_speech_processing/tests/whisperDiagnostics.test.ts` — 4 files, 86/86 tests passed.
- `npm run typecheck` — passed.
- Added coverage for same-segment ID at ingress/Whisper stages, multiple segment IDs per call, silent/empty input, short dropped segment, max-duration and hangup boundaries, simulation-only propagation, 64-segment cap, and logger failures.

Changed source/test files: `modules/module_01_emergency_call/src/telephony/asterisk/audioBridge.ts`, `modules/module_01_emergency_call/tests/audioBridgeConversation.test.ts`, `packages/core/src/providerPorts.ts`, `modules/module_02_speech_processing/src/speechService.ts`, `modules/module_02_speech_processing/src/providers/whisperProvider.ts`, `modules/module_02_speech_processing/tests/speechService.test.ts`, `modules/module_02_speech_processing/tests/realSpeechProviders.test.ts`, and new focused test `modules/module_02_speech_processing/tests/whisperDiagnostics.test.ts`. Existing modified and untracked worktree files were preserved.

### Next controlled experiment

After approval, make exactly one synthetic MicroSIP call with two clearly separated phases: (1) remain silent while eSpeak plays and for two seconds afterward; (2) speak the requested phrase once at a steady normal level. Capture the new segment IDs, start/end times, boundary reasons, duration/sample/frame counts, active/trailing frame counts, frame-level RMS/peak summaries, and the matched preprocessing/inference records. Do not save audio or transcript text. A segment during the silent playback window would support a loopback/echo hypothesis but would not prove it. If inbound activity is present there, the next minimal echo-specific check is an in-memory comparison against the outbound eSpeak reference, logging only a bounded correlation score and lag. If speech-window frames are weak, capture quality remains suspect; if boundaries split the utterance, segmentation is implicated; if one adequate segment is passed through correct preprocessing/inference but recognition is wrong, recognizer/acoustic mismatch remains. Review the persisted transcript, Module 5 state, TTS audibility confirmation, and cleanup after the call. Keep the escalated Module 5 record semantics unchanged.

The requested phrase has not been re-recognized and Module 5 has not been shown to progress correctly. **P4 remains FAIL.** P3 and P5 remain unstarted.

## 18. Controlled VAD/Whisper experiment (2026-10-23)

**Result: P4 FAIL / not accepted. Exactly one synthetic live MicroSIP call was made.** No second call was placed. No raw audio or transcript text was retained or included here.

### Preflight and diagnostic activation

Ubuntu WSL was running, the existing keeper check found one matching process, and `resus-server.service` and `asterisk.service` were active. Before the call, `/api/health` returned `status=ok`, `routes=71`; `/calls/transport/status` reported Asterisk live/reachable and zero tracked call legs; `/speech/status` reported Whisper and eSpeak live. Asterisk had zero active channels, its AudioSocket listener was bound on `0.0.0.0:9092`, and there were zero established AudioSocket connections. MicroSIP was running and Asterisk had a contact for extension 1001 (shown as `NonQual`); the call subsequently connected through the live SIP/AudioSocket path. Dispatch remains fail-closed: Module 6 enables automatic dispatch only when its environment value is exactly `true`; no dispatch action was taken.

The running WSL source had the earlier synthetic audio diagnostics but not the new segment propagation. Read-only source comparison isolated this difference to the requested instrumentation in the four diagnostic-path files. Those four workspace versions were copied to `/home/resus/resus` after preserving the prior live versions under `/tmp/resus-p4-pre-segment-diag`, and only `resus-server.service` was restarted once to load them. Asterisk was not restarted. The immediate first health probe raced startup and was refused; about 12 seconds later the service was listening, health returned `ok/71`, Asterisk remained reachable, Whisper/eSpeak remained live, and all four WSL source hashes matched the workspace. No call was started until those post-restart checks passed.

The configured workflow created call `CALL-A8B24D05A20003`, emergency `EMG-70BC2E8F430001`, and protocol `PSE-A0475854610006` via `POST /calls`, with `callerId=1001`, `incidentType=CARDIAC_ARREST`, `isSimulation=true`, and synthetic `(0,0)` coordinates. The backend reported Asterisk/SIP live transport. During the call, one Asterisk channel and one established AudioSocket peer were observed. The service logged five eSpeak sends (durations 8,787; 11,277; 7,191; 7,191; and 4,582 ms). Those are synthesis/send records only. The user's reply confirmed speaking the requested phrase after I prompted them, but did not confirm hearing the eSpeak prompt during this call.

### Correlated audio evidence

The call produced 15 ingress, 15 preprocessing, 15 Whisper invocation, and 15 round-trip records. Segment IDs `CALL-A8B24D05A20003:SEG-0001` through `SEG-0015` correlated across those stages. Every preprocessing outcome was `prepared`; every inference completed. Input was 8 kHz mono signed-int16 little-endian, with 320-byte/20 ms frames; preprocessing reported 8 kHz mono to 16 kHz mono for all 15 segments. All 15 segments ended by `silence-hangover`, with 40 trailing-silence frames each. No PCM, recognized words, credentials, or patient identifiers were present in the diagnostic records.

| Segment | Start (journal time) | Duration ms | Samples | Frames | Frames above VAD threshold | Frame RMS min/mean/max | Frame peak max | Whisper ms | Output chars |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 01 | 11:01:32 | 2,680 | 21,440 | 134 | 38 | 29/545/2,818 | 6,396 | 2,186 | 5 |
| 02 | 11:01:35 | 2,060 | 16,480 | 103 | 13 | 37/276/1,708 | 4,348 | 1,797 | 44 |
| 03 | 11:01:38 | 1,680 | 13,440 | 84 | 7 | 38/257/1,287 | 3,772 | 1,914 | 13 |
| 04 | 11:01:40 | 860 | 6,880 | 43 | 3 | 32/177/882 | 2,108 | 1,948 | 13 |
| 05 | 11:01:41 | 6,320 | 50,560 | 316 | 44 | 34/334/2,744 | 7,164 | 2,206 | 81 |
| 06 | 11:02:15 | 920 | 7,360 | 46 | 6 | 40/227/1,577 | 4,348 | 1,856 | 13 |
| 07 | 11:02:24 | 860 | 6,880 | 43 | 3 | 33/200/1,500 | 5,372 | 1,939 | 8 |
| 08 | 11:02:28 | 5,800 | 46,400 | 290 | 65 | 48/395/1,314 | 2,876 | 2,005 | 54 |
| 09 | 11:02:46 | 4,200 | 33,600 | 210 | 67 | 47/489/2,152 | 4,348 | 2,099 | 66 |
| 10 | 11:02:54 | 980 | 7,840 | 49 | 9 | 49/325/1,484 | 3,772 | 1,620 | 6 |
| 11 | 11:02:55 | 4,000 | 32,000 | 200 | 64 | 46/494/1,826 | 4,348 | 1,841 | 61 |
| 12 | 11:03:18 | 3,700 | 29,600 | 185 | 51 | 51/482/1,857 | 3,900 | 2,149 | 65 |
| 13 | 11:03:21 | 900 | 7,200 | 45 | 5 | 58/237/1,342 | 4,092 | 1,949 | 5 |
| 14 | 11:04:30 | 860 | 6,880 | 43 | 2 | 57/278/1,137 | 4,860 | 1,964 | 13 |
| 15 | 11:04:31 | 880 | 7,040 | 44 | 4 | 49/205/794 | 2,876 | 1,978 | 13 |

Across the full call, durations were 860–6,320 ms, frame RMS means 177–545, and frame peak maxima 794–7,164. Segments 14–15 were short (860/880 ms) with only 2/4 frames above the existing VAD threshold. This is consistent with short fragments or weak activity, but the user did not provide a speech timestamp and those segments cannot be confidently assigned to the requested phrase. All inference times were 1,620–2,206 ms; output lengths were 5–81 characters. These metrics show non-empty inbound audio and a functioning preprocessing/inference path; RMS/peak and output length do not establish intelligible speech.

The known-silent phase was not independently confirmed, and multiple VAD segments occurred before I asked the user to speak. Therefore this run does **not** establish that the early activity was echo, speech, or background noise, nor can it compare a verified silent window with a verified speech window. The source keeps outbound PCM separate from the receive callback, but acoustic or OS loopback remains possible. No raw audio was stored. All conversions and Whisper calls completed, so there is no measured preprocessing or invocation failure; capture quality, possible echo, segmentation, and recognition remain unresolved.

### Transcript, Module 5, and cleanup

The persisted transcript contained 20 ordered rows (5 SYSTEM, 15 CALLER). An in-memory exact normalized comparison found **no caller row equal to the requested phrase**; transcript content was not displayed or logged. The user confirmed speaking the requested phrase after the live prompt. Phrase recognition therefore **FAIL**.

Module 5 session `PSE-A0475854610006` remained at `confirm-arrest`, with `clarificationCount=3`, `escalationRequired=true`, status `ESCALATED`, and `completedAt=null`. The retained escalated record is intentional and was not changed. Correct progression **FAIL**.

Authenticated hangup returned `closed=true`; call status became `ENDED`, duration 201,898 ms. After hangup, Asterisk reported 0 active channels/calls, established AudioSocket connections were 0, and transport reported 0 tracked call legs. Cleanup **PASS**. No automatic dispatch or real-world contact occurred.

| Criterion | Result | Evidence |
|---|---|---|
| Audio capture | **PASS, limited** | 15 non-empty 8 kHz mono PCM segments received and correlated. The capture is not proof that the requested phrase was intelligible. |
| Exact phrase recognition | **FAIL** | Phrase absent from all persisted CALLER rows. |
| Module 5 progression | **FAIL** | Still `confirm-arrest`; escalated after three clarifications. |
| eSpeak audibility | **BLOCKED** | Synthesis/send was logged; this call's playback was not confirmed by the user. |
| Call/media cleanup | **PASS** | `ENDED`; 0 Asterisk channels, 0 established AudioSocket peers, 0 tracked call legs. Intentional `ESCALATED` session retained. |

**Overall P4 remains FAIL.** No code, configuration, VAD, Whisper, protocol, or dispatch behavior was changed in this experiment. The only live change was deployment of the already-tested segment-diagnostic source and one justified backend restart. The prior §17 focused tests (86/86) and typecheck results remain the code validation; no new test run was needed for this no-code experiment.

### Next evidence-based action

Do not infer echo from early VAD activity or the short final segments. The next experiment, only after approval, should use one new synthetic call with an explicit externally noted time marker: keep the caller silent through the eSpeak send and two seconds after it ends, then say the phrase once and record the spoken start/end time in the operator's notes. Confirm the silent interval and eSpeak audibility explicitly afterward. Correlate those times to the existing per-frame and segment metadata. If speech is split, measure the boundary gap; if input remains during confirmed silence, compare inbound frames to the outbound eSpeak reference in memory and retain only a bounded correlation score/lag. Do not retain waveform or transcript text. Preserve the escalated record semantics.

## 19. Timestamped speech-capture preflight (2026-10-23)

**Result: BLOCKED before call. No call was placed.** The requested marker quality cannot be established through the current supported workflow without a diagnostic code change, so the one-call limit was not used.

### Read-only preflight

Ubuntu WSL was running; `resus-server.service` and `asterisk.service` were active. Backend `/api/health` returned `ok`, 71 routes; `/calls/transport/status` reported Asterisk reachable; `/speech/status` reported Whisper and eSpeak live. AudioSocket had one listener on port 9092 and zero established connections. Asterisk had zero active channels/calls. The live WSL hashes for `audioBridge.ts`, `speechService.ts`, `whisperProvider.ts`, and `providerPorts.ts` matched the reviewed workspace hashes, and the backend process had started after those files were synchronized. No service was restarted. No database or call endpoint was used.

### Clock and marker capability

The existing segment diagnostics record `startedAt`/`endedAt` as ISO wall-clock values derived from `Date.now()` at VAD onset and segment finalization. They provide segment boundaries, not the time the caller intentionally begins or ends a phrase: VAD onset is the first threshold-crossing frame, and the end includes the configured silence hangover. The call session has a persisted `startedAt`, so segment timestamps can be subtracted from call start approximately as wall-clock offsets. Whisper preprocessing and invocation diagnostics carry segment IDs and durations, but do not record separate start/end timestamps. The journal adds its own event timestamp.

The `spoke a protocol instruction to the caller` log is emitted after `session.sendAudio(...)` returns and includes the generated audio duration. There is no prompt-start or prompt-end marker at the actual send boundary. Repository search found no supported diagnostic marker endpoint, CLI, dashboard control, or script for recording operator speech-start/speech-end events. An external note or remembered timestamp would not meet this task's supported-instrumentation requirement. Consequently, the prompt-start plus two-second silence window and the speech-start/end markers cannot be reliably recorded with current instrumentation.

### Decision and smallest next change

No call was attempted, no code/configuration was changed, and no tests were run. Existing per-segment diagnostics remain active; P4 remains **FAIL / not accepted**.

Before another call, add a narrowly scoped synthetic-only timing marker path: emit `prompt-start` and `prompt-end` at the AudioSocket send boundaries; provide an operator-authenticated marker action for `speech-start` and `speech-end` on an active `isSimulation=true` call; record all four against one per-call monotonic clock origin as `callRelativeMs`, correlated to `callSessionId`/`emergencyId`, with a small per-call cap. Log only marker kind and timing metadata, no audio or transcript. Add focused tests for clock origin/ordering, rejection of non-synthetic or inactive calls, cap behavior, and logger failure. Keep VAD, Whisper, protocol, and dispatch behavior unchanged. Run focused tests and typecheck before considering another controlled call.

## 20. Coordinated audio timing markers (2026-10-23)

**P4 remains FAIL / not accepted. No live call was placed and no service was restarted.** This is a workspace-only diagnostic change; the active WSL backend has not been updated or verified to contain it.

### Implementation

- At AudioBridge binding, a synthetic call receives one `performance.now()` monotonic origin. The bridge emits `prompt-start` immediately before queuing each audible eSpeak buffer and `prompt-end` when the paced AudioSocket writer drains its final frame to the local socket. This completion callback does not wait in or alter the call/Module 5 flow.
- Authenticated `POST /calls/:id/timing-markers` accepts only `speech-start` or `speech-end`; existing CALL_CENTRE, OPERATOR, or ADMIN roles are required. The service checks that the identified call remains ACTIVE and `isSimulation=true`, then the bridge verifies an active AudioSocket connection. Markers are timestamped on the same server monotonic clock at handler processing after session validation. Start requires a completed prompt; end requires a start; duplicates, bad order, unavailable calls, and the 64-event cap are rejected without affecting audio or protocol flow.
- Marker records contain call/session and emergency IDs, marker kind, sequence, prompt ordinal where applicable, and `callRelativeMs` only. Segment metadata now carries call-relative start/end offsets from that same clock and continues through preprocessing and Whisper by segment ID. No PCM, transcript text, credentials, or patient-identifying information is added. Diagnostic logger exceptions are swallowed.
- Changed files: `audioBridge.ts`, `audioSocket.ts`, `callService.ts`, `routes.ts`, `runtime.ts`, `providerPorts.ts`, two existing speech-test fixtures, and new `syntheticTimingMarkers.test.ts`. No dependencies or database changes.

### Validation and limitations

Focused command: `npm test -- modules/module_01_emergency_call/tests/syntheticTimingMarkers.test.ts modules/module_01_emergency_call/tests/audioBridgeConversation.test.ts modules/module_02_speech_processing/tests/speechService.test.ts modules/module_02_speech_processing/tests/whisperDiagnostics.test.ts` — **46 tests passed across 4 files** (14 AudioBridge conversation, 4 timing marker, 26 speech service, 2 Whisper diagnostic). Covered monotonic order, per-call isolation, invalid/duplicate markers, non-synthetic gating, and throwing diagnostic sinks. `npm run typecheck` passed. `git diff --check` passed; Git printed only existing LF-to-CRLF advisory warnings. Two existing diagnostics fixtures were updated with call-relative boundaries.

`prompt-end` means the final frame was handed to the local TCP socket writer; it does not prove Asterisk playback completion or client audibility. A prompt interrupted by socket closure is left without a prompt-end marker. Operator event time is the backend's monotonic request-processing time after active synthetic-session validation, so it includes local request/handling latency; use the local authorized route and correlate its returned `callRelativeMs`. It is not a physical microphone onset measurement. Trigger speech-start immediately before speaking and speech-end immediately after speaking. No raw audio is retained. VAD thresholds, PCM conversion, Whisper options, Module 5 behavior/lifecycle, and dispatch behavior were not changed.

### Next coordinated experiment

After the reviewed source is deployed through the normal controlled procedure and the route/source hashes are verified in the live WSL backend, use exactly one new synthetic call. Let the automatic prompt-start/prompt-end markers appear; remain silent through the prompt and for two seconds after prompt-end. For that active call ID, an authenticated operator sends `POST /calls/{CALL_ID}/timing-markers` with JSON `{"marker":"speech-start"}` immediately before saying once: “Hello, this is a test call. I am checking the RESUS audio system.” Send the same route with `{"marker":"speech-end"}` immediately after. Keep the bearer token in the existing authorized local secret handling; never place it in notes or logs. Correlate marker offsets with segment offsets, per-frame summaries, preprocessing, and inference by call/segment ID; verify persisted phrase recognition, Module 5 progression, user-confirmed audibility, and ordinary call cleanup. The route and response have not yet been deployed or exercised against WSL.

**Ready:** implementation and focused test coverage are in the workspace. **Blocked:** live deployment verification and the one coordinated experiment remain; phrase recognition, Module 5 progression, playback confirmation, and cleanup have not been verified with these markers. Overall P4 remains **FAIL**.

## 21. Live deployment and coordinated synthetic call (2026-10-23)

**Overall P4: FAIL / not accepted. Exactly one synthetic call was placed.** Call `CALL-328E6F84530003`; emergency `EMG-4FF96C885F0001`; Module 5 protocol `PSE-5117B518380006`. The user confirmed speaking the requested phrase once. No second call was placed.

### Deployment and preflight

Before deployment, WSL `resus-server.service` and `asterisk.service` were active; the live backend returned `ok` with 71 routes; Asterisk was reachable; Whisper/eSpeak were live; AudioSocket port 9092 was listening; channels, established sockets, and tracked call legs were zero. Automatic dispatch remained disabled. Compared the six live runtime files against the reviewed workspace versions; differences were limited to the intended marker additions. Preserved originals in `/home/resus/resus/.backup-20261023T1143Z-p4-timing-markers`, then synchronized only `audioBridge.ts`, `audioSocket.ts`, Module 1 `callService.ts` and `api/routes.ts`, server `asterisk/runtime.ts`, and `packages/core/providerPorts.ts`. Pre/post SHA-256 hashes matched workspace for each synchronized source. WSL `npm run typecheck` passed. Restarted `resus-server.service` once to load the source; did not restart Asterisk. Post-restart health was `ok`, 72 routes; Asterisk reachable; Whisper/eSpeak live; marker route appeared with CALL_CENTRE/OPERATOR/ADMIN roles. A valid-schema unauthenticated marker request returned 401. AudioSocket remained available and dispatch stayed disabled. Reviewed workspace validation: 46/46 focused tests, typecheck, and `git diff --check` passed. No tests were rerun for this no-code deployment/call operation.

### Call-relative markers and correlated evidence

The call connected over the live SIP/AudioSocket path (one active Asterisk channel and one established AudioSocket peer were observed during the call). Timing markers from the single monotonic call origin were:

| Marker | callRelativeMs |
|---|---:|
| prompt-start #1 | 441.571 |
| prompt-end #1 | 9,396.961 |
| prompt-start #2 | 9,943.286 |
| prompt-end #2 | 20,878.116 |
| speech-start | 77,474.169 |
| speech-end | 131,513.830 |

The speech marker interval spans 54.040 seconds. These are backend marker receipt times, not physical acoustic onset/end; the delayed speech-end marker makes that interval too broad to attribute every overlapping segment to the phrase. The user confirmed speaking the exact phrase. The prompt was synthesized and sent twice, but audibility for this call is not confirmed.

There were 17 unique inbound segment IDs (SEG-0001–SEG-0017). All ingress records were 8 kHz mono PCM; all 17 preprocessing records reported `prepared`, and all 17 Whisper invocations completed. Every boundary reason was `silence-hangover`. Duration ranged 820–5,020 ms, samples 6,560–40,160, frames 41–251, RMS 167–743, peak 1,564–5,884; no clipping was reported. Segment timing relative to the markers:

- SEG-0001–0005 began at 0.912–12.612 s during the two prompt-send windows. This establishes inbound activity during outbound prompt periods, not that the signal was eSpeak echo; no acoustic comparison was made and silence was not independently confirmed.
- SEG-0006–0009 began at 41.092–65.519 s before speech-start. SEG-0010 began at 75.793 s and ended at 79.853 s, straddling speech-start at 77.474 s.
- SEG-0011–0016 began at 88.093–129.433 s within the broad marker interval. SEG-0017 began at 150.754 s, after speech-end.

The samples were non-empty and correctly prepared for the configured adapter, but RMS/peak do not establish speech intelligibility. The persisted emergency transcript has 22 rows (17 CALLER, 5 SYSTEM); the exact requested phrase was absent from CALLER rows. Transcript text was checked in memory and is not included here. Module 5 status is `ESCALATED`; its record remains retained and unchanged.

### Hangup and acceptance

Authenticated hangup returned `ENDED` with call duration 183,829 ms. Subsequent checks found zero Asterisk active channels/calls, zero established AudioSocket peers, and zero tracked call legs. The protocol remains `ESCALATED` by design.

| Criterion | Result | Evidence |
|---|---|---|
| Audio capture | **PASS, limited** | 17 non-empty segments reached preprocessing; phrase-specific capture quality is not established. |
| Requested phrase recognition | **FAIL** | Exact phrase absent from persisted CALLER rows. |
| Module 5 progression | **FAIL** | Protocol `PSE-5117B518380006` remains `ESCALATED`; expected progression did not occur. |
| eSpeak audibility | **BLOCKED** | Two prompt send windows recorded; no current-call user confirmation of audibility. |
| Call/media cleanup | **PASS** | Call ended; zero channels, sockets, and tracked call legs; escalated protocol preserved. |

The marker pattern shows inbound VAD activity during prompt windows and before speech-start, plus segments during the broad speech-marker interval. This is a timing anomaly, not proof of echo: background sound, device activity, marker delay, and overlapping conversational turns remain possible. The 54-second marker interval and absence of acoustic reference/correlation prevent attribution. No raw audio or transcript text was retained or logged in this report. No application code, VAD/Whisper behavior, Module 5 semantics, or dispatch behavior changed in this run.

Next, confirm whether the current-call prompts were audible. Do not place another call until a narrower experiment is agreed: use an existing known synthetic speech fixture through the Whisper adapter in isolation if suitable, or use a local marker control that visibly acknowledges operator marker clicks and a pre-agreed silent interval. If live capture remains necessary, add bounded in-memory inbound/outbound correlation only after confirming a safe reference path; retain only correlation score/lag and metadata. Keep P4 FAIL; do not infer echo or Whisper root cause from this call alone.

## 22. Offline Whisper fixture inspection (2026-10-23)

**Result: BLOCKED; no offline Whisper inference was run. P4 remains FAIL.** No live call, database access, dependency change, or audio generation occurred.

### Fixture provenance and suitability

The repository's audio-file inventory outside dependencies contains six WAVs under `MicroSIP/` named as ringtone, ringing, hangup, and message notification sounds. They are client UI sounds; no expected spoken phrase or speech-fixture provenance is documented, so they are not valid recognition fixtures. The only other WAV found is untracked `modules/Module_2_Zipped/Module_2/temp_audio.wav` (224,044 bytes). Its source scripts `microphone.py`, `main.py`, and `live_transcription.py` show that `temp_audio.wav` is produced by recording from a microphone; the scripts do not establish who spoke, what was said, or a deterministic expected phrase. This file may contain private user audio, so it was not played, sampled, copied, or passed to Whisper. The current speech-provider tests build synthetic WAV/PCM arrays for format assertions; they do not contain known speech.

The reviewed adapter (`WhisperSpeechProvider`) accepts AudioSocket mono signed 16-bit PCM at 8 kHz and resamples/encodes it as mono 16 kHz WAV before invoking whisper.cpp. It also accepts a 16-bit WAV and converts it through the same path. The adapter requires a configured local Whisper binary and model. The existing repo test explicitly does not invoke whisper.cpp because the real engines are not exercised by those tests. Since no repository fixture has both safe synthetic provenance and an expected phrase, an adapter/model pass/fail result cannot be produced without creating a new fixture.

### Conclusion and next step

No transcript text or audio content was inspected, emitted, or retained. No tests were needed for this read-only fixture inventory. The live evidence therefore remains: 17 non-empty segments were prepared and Whisper returned results, but the intended phrase was absent; this alone cannot distinguish the live microphone/acoustic path from a model or recognition limitation. There is no evidence from this run supporting an adapter/model defect. The live acoustic path and segmentation-to-phrase correspondence remain unresolved.

Smallest safe next step: authorize an explicitly synthetic, deterministic speech fixture (for example, use the already-installed eSpeak binary configured by the project to synthesize the exact harmless test phrase into a temporary WAV, verify its format, feed that file through the existing `WhisperSpeechProvider` and preprocessing path, compare the normalized result to the expected phrase in memory, log only format/duration/inference status/phrase-match boolean, then remove the temporary file). Do not use `temp_audio.wav`. This requires no download or new dependency, but it does create synthetic audio; it was not done under this task's instruction not to invent a fixture. Keep P4 FAIL until full live-call acceptance criteria pass.

## 23. Disposable synthetic eSpeak-to-Whisper validation (2026-10-23)

**Offline result: FAIL for phrase recognition; P4 remains FAIL / not accepted.** No live call, database operation, source change, dependency installation, model download, or service restart occurred. Automatic dispatch remained disabled.

### Setup and provenance

Read §22 first. The WSL deployment was already configured for Whisper recognition and eSpeak synthesis. The configured eSpeak executable was available; the configured whisper.cpp executable resolved on PATH, its `--help` command exited successfully, and the configured model file was readable. The first temporary harness preflight stopped before creating audio because it treated a command-name executable as a direct filesystem path. The harness then resolved that configured command through PATH, consistent with the adapter's subprocess execution; no application source/configuration was changed.

The test harness asked the configured eSpeak binary to synthesize the known harmless phrase **“This is a synthetic speech test.”** The phrase is harness input and the expected comparison string; it was not taken from a recording. eSpeak wrote one disposable RIFF/WAVE PCM file. Metadata: 22,050 Hz, mono, 16-bit, 2,151 ms, 94,884 bytes. The generated file was read by the harness and passed directly to the existing `WhisperSpeechProvider` with its configured model/runtime and normal provider options.

### Adapter path and outcome

The production adapter decoded the 22.05 kHz mono 16-bit WAV, resampled its samples to 16 kHz mono, encoded the normalized WAV, and invoked whisper.cpp. Inference completed in **2,121 ms**. Confidence returned by the adapter was **0.5267**. The adapter result was compared in memory against the expected phrase: **exact match FAIL; normalized match FAIL** (normalization lowercases, applies Unicode NFKC, removes punctuation, and collapses whitespace). Recognized text was not printed or durably retained; the adapter's temporary JSON output was inside its automatically cleaned inference directory. This is a failed controlled synthetic recognition sample, not proof of an adapter defect; only one eSpeak voice/phrase and one inference were tried.

Cleanup passed: the outer temporary directory containing the WAV was removed; the temporary harness file was removed by its exit cleanup; a follow-up check found no remaining test-specific WAV directories. The adapter's own inference work directory is removed in its `finally` path. No new test fixture or artifacts were retained. No additional automated test suite was needed for this one runtime validation; no source changed.

### Interpretation and next action

Unlike the live-call result, this test removes MicroSIP capture, SIP/RTP, AudioSocket, VAD segmentation, and Module 5 from the path. Because the offline known-speech phrase was also not recognized, live microphone capture or segmentation alone cannot explain all observed failures. Evidence now directs the next investigation toward offline recognition behavior, including the local model/runtime, generated-speech pronunciation, WAV preprocessing, and adapter invocation. It does **not** by itself prove a production adapter bug or identify which of those components failed. Do not place another live call until this offline failure is understood and a known synthetic phrase is recognized through the adapter.

## 24. Offline Whisper failure diagnosis (2026-10-23)

**Recognition result: FAIL for the tested synthetic phrase. No confirmed production-code defect identified. Overall P4 remains FAIL / not accepted.** Read §23 first. This investigation changed no production source/settings, made no live call, accessed no database, downloaded no model, and enabled no dispatch. Two disposable synthetic inputs were used in WSL; both were removed with their harness directories.

### Configured runtime, model, language, and task

The running deployment is configured with `SPEECH_PROVIDER=whisper`, `SPEECH_SYNTHESIS_PROVIDER=espeak`, and Whisper language setting `auto`. At `/home/resus/whisper.cpp/build/bin/whisper-cli`, the installed runtime reports `whisper.cpp version: 1.9.5-dev`. The configured model is `/home/resus/whisper.cpp/models/ggml-base.en.bin`, 147,964,211 bytes, SHA-256 `a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002`. Its name identifies the English-only base model; the runtime loaded it and completed inference, confirming that this file is accepted by the installed build. The container `file` utility reports generic `data`, which is expected for this binary model and does not independently decode its internal format.

For request language `en`, the provider resolves configured `auto` to effective `en`. Configured threads are 4. It invokes the binary with `-m MODEL -f WAV -t 4 -l en -ojf -nt`; it does not pass `-tr`, and this runtime reports translation default `false`, so the task is transcription. Runtime help advertises `-ojf`, `-nt`, `-l`, `-m`, and `-f`; an independent direct invocation using the same arguments exited 0. Provider error handling tries `-oj` only if `-ojf` throws. The provider does not expose which JSON flag branch it took in diagnostic records, so the historical §23 invocation’s branch cannot be proven from its retained metadata; the direct `-ojf` test now confirms that the installed runtime supports the primary flag.

### Verified audio and inference stages

Using configured `/usr/bin/espeak-ng`, voice `en-us`, configured speed 165 WPM, and the known phrase “This is a synthetic speech test.”, the WAV input was RIFF/WAVE PCM, mono S16LE at 22,050 Hz, 47,420 samples, 2,151 ms, 94,884 bytes. Source peak was 24,435 and RMS 2,853. The adapter decoded little-endian signed 16-bit samples, resampled mono to 16 kHz, and encoded a 68,862-byte mono S16LE WAV with 34,409 samples and the same rounded duration; peak/RMS were 23,986/2,759. This conversion code does not apply gain normalization; the small peak/RMS differences are consistent with resampling, and no clipping was reported.

To isolate runtime invocation and extraction, the same prepared 16 kHz audio was also passed directly to whisper.cpp with the provider's `-m/-f/-t/-l/-ojf/-nt` arguments. That direct invocation exited 0. Both the direct JSON (read and parsed in memory using the provider's `parseWhisperJson`) and `WhisperSpeechProvider` returned the same normalized result and confidence (0.5267458). Neither matched the expected phrase exactly or after lowercase/NFKC/punctuation/whitespace normalization. Direct inference took 2,026 ms and the adapter path 1,729 ms. No transcript text was printed, logged, or included in files outside the automatically cleaned temporary inference directory.

Because live AudioSocket input is raw 8 kHz mono S16LE, a second representation of the same eSpeak-generated phrase was downsampled to 8 kHz mono raw PCM and passed through the adapter. It contained 17,205 samples / 34,410 bytes, 2,151 ms, peak 23,079 and RMS 2,671. The provider decoded it at the documented assumed 8 kHz, resampled it to 34,410 samples at 16 kHz, and prepared a 68,864-byte mono S16LE WAV. An independent direct invocation on that exact prepared file also exited 0. Direct and adapter normalized outputs and confidence matched (0.5195059), but neither matched the expected phrase. Direct/adapter inference took 1,830/1,671 ms. Thus both WAV-input and AudioSocket-like raw-PCM adapter branches executed successfully and repeated the recognition failure.

### Assessment

**Confirmed:** eSpeak generated valid mono 16-bit WAV; the configured base.en model and runtime loaded; the runtime accepted the exact provider arguments and `-ojf`; effective language was English and translation was off; WAV and raw PCM conversions yielded the adapter's 16 kHz mono WAV contract; provider and direct invocation produced matching parsed output/confidence for both representations; exact and normalized phrase recognition failed twice. Buffer inputs remained live through each awaited adapter call. Temporary synthetic audio, normalized input, JSON outputs, and harnesses were kept in disposable test directories and removed; cleanup checks passed.

**No confirmed defect:** observed data does not show incorrect endianness, channel count, rate, amplitude scaling, duration, task/language selection, unsupported flags, subprocess failure, JSON extraction disagreement, or adapter/direct divergence. No production change is justified by this evidence.

**Remaining hypotheses/limits:** the configured base.en model may fail on this particular short eSpeak utterance or its pronunciation; this single voice/phrase is not a representative speech benchmark. Numeric RMS/peak and valid PCM do not measure intelligibility. The direct path deliberately used the adapter-produced 16 kHz WAV and the same JSON parser, so this is strong evidence against invocation/parser divergence but not an independent parser implementation. The provider's internal retry branch is not logged, though direct `-ojf` works. We did not inspect or listen to raw audio.

**Smallest next experiment:** before another live call, generate one additional disposable, phonetically simple English phrase with the same installed eSpeak voice, and repeat the paired direct-versus-adapter test (including the raw 8 kHz input branch). Compare only in memory and retain match booleans plus metadata. If both paths agree and recognize the control but not the original phrase, the issue is phrase/voice/model robustness; if both fail the control too, investigate the local base.en model/runtime behavior with another deterministic known reference. If direct and adapter diverge, then investigate the specific adapter branch with a focused regression test. Do not alter production settings/code until a specific defect is established. P4 remains FAIL pending full live acceptance.

## 25. Controlled Whisper model capability check (2026-10-23)

**Result: mixed/limited recognition; not reliable across this small synthetic phrase set. P4 remains FAIL / not accepted.** Read §24 first. No live call, database operation, production code/configuration change, model download, dependency installation, or dispatch action occurred.

### Method

Re-read the configured runtime and model through the project's Module 2 configuration. Runtime was `/home/resus/whisper.cpp/build/bin/whisper-cli`, version `1.9.5-dev`; model was `/home/resus/whisper.cpp/models/ggml-base.en.bin`, 147,964,211 bytes, SHA-256 `a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002`. Configuration resolved request language `en` from `auto`, used 4 threads, and did not enable translation. The direct invocation used the provider-compatible `-m/-f/-t/-l/-ojf/-nt` flags. The configured eSpeak voice and speed generated seven distinct short English sentences from expected strings stored only in the disposable harness. Each eSpeak RIFF/WAVE S16LE file was mono at 22,050 Hz, then passed through the existing decoder/resampler/WAV encoder to the provider's 16 kHz mono WAV format before direct whisper.cpp inference. Expected and recognized strings were compared in memory using exact trim comparison and lowercase/NFKC/punctuation/whitespace normalization.

### Aggregate result

| Measure | Result |
|---|---:|
| Synthetic phrases | 7 |
| Inference failures | 0 |
| Exact phrase matches | **3/7** |
| Normalized phrase matches | **4/7** |
| Source audio format | RIFF/WAVE PCM, S16LE, mono, 22,050 Hz |
| Source duration | 1,987–2,608 ms; mean 2,252 ms |
| Whisper inference time | 1,658–1,992 ms; mean 1,764 ms |

No per-phrase outputs or recognized transcript text were printed, logged, or retained. The CLI's temporary JSON output was parsed in memory within the disposable test directory and removed with the WAVs, prepared WAVs, phrase input files, and temporary harness. Cleanup verification found no test-specific harness or audio directory remaining. The test used direct whisper.cpp only; paired direct-versus-adapter agreement had already been observed for the original phrase in §24, but the adapter was not rerun on all seven phrases. No automated test suite or typecheck was needed because source was unchanged.

### Interpretation and next step

The model/runtime can recognize some eSpeak-generated English samples, but 4/7 normalized and 3/7 exact matches do not demonstrate reliable recognition even for this limited sample. The earlier phrase failure therefore is not evidence that the model cannot recognize any synthetic English speech; it is also not explained by live microphone/VAD alone. This is a small eSpeak-only diagnostic, not a general accuracy benchmark, and it does not establish that the voice output is acoustically representative of MicroSIP speech.

No production adapter defect is established. Before another live call, the smallest targeted follow-up is to repeat this same disposable set through `WhisperSpeechProvider` under `synthetic-test` scope and compare only per-sample match booleans and result agreement in memory. That would determine whether adapter behavior diverges across varied phrases without retaining transcript content. Do not change the model, adapter, VAD, or production settings based on these aggregate results alone. Keep P4 FAIL until the coordinated live acceptance criteria pass.

### §25 paired adapter follow-up

The seven-sample set was subsequently rerun through both direct whisper.cpp and the existing `WhisperSpeechProvider`, using the same prepared 16 kHz mono WAV inputs, model, language, and inference flags. All 14 inferences completed without errors. Direct and adapter exact matches were each **3/7**; normalized matches were each **4/7**. The normalized outputs agreed sample-by-sample **7/7**, and confidence values agreed **7/7**. Mean inference time was 1,770 ms direct and 1,716 ms through the adapter. These comparisons were made in memory; neither recognized text nor individual phrase outcomes were emitted or retained.

The paired harness used disposable input WAVs, intermediate WAVs and CLI JSON, all removed. The temporary harness and test directories were checked absent (`TEMP_ARTIFACT_CLEANUP=PASS`). This confirms no observed direct-versus-adapter divergence for this small set; the mixed recognition result remains a limited model/voice capability observation, not a benchmark or proof of the live-call cause. No production changes or automated test/typecheck runs were needed. **P4 remains FAIL / not accepted.** The next justified step is to obtain an independently verified intelligible reference sample or stronger live-call acoustic evidence before considering production changes; do not tune settings from this small eSpeak set.

## 26. Whisper suitability review and P4 acceptance plan (2026-10-23)

**Assessment: technically compatible for English inference, but suitability for a reliable controlled demonstration is not established; do not accept the current recognizer based on the available results. Overall P4 remains FAIL / not accepted.** Review of §§21–25 and local model/runtime documentation only. No live call, audio generation, model/configuration change, dependency install, dispatch action, or database operation occurred.

### Model identity, intended language, and invocation

The configured file remains `/home/resus/whisper.cpp/models/ggml-base.en.bin` (147,964,211 bytes; SHA-256 `a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002`). The basename identifies the English-only base variant; the installed whisper.cpp runtime reports `1.9.5-dev` and has loaded this file for completed inference. The repo deployment guide also configures a `ggml-base.en.bin` path. This verifies the local file/runtime pairing is accepted and is intended for English; it does not independently establish model quality. whisper.cpp help and the provider source support the configured `-m/-f/-t/-l/-ojf/-nt` invocation. For effective language `en`, `auto` resolves to English; translation is off and threads are 4. The provider converts input to 16 kHz mono WAV and parses whisper.cpp JSON. The project advertises `en` and `ml` as supported languages, whereas this `.en` model is English-only; this P4 plan therefore covers English only and does not validate Malayalam recognition.

### Evidence and what it establishes

Across seven disposable eSpeak English samples, direct whisper.cpp and `WhisperSpeechProvider` each completed all inferences. Both achieved 3/7 exact and 4/7 normalized phrase matches. Their normalized outputs and confidence values agreed on all seven samples. A separate known synthetic phrase also failed through both direct and adapter paths. Historical live calls failed to persist the requested caller phrase; Module 5 remained `ESCALATED`. The latest live call did clean up Asterisk channels, AudioSocket peers, and tracked call legs; prompt audibility for that call was not confirmed.

**Proven:** the configured runtime accepts the model and provider options; direct and adapter outcomes agreed on the seven-sample set; recognition was mixed on that set; the target phrase has failed offline and live; and the observed live Module 5 scenario escalated. **Not proven:** that the model is generally incapable, that the adapter is defective, that the model alone caused live failures, that live caller audio was intelligible, or that VAD, echo, and segmentation caused the failures. The eSpeak set is small and does not independently establish the intelligibility of every generated sample. Aggregate accuracy cannot identify a root cause.

### Proposed measurable acceptance matrix

| Gate | PASS criterion for the controlled English demonstration | Current status |
|---|---|---|
| Offline known-phrase recognition | On a fixed, documented seven-phrase synthetic English set, all seven are normalized matches through the adapter; direct CLI and adapter agree for all seven. Expected text stays in memory. | **FAIL** — 4/7 normalized matches; not reliable enough for this gate. |
| Live synthetic caller speech | In one coordinated call, the predeclared target phrase appears as the corresponding persisted CALLER result (normalized match); correlated segment/preprocess/inference diagnostics are complete and no transcript text or raw audio is retained in diagnostics. | **FAIL** — target absent in prior live calls. |
| Module 5 progression | Before the call, name the approved synthetic scenario and expected next protocol state; after the matched caller response, observe that expected progression without an escalation caused by recognition failure. | **FAIL** — prior test remained `ESCALATED`; scenario-specific progression not evidenced. |
| Prompt audibility | Operator explicitly confirms hearing the prompt in the same coordinated call. | **BLOCKED** — not confirmed for latest call. |
| Hangup and dispatch safety | After hangup, zero active Asterisk channels, established AudioSocket peers, and tracked call legs; protocol state matches its documented completion/retention semantics; automatic dispatch verified disabled before and after. | **PASS, limited for latest call** — media/call-leg cleanup passed and escalation was intentionally retained; this does not offset other failed gates. |

These are demonstration gates, not clinical validation or a broad accuracy benchmark. If the protocol's expected state for the chosen synthetic phrase is not defined in advance, do not use that call as acceptance evidence.

### Recommended next single experiment

Before another live call, run one disposable **offline intelligibility-confirmed control**: use the already-installed eSpeak binary to synthesize the seven fixed harmless phrases, play them locally to the operator and have the operator confirm each phrase is intelligible, then pass those same temporary WAVs through the existing preprocessing path and both direct whisper.cpp and `WhisperSpeechProvider`. Compare only exact/normalized booleans and direct/adapter agreement in memory; retain aggregate counts and format/timing metadata only, then delete all generated files. This separates eSpeak sample intelligibility from recognizer behavior without MicroSIP, VAD, or live capture and repeats the adapter-parity check on the complete set. No private recordings or external models are needed. Proceed to the one-call live acceptance experiment only if the offline seven-phrase adapter gate passes and the approved Module 5 scenario/state is specified; otherwise investigate the offline recognition limitation first. Keep P4 FAIL until every matrix gate passes.

## 27. Offline intelligibility-confirmed repeat blocked (2026-10-23)

**Status: BLOCKED; the exact seven-phrase set cannot be reproduced safely from retained project artifacts. P4 remains FAIL / not accepted.** This check reviewed §§25–26, the repository, the previously recorded harness path, and local PowerShell history by searching only for the unique temporary harness identifiers. It did not generate or play audio, invoke Whisper, place a call, change code/configuration, install dependencies, access the database, or enable dispatch.

Section 25 records that the seven expected phrases existed only in the disposable harness and that its phrase files, WAVs, JSON, and harness were removed. Both known temporary harness paths were checked and are absent. The local PowerShell history has no entries matching the unique harness identifiers. The reports preserve aggregate counts and audio metadata but intentionally do not contain the phrases or a phrase-set hash. Therefore the prior set cannot be reconstructed and independently listened to without inventing or silently substituting phrase content. No intelligibility result, new inference result, or cleanup result for generated media exists in this run because no media was generated.

**Smallest next action:** provide the exact seven harmless phrase strings or the original approved harness/set artifact. Alternatively, authorize establishing a newly documented canonical seven-phrase set, explicitly treated as a new experiment rather than a reproduction. Then generate only disposable eSpeak audio, allow the operator to listen and confirm each phrase, compare direct whisper.cpp and `WhisperSpeechProvider` in memory, and remove all generated files. Do not proceed to a live P4 call until the offline acceptance gate in §26 passes. No transcript text or raw audio should be logged or retained. P4 remains FAIL.

## 28. Recheck of offline seven-phrase reproduction (2026-10-23)

**BLOCKED; the exact previous phrase set and harness remain unavailable. P4 remains FAIL / not accepted.** A fresh workspace filename search found only the existing Whisper provider/diagnostic test files; neither contains the seven expected synthetic phrases or the disposable harness. Local PowerShell history still has no matching harness command, and both previously recorded `/tmp` harness paths are absent. Sections 25–27 retain only aggregate results, not phrase strings or a set hash.

No WAV was generated, so there was nothing safe to play for operator intelligibility confirmation; no direct or adapter inference was run, and this attempt has no new recognition counts or generated-file cleanup result. No production changes, live calls, dispatch actions, or database operations occurred. Do not substitute another phrase set while claiming reproduction. Next requirement remains the original seven phrases/harness, or explicit approval to define a newly documented set and treat it as a new experiment. P4 stays FAIL pending offline and end-to-end acceptance.

## 29. Pending Malayalam Whisper feasibility fixtures (2026-10-23)

**Status: BLOCKED pending Malayalam-speaker review of candidate wording; no Malayalam audio or inference has been produced. P4 remains FAIL / not accepted.** This is an offline recognition feasibility proposal only, not clinical validation. The pending English fixture experiment remains separate and untouched.

### Local prerequisites

The isolated multilingual model is `/home/resus/p4-ml-experiment/ggml-base.bin`, size 147,951,465 bytes, SHA-256 `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`. The production `WHISPER_CPP_MODEL` remains `/home/resus/whisper.cpp/models/ggml-base.en.bin`. Local source advertises `ml` as a supported language and the Whisper provider accepts it. eSpeak NG 1.52.0 is installed, and `espeak-ng --voices=ml` lists `ml` as `Malayalam` (`dra/ml`). The proposed output directory `/home/resus/p4-ml-experiment/audio-fixtures` is absent; its parent is mode 700 and writable by `resus`. No directory or audio was created for this proposal. The backend remains active/healthy; no configuration or service was changed. Automatic dispatch remains disabled.

### Candidate phrases for Malayalam-speaker review

These simple statements are synthetic test material. They are **not** Module 5 protocol wording, clinical instructions, or approved emergency guidance. Malayalam wording and English glosses are provisional; do not synthesize until a fluent Malayalam speaker confirms or corrects them.

| # | Proposed Malayalam text | Provisional English meaning |
|---|---|---|
| 1 | ഇത് ഒരു പരിശീലന സന്ദേശമാണ്. | This is a training message. |
| 2 | പരിശീലന വാഹനം റോഡരികിൽ നിൽക്കുന്നു. | The training vehicle is stopped by the roadside. |
| 3 | സഹായസംഘം സ്ഥലത്തെത്തി. | The assistance team has arrived at the location. |
| 4 | സിമുലേഷൻ ഇപ്പോൾ ആരംഭിക്കുന്നു. | The simulation is starting now. |
| 5 | ഈ ഉദാഹരണം യഥാർത്ഥ അടിയന്തരാവസ്ഥയല്ല. | This example is not a real emergency. |
| 6 | പരിശീലന സംഘത്തിൽ മൂന്ന് പേർ ഉണ്ട്. | There are three people in the training team. |
| 7 | പരീക്ഷണ സന്ദേശം ഇപ്പോൾ അവസാനിക്കുന്നു. | The test message is ending now. |

### Pending method (requires phrase review first)

After a Malayalam speaker approves/corrects the wording and meanings, keep the final expected strings in a disposable test harness, synthesize with the installed `espeak-ng -v ml` into a mode-700 temporary directory, and let the reviewer confirm each WAV is intelligible before inference. Prepare each same WAV through the repository's existing decode/resample/encode helpers; run direct whisper.cpp and `WhisperSpeechProvider` on identical prepared samples with the isolated model path and explicit language `ml` (4 threads, no translation). Do not set or modify `WHISPER_CPP_MODEL`; pass the test-only model path to the harness. Compare exact and normalized matches and direct/adapter agreement in memory; emit aggregate counts and metadata only, never recognized transcript text. Remove the temporary audio, prepared WAVs, JSON output, and harness after the run and verify cleanup. No inference, live call, Module 5 behavior, dispatch setting, or production configuration is part of this experiment.

**Next required approval:** have a fluent Malayalam speaker review all seven proposed phrases and English meanings for naturalness, ambiguity, and any unintended instructional meaning. Wait for that review before generating audio. Even a successful offline result would show only feasibility on these synthetic phrases, not clinical correctness or P4 acceptance.

## 30. Malayalam offline synthetic recognition attempt (2026-10-24)

**Execution status: BLOCKED before test startup; P4 remains FAIL / NOT ACCEPTED.** The requested WSL paths could not be accessed: invoking `wsl.exe --exec sh -lc ...` failed with `Wsl/Service/E_UNEXPECTED` (the WSL service reported a catastrophic failure) before the shell ran. As a result, accessibility of `/home/resus/p4-ml-experiment/ggml-base.bin`, `/home/resus/whisper.cpp/build/bin/whisper-cli`, and `espeak-ng` could not be verified. No alternate model or environment was used.

No temporary audio or harness was created; no recognition inference occurred. Exact matches: **0/7 measured (not run)**. Normalized matches: **0/7 measured (not run)**. Raw transcripts and audio were neither printed nor persisted. Temporary artifact cleanup: **not applicable; none created**. This failure provides no recognition or intelligibility evidence and does not satisfy any P4 acceptance criterion. No production configuration, services, calls, dispatch, clinical logic, or database state was touched.

**Next action:** make the existing WSL environment available, then rerun this exact seven-phrase test with explicit language `ml` and the specified isolated model and binaries.

### WSL diagnosis follow-up (2026-10-24)

The attached archive was inspected read-only. The extracted `logs.etl` was converted with `tracerpt.exe`; the ETL contained system/provider metadata (including virtual-disk component symbols) but no decoded event tying this startup failure to a specific cause. The available `wslservice.txt` confirms `WslService` was running. `wsl --list --verbose` confirms Ubuntu is registered as WSL2 and stopped. The retry `wsl -d Ubuntu --exec /bin/true` still fails with `Wsl/Service/CreateInstance/E_FAIL`, error code 6, failure step 2. The checked Hyper-V Compute Admin log had no events in the 10:15–10:45 window; System events in that interval included informational Hyper-V virtual-switch activity but no identified disk/VM initialization failure. The Lxss Operational event channel was unavailable on this host. **Root cause remains unknown; evidence is insufficient to justify a service restart, configuration change, security change, or disk operation.** No such operation was performed. WSL remains unavailable, so Malayalam synthesis/inference was not resumed; counts remain not run and no test artifacts were created. P4 remains FAIL / NOT ACCEPTED.

### Isolated Malayalam synthetic feasibility run (2026-10-24)

**Limitation:** all seven phrases remain provisional and have not been reviewed by a fluent Malayalam speaker. This offline synthetic feasibility result is not linguistic, clinical, or P4 acceptance evidence.

WSL became available after the preceding blocked attempt. The isolated model SHA-256 was verified before and after the run as `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`. eSpeak NG 1.52.0 synthesized all seven exact §29 phrases with voice `ml`; whisper.cpp was run once per WAV with the isolated model and explicit `-l ml`, four threads, timestamps disabled, and translation off. All seven synthesis and inference commands completed with exit code 0; no errors were reported. The production English-only model/configuration was not used or changed.

| Phrase | WAV duration (s) | Whisper runtime (s) | Exact | Normalized |
|---:|---:|---:|:---:|:---:|
| 1 | 2.579 | 2.487 | No | No |
| 2 | 3.260 | 2.459 | No | No |
| 3 | 2.357 | 2.134 | No | No |
| 4 | 2.676 | 2.124 | No | No |
| 5 | 3.535 | 4.067 | No | No |
| 6 | 2.948 | 2.179 | No | No |
| 7 | 3.404 | 2.428 | No | No |
| **Total** | **20.759** | **17.878** | **0/7** | **0/7** |

All WAVs were valid mono PCM WAVE, 16-bit, 22,050 Hz. Exact comparison used Unicode NFC plus trimming outer whitespace. Malayalam-aware normalization used NFC and casefolding, removed Unicode punctuation, collapsed whitespace, and preserved all other code points, including letters, combining marks, and word boundaries. The recognized outputs did not match the expected Malayalam phrases; the full per-phrase expected and recognized strings, timings, audio metadata, commands, and stdout/stderr are retained in `/home/resus/p4-ml-experiment/runs/malayalam-seven-phrases-20261024T054218Z/` (`results.json` and numbered artifacts). Audio and result artifacts are intentionally retained only in this isolated experiment directory. No live calls, external services, dispatch, clinical logic, production configuration, or database operations were used.

**P4 remains FAIL / NOT ACCEPTED.** This synthetic offline test does not satisfy the separate end-to-end acceptance criteria.

### Audio review and P4 acceptance audit (2026-10-24)

**Human intelligibility and phrase matching remain NOT VERIFIED.** The saved seven-item checklist was inspected and all intelligibility/match boxes remain blank; no human judgments were supplied or inferred. No one listened to these files during this audit. A fluent Malayalam speaker must review them before any further Whisper parameter experiments.

The seven saved WAVs were opened locally with Python's `wave` reader and each was confirmed to be nonempty mono PCM WAVE, 16-bit, 22,050 Hz. Durations matched the recorded experiment metadata. Windows can read the files directly through `\\wsl.localhost\Ubuntu`; `ffplay.exe` is installed, so copying is unnecessary. A blank checklist with the exact expected phrases, Windows paths, durations, and two human judgment boxes is saved at `/home/resus/p4-ml-experiment/runs/malayalam-seven-phrases-20261024T054218Z/AUDIO_REVIEW_CHECKLIST.md`.

| ID | Expected phrase | Audio path (Windows UNC) | Duration | Human review |
|---:|---|---|---:|---|
| 1 | ഇത് ഒരു പരിശീലന സന്ദേശമാണ്. | `\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z\01.wav` | 2.579 s | Pending |
| 2 | പരിശീലന വാഹനം റോഡരികിൽ നിൽക്കുന്നു. | `\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z\02.wav` | 3.260 s | Pending |
| 3 | സഹായസംഘം സ്ഥലത്തെത്തി. | `\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z\03.wav` | 2.357 s | Pending |
| 4 | സിമുലേഷൻ ഇപ്പോൾ ആരംഭിക്കുന്നു. | `\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z\04.wav` | 2.676 s | Pending |
| 5 | ഈ ഉദാഹരണം യഥാർത്ഥ അടിയന്തരാവസ്ഥയല്ല. | `\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z\05.wav` | 3.535 s | Pending |
| 6 | പരിശീലന സംഘത്തിൽ മൂന്ന് പേർ ഉണ്ട്. | `\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z\06.wav` | 2.948 s | Pending |
| 7 | പരീക്ഷണ സന്ദേശം ഇപ്പോൾ അവസാനിക്കുന്നു. | `\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z\07.wav` | 3.404 s | Pending |

To play them sequentially in Windows PowerShell:

```powershell
$base = '\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z'
$player = 'F:\aimovie\ffmpeg_extracted\ffmpeg-8.0.1-essentials_build\bin\ffplay.exe'
1..7 | ForEach-Object {
  $wav = Join-Path $base ('{0:D2}.wav' -f $_)
  Write-Host "Phrase $_ — $wav"
  & $player -nodisp -autoexit -loglevel error $wav
  Read-Host 'Record intelligibility and phrase match on the checklist, then press Enter'
}
```

#### P4 criteria status

| Criterion | Status | Evidence / smallest next step |
|---|---|---|
| Seven Malayalam synthetic files generated and valid | **PASS** | Seven valid WAVs; format/durations verified above. Phrases are provisional and unreviewed. |
| Offline Malayalam phrase recognition | **FAIL** | Saved run used explicit `-l ml`; 0/7 exact and 0/7 normalized. Do not tune further until human audio review. |
| Human intelligibility and match to intended text | **NOT VERIFIED** | Fluent Malayalam speaker review pending; use the checklist above. |
| Local SIP/RTP/AudioSocket setup and resource cleanup | **PASS (historical)** | Previous controlled call §13; not repeated because live calls are prohibited in this audit. |
| Expected caller phrase recognized in the live call | **FAIL** | §13 persisted fragments/blanks; requested phrase absent. A new live call is not authorized in this task. |
| Module 5 progression from intended caller phrase | **FAIL** | §13 stayed at `confirm-arrest`, then escalated after blank/incorrect utterances. |
| eSpeak generation/send over AudioSocket | **PASS (historical)** | §13 records five send attempts. |
| Human-confirmed MicroSIP prompt audibility | **NOT VERIFIED** | No independent client playback confirmation in §13. A future controlled call requires separate authorization. |
| Module 5 post-hangup state and resource cleanup | **PASS (limited to escalated-record retention); NOT VERIFIED for ordinary waiting session** | Historical call/media cleanup passed; §14 and `SessionService.escalate` specify that an `ESCALATED` protocol record remains open with its active step and `completedAt=null` for operator review. AudioBridge closes its connection and releases per-call controller state. The repository does not specify whether an ordinary `WAITING_FOR_RESPONSE` protocol should remain active after hangup or receive a neutral disconnect state. |
| Automatic dispatch disabled | **PASS (configuration gate)** | Current server process and `/home/resus/resus/.env` have no `MODULE6_AUTO_DISPATCH_ENABLED` value; code enables only explicit `true`. The bounded config/auto-dispatch suites below passed. No dispatch was triggered. |
| Overall P4 acceptance | **FAIL / NOT ACCEPTED** | Live phrase recognition and Module 5 lifecycle failed; human audio validation and client audibility remain unverified. |

Safe bounded synthetic tests run from `F:\minor`:

```text
npm test -- --reporter=dot modules/module_01_emergency_call/tests/callService.test.ts modules/module_02_speech_processing/tests/speechService.test.ts modules/module_02_speech_processing/tests/realSpeechProviders.test.ts modules/module_05_bystander_assistance/tests/sessionService.test.ts modules/module_06_ambulance_management/tests/config.test.ts modules/module_06_ambulance_management/tests/autoDispatch.test.ts
Test Files  6 passed (6)
     Tests  132 passed (132)
Exit code: 0
```

These suites use fake call adapters, in-memory protocol storage, synthetic audio/provider fixtures, and dispatch-gate stubs; they do not place calls, contact external services, or test the real engines. The Module 5 tests emitted expected heuristic-fallback warnings. No live call, database operation, clinical/protocol edit, or production telephony/model change was made. `git diff --check` was run after this audit update; it reported no whitespace errors (only the repository's existing CRLF conversion warnings on unrelated modified files).

#### Additional bounded controller evidence (2026-10-24)

The separate fake-backed Asterisk conversation controller suite was run because it covers protocol start, forwarding caller text, turn prompting, terminal-status prompt suppression, and duplicate-connect handling without repeating the prior six suites:

```text
npm test -- --reporter=dot tests/asteriskConversationController.test.ts
Test Files  1 passed (1)
Tests  11 passed (11)
Exit code: 0
```

This synthetic controller result does not establish that the real phone path recognized a caller phrase, that the intended Module 5 state followed that phrase in a real call, that MicroSIP rendered audible prompts, or that the session closed after hangup. Those remain failed or unverified as marked above. The remaining acceptance evidence requires one coordinated, harmless controlled call with a predeclared expected caller phrase and Module 5 state, human confirmation of prompt audibility, and post-hangup verification of session semantics and dispatch-disabled state; no such call was made in this audit.

After this report update, `git diff --check` exited 0 with no whitespace errors; Git emitted LF-to-CRLF conversion warnings for existing modified worktree files.

#### Additional bounded audio-bridge evidence (2026-10-24)

Because the unresolved gates include caller phrase handling and teardown, the separate fake-backed AudioBridge conversation suite was also run; it was not part of the prior 132-test batch or the controller suite above:

```text
npm test -- --reporter=dot modules/module_01_emergency_call/tests/audioBridgeConversation.test.ts
Test Files  1 passed (1)
Tests  14 passed (14)
Exit code: 0
```

The suite exercises synthetic utterance forwarding/protocol advancement, closed-stream transcription and playback guards, and conversation release on close. Its transcriber, media stream, and call context are test doubles. It does not reverse the failed historical live-phrase or Module 5 evidence and does not establish human MicroSIP audibility or persistent Module 5 hangup closure. Those require the coordinated controlled call described above; no call was made. The audio checklist remains blank, and no further Whisper inference was run.

The final `git diff --check` after this report update exited 0; only existing LF-to-CRLF conversion warnings were emitted, with no whitespace errors.

#### Controlled-call plan prepared, not executed (2026-10-24)

The saved Malayalam checklist was re-read for this plan: **0 of 14 human-review fields are completed** (seven intelligibility fields and seven intended-phrase-match fields). Human review remains pending; no intelligibility or match judgment is inferred. No call or additional Whisper inference was run.

The following is a proposed single harmless local test using `isSimulation=true`, incident type `OTHER` (which resolves to the `general-triage` catalogue), and local MicroSIP extension 1001 only. Use no real person, address, emergency number, dispatch endpoint, or patient data. It is not authorization to run the call.

| Plan item | Proposed check | Evidence boundary |
|---|---|---|
| Exact caller phrase | First say: “Hello, this is a test call. I am checking the RESUS audio system.” Then say: “I am at Synthetic Test Site Seven.” Both are synthetic test utterances; the first is the phrase used in prior controlled-call evidence (§13). | The correlated `CALLER` transcript must contain each phrase, compared after Unicode NFC and trimming outer whitespace. Prior calls failed the first phrase check. |
| Module 5 behavior | `OTHER` resolves to `general-triage`, whose entry step is `confirm-location` and requires `caller_location`. The first test phrase contains no location, so expect `WAITING_FOR_RESPONSE`, remain at `confirm-location`, and ask for the exact location. The second phrase provides a synthetic location; expect `ADVANCED` to `confirm-safety` with no emergency action. Stop there and hang up. | Grounded in the catalogue transition (`caller_location exists` → `confirm-safety`), `callerLocation`'s explicit “I am at …” pattern, and the engine's missing-fact clarification behavior. If runtime fact extraction does not preserve these expected outcomes, stop and record failure; do not continue the protocol. |
| MicroSIP audibility | A human listener at the active MicroSIP audio output confirms hearing the expected eSpeak prompt during this same call; record only call ID, prompt, and yes/no confirmation, not a private recording. | Must be direct human confirmation; server-side send records alone are insufficient. |
| Hangup and Module 5 lifecycle | Hang up the same test call; verify the call row is `ENDED`, Asterisk channels/calls and established AudioSocket peers are zero, and per-call controller state is released. Inspect the protocol record without editing it. | The current code will leave the non-escalated protocol at `WAITING_FOR_RESPONSE` on `confirm-safety`, active step, `completedAt=null`: `CallService.close` ends the call row but does not transition Module 5; `AudioBridge.onClose` deletes connection state, clears its timer, and calls `conversation.forget`. **BLOCKED — confirmation required:** decide whether retaining this ordinary in-progress protocol for operator review is acceptable or whether a neutral disconnect lifecycle is required. Do not implement completion/cancellation as a substitute. |
| Dispatch safety | Before and after the call, read the running server environment and `.env`; verify `MODULE6_AUTO_DISPATCH_ENABLED` is unset/false and code remains fail-closed unless explicitly `true`. Do not call dispatch endpoints; verify no assignment/dispatch event was created by the test. | Existing audit evidence shows the key unset and explicit-true gating. This is a read-only pre/post check, not a dispatch exercise. |

Stop immediately if either phrase is not recognized, the Module 5 state differs from the expected state, a prompt is not human-confirmed audible, any call/media/controller resource remains after hangup, or dispatch is not demonstrably disabled. **BLOCKED — confirmation required before executing the planned call:** confirm whether a non-escalated `WAITING_FOR_RESPONSE` Module 5 record may remain open after the telephony call ends, or specify the intended neutral disconnect lifecycle. Escalated-record retention is explicitly documented; ordinary waiting-session retention is not. Overall P4 stays **FAIL / NOT ACCEPTED**.

#### Code-level pipeline and lifecycle audit (2026-10-24)

The seven WAVs were re-read through Python's standard `wave` reader, including all sample frames. All are readable mono PCM WAVE, 16-bit, 22,050 Hz, with durations 2.357–3.535 seconds. This is file-integrity evidence only; it does not establish speech intelligibility. The saved checklist remains blank (0/14 human fields complete).

The retained experiment metadata (read without printing transcript text) confirms all seven synthesis/inference records completed with zero harness errors; eSpeak voice `ml`; explicit whisper.cpp language `-l ml`; isolated multilingual model `/home/resus/p4-ml-experiment/ggml-base.bin`, SHA-256 `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`; exact matches 0/7 and Malayalam-normalized matches 0/7. Exact normalization is NFC plus trim. Malayalam normalization is NFC plus casefold, punctuation removal and whitespace collapse while preserving other code points and word boundaries. No model/language mismatch, invalid WAV, harness exception or compare-normalization defect is evidenced in this run. The cause of the recognition failure remains undetermined: eSpeak pronunciation/intelligibility and recognizer acoustic performance cannot be separated without the pending fluent-speaker review. No inference was run in this audit.

The repository Whisper provider decodes telephony input as mono signed 16-bit PCM (AudioSocket's 8 kHz contract), resamples it to 16 kHz mono WAV, and passes `-l` using either the configured explicit language or the request language when configured as `auto`. The saved Malayalam harness did not use the production model/configuration. Historical live-call diagnostics measured 8 kHz mono 16-bit ingress and successful 16 kHz preprocessing/inference; they did not identify a malformed-rate cause, though weak/ambiguous acoustic activity and VAD segmentation remain hypotheses. The requested English caller phrase was still absent in historical live calls. No concrete speech-pipeline root cause is proven.

Hangup code review found distinct lifecycles: Asterisk hangup invokes `CallService.close`, which hangs up transport, ends the `CallSession`, and records `CALL_DISCONNECTED`; AudioBridge `onClose` removes its connection, marks it closed, clears the silence timer, discards unfinished speech and calls `conversation.forget`; the conversation controller deletes its per-call map entry. Separately, `SessionService.escalate` explicitly says an escalated protocol is deliberately nonterminal so an operator can review the transcript/facts and writes `completedAt=null`. `cancel` is documented for emergency services reaching the scene, so hangup must not call it. Historical `ESCALATED` plus active step and null `completedAt` is expected retention, not a cleanup defect. For a non-escalated `WAITING_FOR_RESPONSE` session, `CallService.close` does not update Module 5 and the repository has no explicit ordinary-disconnect rule; whether that active protocol should remain open is a product/domain decision. The acceptance table above supersedes the older unconditional Module 5 closure FAIL wording: escalated-record retention and call/media cleanup are distinct from the unresolved ordinary-waiting-session rule.

Existing fake-provider tests safely cover these boundaries: the prior `audioBridgeConversation.test.ts` run passed 14 tests including release on stream close; the earlier six-suite run passed the fake Module 6 dispatch config tests; this audit ran the two targeted AMI hangup tests:

```text
npm test -- --reporter=dot modules/module_01_emergency_call/tests/asteriskProtocols.test.ts -t "closes the session when AMI reports the channel hung up|waits for an in-flight open to commit before closing"
Test Files  1 passed (1)
Tests  2 passed | 48 skipped (50)
Exit code: 0
```

No source regression test was added because inspection found no established expected behavior for ordinary Module 5 disconnect to encode. A neutral protocol-disconnect status would be a new domain rule, not a test-only cleanup fix. The proposed two-utterance call is **blocked pending that rule decision**, even though the initial progression expectation is grounded in `general-triage`.

#### Module 5 disconnect owner decision — PENDING OWNER APPROVAL (2026-10-24)

Code review confirms the existing status set has no disconnected protocol state. `CallService.close` ends the telephony call and emits `CALL_DISCONNECTED`, but does not change an ordinary Module 5 session. `SessionService.escalate` intentionally retains an `ESCALATED` session for operator review with `completedAt=null`; `cancel()` is documented for emergency services arriving at the scene and is not an appropriate hangup substitute. AudioBridge/controller teardown removes per-call in-memory resources, which is separate from protocol persistence.

The owner must decide, without treating any option below as an approved policy:

1. When an ordinary `WAITING_FOR_RESPONSE` session loses its telephone connection, should it remain open for operator review? Keeping the current behavior leaves its status/step intact and `completedAt` null, but may leave an active-looking session after its call ended. Transitioning it would require an approved neutral lifecycle rule; no such state currently exists.
2. If it must transition, what exact existing neutral state and transition event are approved? The repository currently defines no disconnected protocol state/event. Reusing `COMPLETED` or `CANCELLED` would assert semantics the code assigns to different outcomes; adding a state/event requires an explicit domain decision and implementation review.
3. Should `completedAt` remain null for a disconnected but unresolved session? Current escalation retention uses null; completion/cancellation set a timestamp. The ordinary disconnect path currently does not alter it. The owner must define its meaning for this case.
4. How should reconnection or operator resumption work, if supported? Current call teardown deletes per-call controller state; no protocol reconnection/resumption contract is established by this code review. Define whether a new call resumes the same persisted protocol and step or starts separately, including duplicate/replay handling.
5. What audit event and user-visible status are required? `CALL_DISCONNECTED` audits the call lifecycle, but there is no distinct protocol-disconnect event/UI status identified for an ordinary waiting session. Define actor/system provenance and the operator-facing status needed to avoid implying that the protocol completed.

**Decision: PENDING OWNER APPROVAL.** Until resolved, the ordinary-session post-hangup acceptance check and the proposed controlled call remain blocked. No Module 5 code or policy was changed.

#### Human audio review and controlled-call preflight (2026-10-24)

The saved review checklist is `\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z\AUDIO_REVIEW_CHECKLIST.md`; all 14 judgments remain blank. WAV paths are `\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z\01.wav` through `07.wav`. The checklist already has separate blank Yes/No fields for intelligibility and intended-text match. Windows `ffplay.exe` and the previously recorded command are:

```powershell
$base = '\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z'
$player = 'F:\aimovie\ffmpeg_extracted\ffmpeg-8.0.1-essentials_build\bin\ffplay.exe'
1..7 | ForEach-Object {
  $wav = Join-Path $base ('{0:D2}.wav' -f $_)
  Write-Host "Phrase $_ — $wav"
  & $player -nodisp -autoexit -loglevel error $wav
  Read-Host 'Record both judgments on AUDIO_REVIEW_CHECKLIST.md, then press Enter'
}
```

A fluent Malayalam speaker should play each clip, compare it with that row's expected text, mark both independent Yes/No fields, save the checklist in place, and return it. No audio was played or judged in this audit.

The following is a readiness checklist only; no call was authorized or executed:

- [ ] Confirm a local simulated call to MicroSIP extension 1001, `isSimulation=true`, incident type `OTHER`; verify automatic dispatch is disabled before starting.
- [ ] Use only these harmless caller phrases: “Hello, this is a test call. I am checking the RESUS audio system.” then “I am at Synthetic Test Site Seven.” Expected progression from the repository catalogue: `general-triage` starts at `confirm-location`; first phrase leaves `WAITING_FOR_RESPONSE` at that step and prompts for location; second phrase supplies `caller_location` and should advance to `confirm-safety`. Confirm the actual transcript and state; stop after that step.
- [ ] Have a human listening at MicroSIP confirm the eSpeak prompt is audible and record the yes/no result. A server send record is not proof of audibility.
- [ ] After hangup, verify the call is `ENDED`, Asterisk channels/calls are zero, AudioSocket peers are zero, and per-call controller state is released; inspect the protocol record read-only.
- [ ] Verify dispatch remains disabled after the call and no assignment/dispatch event was created; do not invoke dispatch endpoints.
- [ ] Capture correlated call/session IDs, exact observed transcripts and state transitions, prompt audibility result, post-hangup resource counts, dispatch gate evidence, and timestamps without credentials or patient data.
- [ ] Stop on phrase/state mismatch, inaudible prompt, residual call/media/controller resource, or any indication dispatch is enabled. Do not progress beyond `confirm-safety`.

**BLOCKED:** the expected ordinary `WAITING_FOR_RESPONSE` protocol result after hangup cannot be accepted until the owner resolves the decision above. This preflight is not call authorization. Overall P4 remains **FAIL / NOT ACCEPTED**.

## P4 Release Blockers (2026-10-24)

Overall status: **FAIL / NOT ACCEPTED**. This handoff summarizes the remaining gates; no new tests or calls were run.

- **Human audio review: BLOCKED** — 0/14 judgments completed. A fluent Malayalam speaker must listen to all seven WAVs, record intelligibility and intended-phrase match separately for each, and save the checklist at `\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z\AUDIO_REVIEW_CHECKLIST.md`.
- **Module 5 disconnect policy: BLOCKED** — the protocol owner must decide whether an ordinary `WAITING_FOR_RESPONSE` session remains open after hangup. If not, the owner must identify an approved existing state/event and define `completedAt`, resumption, audit, and operator-visible behavior. Do not invent a new state or use `cancel()` as a substitute.
- **Controlled end-to-end call: NOT EXECUTED** — wait for the saved human audio review and lifecycle decision; then obtain explicit authorization before the proposed local simulated call. The plan is not authorization.
- **Dispatch: MUST REMAIN DISABLED** — verify disabled before and after any later authorized test; do not invoke dispatch endpoints.

Exit checklist (none of these outcomes is presumed):

- [ ] Fluent speaker completes and saves all 14 audio judgments; record the supplied results without inference.
- [ ] Protocol owner records the ordinary-disconnect decision and answers the lifecycle questions above.
- [ ] Explicit authorization is obtained; only then execute the bounded local simulated call and capture transcript/state progression, human prompt audibility, post-hangup channel/AudioSocket/controller cleanup, and dispatch-disabled evidence.
- [ ] Reconcile each acceptance criterion against captured evidence; mark only demonstrated outcomes, and retain **FAIL / NOT ACCEPTED** while any required criterion is failed or unverified.

## Module 5 ordinary-call-disconnect policy proposal — PROPOSED — PENDING PROTOCOL-OWNER APPROVAL

This is an owner-review proposal, **not an existing repository rule**. Source review shows that Asterisk `CallService.close` ends the telephony `CallSession` and records `CALL_DISCONNECTED` against the call entity. AudioBridge/controller teardown releases per-call media/controller resources. That event currently carries the call ID, emergency ID, duration, and reason; it does not identify the Module 5 protocol session or last protocol step. The protocol status vocabulary has no disconnected state/event. `SessionService.cancel()` represents emergency services reaching the scene and sets `CANCELLED` plus `completedAt`; `escalate()` deliberately retains an unresolved session for operator review with `completedAt=null`.

### Proposed safeguards for owner decision

- Close telephony call resources on hangup.
- Do not treat an unresolved clinical session as resolved or silently cancelled because the call ended.
- Make the disconnect and last known protocol step auditable; current `CALL_DISCONNECTED` evidence alone does not link that event to the protocol session/step.
- Do not set `completedAt` solely because telephony ended, unless the approved lifecycle contract explicitly defines that meaning.
- Permit resumption only through an approved, repository-supported workflow; do not imply reconnection/resumption is currently supported.

### Required owner decision

Choose whether the ordinary unresolved `WAITING_FOR_RESPONSE` session is retained for operator review, or identify an already-supported neutral transition that the owner approves. The current status/event definitions contain no protocol-disconnected state/event; do not invent one in this proposal. If a transition is selected, the owner must also approve the exact `completedAt` semantics, resumption behavior, audit linkage, and operator-visible status. Do not use `cancel()` as a hangup substitute.

### Focused regression-test plan after approval

Do not add or run tests asserting this unapproved policy. Once the owner records the decision, add focused tests around Module 1 call-close/`CALL_DISCONNECTED` and the Module 5 session lifecycle: verify one disconnect audit record, call/media/controller cleanup, preservation of the last known protocol step and collected facts, and the approved status/`completedAt` outcome. If the approved path retains the session, assert it remains unresolved and reviewable; if the owner identifies an already-supported neutral transition, assert that exact transition and event without completion/cancellation semantics. Add a resume/idempotency test only if the approved workflow supports resumption. Confirm the operator-visible status from the actual projection/API before asserting it.

No Module 5 code, tests, or clinical protocol were changed. P4 remains **FAIL / NOT ACCEPTED** pending owner decision and end-to-end evidence.

## Actionable Module 5 owner decision request and test matrix

**Decision request — PENDING APPROVAL:** Choose one policy for an ordinary unresolved `WAITING_FOR_RESPONSE` session when its telephony call disconnects:

- **A. Retain for operator review:** keep the unresolved clinical session and its last protocol step, while clearly auditing that the associated call disconnected.
- **B. Approved neutral transition:** use only a transition that already exists and whose semantics the protocol owner explicitly approves. The repository currently has no dedicated protocol-disconnect state/event; do not add or imply one here.

The owner must explicitly decide the resulting session state, whether `completedAt` remains null, reconnection/resumption behavior, and the audit event plus operator-visible status. `cancel()` has different semantics: the existing service documents it as “Emergency services reached the scene,” writes `PROTOCOL_CANCELLED`, and sets `completedAt`; it is not a hangup substitute. This request proposes no policy and changes no Module 5 behavior.

| Decision / criterion | Focused regression coverage after owner approval | Existing test file(s) and candidate command |
|---|---|---|
| Telephony cleanup on hangup | Call closes once, emits `CALL_DISCONNECTED` once, and media/controller resources release. | `modules/module_01_emergency_call/tests/callService.test.ts` (`records the duration and emits CALL_DISCONNECTED once`, `is idempotent...`); `modules/module_01_emergency_call/tests/audioBridgeConversation.test.ts` (`leaves silent frames alone and releases the conversation on close`). |
| Clinical session persistence and last protocol step | Add the approved disconnect-path test: preserve facts/step and assert either owner-approved retention or exact already-supported transition. | `modules/module_05_bystander_assistance/tests/sessionService.test.ts` (`persists facts and bookkeeping together in one transition`) plus an approved-policy regression; combined command below. |
| `completedAt` | Assert the owner-approved value for a disconnected unresolved session; separately preserve existing completion/cancellation semantics. | `modules/module_05_bystander_assistance/tests/sessionService.test.ts`; do not assert a value before approval. |
| Audit event and operator-visible status | Assert approved audit linkage to the call and protocol/last step, and verify the actual session GET/list response or operator projection. No dedicated Module 5 route test for this disconnect behavior was identified. | `modules/module_05_bystander_assistance/tests/sessionService.test.ts`; add a focused route/projection test only if the approved UI/status contract requires it. `modules/module_01_emergency_call/tests/callService.test.ts` covers the existing call-disconnect event. |
| Resumption, if supported | Test only the approved resume path, preserving session/step and avoiding duplicate transitions; otherwise document no resume workflow. No existing Module 5 resume test was identified. | Candidate: `modules/module_05_bystander_assistance/tests/sessionService.test.ts` and, if call reconnection is part of the approved flow, `tests/asteriskConversationController.test.ts`. |
| Automatic dispatch remains disabled | Keep fail-closed default and disabled subscriber behavior covered. | `modules/module_06_ambulance_management/tests/config.test.ts` and `modules/module_06_ambulance_management/tests/autoDispatch.test.ts`. |

Candidate focused command after the owner decision and implementation (not run for this handoff):

```text
npm test -- --reporter=dot modules/module_01_emergency_call/tests/callService.test.ts modules/module_01_emergency_call/tests/audioBridgeConversation.test.ts modules/module_05_bystander_assistance/tests/sessionService.test.ts modules/module_06_ambulance_management/tests/config.test.ts modules/module_06_ambulance_management/tests/autoDispatch.test.ts
```

### Human audio review handoff

Verified checklist: `\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z\AUDIO_REVIEW_CHECKLIST.md`. The checklist and `01.wav`–`07.wav` exist; 0/14 human judgments are complete. A fluent Malayalam speaker must play all seven clips, mark intelligibility and intended-phrase match separately for each, and save the checklist. Use this existing PowerShell command from Windows:

```powershell
$base = '\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z'
$player = 'F:\aimovie\ffmpeg_extracted\ffmpeg-8.0.1-essentials_build\bin\ffplay.exe'
1..7 | ForEach-Object {
  $wav = Join-Path $base ('{0:D2}.wav' -f $_)
  Write-Host "Phrase $_ — $wav"
  & $player -nodisp -autoexit -loglevel error $wav
  Read-Host 'Record both judgments on AUDIO_REVIEW_CHECKLIST.md, then press Enter'
}
```

No call or tests were run for this handoff. Automatic dispatch remains required to stay disabled; overall P4 remains **FAIL / NOT ACCEPTED**.
