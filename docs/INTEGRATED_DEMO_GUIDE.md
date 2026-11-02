# Integrated RESUS phone-to-dispatch demo

This run uses the existing Fastify composition, configured Asterisk transport,
Module 2 speech providers, Module 5 conversation service, Module 6 assignment
engine, Module 11 persistence, Module 12 dashboard, and Module 8 routing. It
does not reset or migrate the configured database. Start it only when the
existing database, accounts, and Asterisk setup are already ready.

## Start

In PowerShell window 1:

```powershell
Set-Location F:\minor
$env:MODULE8_PROVIDER = 'osrm'
$env:MODULE8_OSRM_BASE_URL = 'http://router.project-osrm.org'
npm run dev
```

This starts the backend and the dashboard together. The backend must report the
Asterisk telephony runtime at startup. Open `http://127.0.0.1:5173` for the
dispatcher and `http://127.0.0.1:5173/driver` in a second browser profile for
the driver. Sign in with existing dispatcher and driver accounts.

`/driver` reads the authenticated driver's persisted offer and polls every 1.5
seconds. Accept and reject are submitted to Module 6; the dispatcher view
refreshes assignment and route state at the same interval. Assignment rejection
requires a dispatcher to make any replacement assignment. The existing explicit
dispatcher dispatch action remains a separate step after acceptance.

## Manual demonstration

1. Confirm the backend is healthy at `http://127.0.0.1:4000/api/health` and its
   startup log identifies `TRANSPORT_PROVIDER=asterisk` and a listening
   AudioSocket port. Confirm the dashboard and `/driver` pages both load.
2. From the SIP phone registered to the configured inbound endpoint, dial the
   configured inbound emergency extension. Use a harmless test call on a local
   test endpoint; do not use an emergency number or real patient information.
3. Speak a test description. The call creates the Module 1 session, Module 2
   recognizes the caller utterance, the Module 5 session asks its next
   protocol-approved question, and Module 2 speaks the response back over the
   same AudioSocket call. The dispatcher transcript panel refreshes from saved
   Module 11 transcript rows while the call is active.
4. Review the emergency and confirm its classification through the authorized
   dispatcher/operator flow. LLM output is not a dispatch gate; the existing
   Module 6 dispatch path remains available independently of LLM health.
5. In the dispatcher workflow, assign an available ambulance. Confirm a new
   `OFFERED` assignment appears in the driver's `/driver` page.
6. Accept the offer in the driver page. Confirm the driver page reports
   `ACCEPTED` and the dispatcher page changes to accepted without manual
   refresh. Repeat on a separate assignment and reject it to show the declined
   backend state; create a replacement only through the dispatcher action.
7. For the accepted assignment, click **Explicitly dispatch ambulance** in the
   dispatcher workflow. Then click **Generate response route** if no route has
   been created. The interactive map displays the persisted OSRM road geometry,
   ambulance position, pickup point, distance, and estimated time.
8. Confirm the route says `provider osrm` and `isLiveTraffic: false`. OSRM uses
   a road network and static speed profile; it is a real road route, but it does
   not provide live traffic. A displayed `mock` provider means the configured
   route provider was unavailable and the existing labelled estimate fallback
   was used; that is not completion of the real-routing demonstration.
9. Stop the processes with Ctrl+C in PowerShell window 1.

## Required configuration and external dependencies

The example file documents the variable names. Do not run database setup or
migrations as part of this demo.

- **Asterisk:** `TRANSPORT_PROVIDER=asterisk`, `TRANSPORT_SIGNALLING_URL`,
  `ASTERISK_AMI_USERNAME`, and `ASTERISK_AMI_SECRET`. `ASTERISK_AMI_SECRET` is
  blank in `.env.example` and must match the Asterisk manager account. Set
  `ASTERISK_INBOUND_LAT` and `ASTERISK_INBOUND_LNG` to the configured service
  area, and `ASTERISK_AUDIOSOCKET_ADVERTISE_HOST` to an address reachable from
  the PBX. Asterisk dialplan, endpoint credentials, and the SIP phone account
  must already be configured as in [asterisk-setup.md](asterisk-setup.md).
- **Speech:** set `SPEECH_PROVIDER=whisper` and
  `SPEECH_SYNTHESIS_PROVIDER=espeak`. `WHISPER_CPP_MODEL` must point to an
  installed Whisper model; `WHISPER_CPP_BINARY`, `ESPEAK_NG_BINARY`, and the
  selected eSpeak voice must be installed and reachable by the server. These
  local providers need no API credentials. `loopback` is simulated and does
  not transcribe or speak real call audio.
- **LLM:** set `LLM_PROVIDER=ollama`, `LLM_MODEL` to a model installed in
  Ollama, and `OLLAMA_BASE_URL` to the reachable local Ollama server. No cloud
  API key is required for this provider. The server may use the configured
  heuristic fallback if Ollama is unavailable; inspect the LLM health/status
  before claiming model-backed conversation. Urgent dispatch must not depend on
  this health state.
- **Routing:** this guide selects OSRM. No API key is required, but the server
  needs outbound network access to `MODULE8_OSRM_BASE_URL`; the browser also
  needs access to OpenStreetMap tiles for the map background. To use Google
  instead, set `MODULE8_PROVIDER=google` and supply a restricted, billing-enabled
  Routes API key in `MODULE8_GOOGLE_API_KEY`; keep it server-side. Google
  credentials are not present in `.env.example`.
- **Backend data:** the configured database must already contain authenticated
  dispatcher and driver users, an available ambulance assigned to the driver,
  and valid ambulance and emergency coordinates. No demo account provisioning
  is performed by this command.

`npm run demo:server` is an isolated simulated browser/demo backend. It
intentionally forces loopback speech and a heuristic provider and must not be
used to claim the Asterisk, live speech, or configured LLM steps above.
