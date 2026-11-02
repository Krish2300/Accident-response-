# Asterisk telephony setup

How to point this system at a real Asterisk PBX so that an emergency call arrives
as a `CallSession` carrying real audio, and the caller hears the greeting in
return.

> **Status.** The adapter, the AMI client, the AudioSocket server and the media
> bridge are implemented and covered by offline protocol tests (they run against
> a scripted AMI peer and a scripted AudioSocket peer over real TCP). The
> configuration below has since been exercised against a real Asterisk 22 in
> this environment for the **inbound** path: a SIP client registered as the
> `emergency` endpoint dialled `exten 1000`, AudioSocket carried the audio, the
> protocol conversation ran and the transcript was stored. The sections below
> remain the exact steps to reproduce that setup. The "Verification" section
> lists what has been observed and the two items that still need a human
> softphone.

## How a call flows

```
   SIP phone ──INVITE──▶ Asterisk ──VarSet/AMI──▶ Module 1 intake ──▶ CallSession
                            │
                            └──AudioSocket(TCP)──▶ AudioSocket server ──▶ AudioBridge
                                                        │  ▲                │
                                            (PCM both ways)          greeting: speak()
                                                        ▼                 ▼
                                                    Module 2 (whisper.cpp / espeak-ng)
```

Asterisk is the **client** for AudioSocket: it dials the server, not the other
way round. The dialplan therefore has to be told the address the server is
listening on.

There are two entry paths and they must not be confused:

| Direction | Context | Marker variable | Who sets it |
| --- | --- | --- | --- |
| Inbound (caller dials in) | the endpoint's `context=` | `RESUS_INBOUND_UUID` | the dialplan, with `${UUID()}` |
| Outbound (server originates) | `ASTERISK_DIALPLAN_CONTEXT` (default `resus`) | `RESUS_CALL_UUID` | the server's `Originate` action |

The inbound intake only reacts to `RESUS_INBOUND_UUID`. Keeping the two names
distinct is what makes it impossible for a call the server placed itself to be
mistaken for an incoming emergency.

## 1. Prerequisites

- WSL2 with an Ubuntu distribution (the server and Asterisk must share a network
  namespace so `127.0.0.1` reaches both — see the note in step 6).
- Asterisk 18 or newer (`apt install asterisk` on Ubuntu 22.04+ gives a recent
  build).
- Node 20+ inside WSL2.
- A softphone to test with (Zoiper, Linphone, MicroSIP, …).

```bash
sudo apt update
sudo apt install -y asterisk
asterisk -V
```

Confirm the AudioSocket dialplan application is present:

```bash
sudo asterisk -rx 'module show like audiosocket'
```

You need `res_audiosocket.so` loaded. It ships with the standard package; if it
is missing, that redistribution was built without it and AudioSocket is
unavailable.

## 2. AMI account — `/etc/asterisk/manager.conf`

The server logs in over the Manager Interface. Give it read/write on the events
and actions it uses, and nothing more.

```ini
[general]
enabled = yes
bindaddr = 127.0.0.1
port = 5038

[resus]
secret = CHANGE_ME_AMI_SECRET
read = system,call,log,verbose,command,agent,user,config,dialplan
write = system,call,log,verbose,command,agent,user,config,originate
```

Two of those are not optional, and Asterisk reports neither in the account
listing, so it is worth knowing why they are there:

- `dialplan` (read) — the inbound marker arrives as `VarSet`, and `VarSet` and
  `Newexten` are emitted with `Privilege: dialplan,all`. Without it the AMI
  connection is healthy, every other event arrives, and inbound calls are
  silently never noticed.
- `originate` (write) — `Action: Originate` reports `Privilege: originate,all`
  and is rejected without it.

`Event: on` does not override this: Asterisk intersects the session's event mask
with the account's read permissions, so a missing class stays missing.

Reload, then check the account is live:

```bash
sudo asterisk -rx 'manager reload'
sudo asterisk -rx 'manager show user resus'
```

Set the same secret in `ASTERISK_AMI_SECRET`. The server refuses to boot without
it, and also without `TRANSPORT_SIGNALLING_URL`, which for Asterisk carries the
AMI endpoint as `host:port` (`127.0.0.1:5038`).

## 3. SIP endpoints — `/etc/asterisk/pjsip.conf`

Two endpoints: `1001`, which the server originates to (a softphone registers
as it to receive outbound calls), and `emergency`, the inbound endpoint whose
context owns the `1000` extension a softphone dials to test an arriving
emergency.

```ini
[transport-udp]
type = transport
protocol = udp
bind = 0.0.0.0:5060

; --- Endpoint the server dials (ASTERISK_DEFAULT_ENDPOINT=PJSIP/1001) --------
[1001]
type = endpoint
context = resus
disallow = all
allow = ulaw,alaw
aors = 1001
auth = 1001

[1001]
type = aor
max_contacts = 1

[1001]
type = auth
auth_type = userpass
username = 1001
password = CHANGE_ME_1001

; --- Inbound emergency endpoint ---------------------------------------------
[emergency]
type = endpoint
context = resus-inbound
disallow = all
allow = ulaw,alaw
aors = emergency
direct_media = no

[emergency]
type = aor
max_contacts = 1

[emergency]
type = auth
auth_type = userpass
username = emergency
password = CHANGE_ME_EMERGENCY
```

`allow = ulaw,alaw` with `disallow = all` locks the leg to 8 kHz G.711. That
matters: AudioSocket forwards the channel's audio in signed-linear PCM, and the
bridge assumes 8 kHz. Allowing `g722` (16 kHz) or `opus` would hand the bridge a
different rate and the transcription would be wrong.

Reload and confirm registration state:

```bash
sudo asterisk -rx 'pjsip reload'
sudo asterisk -rx 'pjsip show endpoints'
```

## 4. Dialplan — `/etc/asterisk/extensions.conf`

```ini
[resus]
; Outbound: reached by the server's Originate action. The server has already put
; RESUS_CALL_UUID on the channel, so this context must NOT set the inbound
; marker — that is what keeps a placed call from looking like an incoming one.
exten => s,1,NoOp(Resus outbound ${RESUS_CALL_KEY})
 same => n,Answer()
 same => n,AudioSocket(${RESUS_CALL_UUID},127.0.0.1:9092)
 same => n,Hangup()

[resus-inbound]
; Inbound: the endpoint for an arriving emergency call uses this context.
exten => 1000,1,NoOp(Resus inbound from ${CALLERID(num)})
 same => n,Set(RESUS_INBOUND_UUID=${UUID()})
 same => n,Answer()
 same => n,AudioSocket(${RESUS_INBOUND_UUID},127.0.0.1:9092)
 same => n,Hangup()
```

The first argument to `AudioSocket()` is the UUID the server will see on the
connection; it must be a canonical UUID, which is why it is produced by
`${UUID()}` rather than assembled by hand. The second is
`ASTERISK_AUDIOSOCKET_ADVERTISE_HOST:ASTERISK_AUDIOSOCKET_BIND_PORT`.

Reload:

```bash
sudo asterisk -rx 'dialplan reload'
```

## 5. Environment

Copy `.env.example` to `.env` and set:

```ini
TRANSPORT_PROVIDER=asterisk
TRANSPORT_SIGNALLING_URL=127.0.0.1:5038
ASTERISK_AMI_USERNAME=resus
ASTERISK_AMI_SECRET=CHANGE_ME_AMI_SECRET

ASTERISK_AUDIOSOCKET_BIND_HOST=0.0.0.0
ASTERISK_AUDIOSOCKET_BIND_PORT=9092
ASTERISK_AUDIOSOCKET_ADVERTISE_HOST=127.0.0.1

ASTERISK_DIALPLAN_CONTEXT=resus
ASTERISK_DIALPLAN_EXTEN=s
ASTERISK_DIALPLAN_PRIORITY=1
ASTERISK_DEFAULT_ENDPOINT=PJSIP/1001

ASTERISK_INBOUND_UUID_VARIABLE=RESUS_INBOUND_UUID
ASTERISK_INBOUND_EXTEN=1000
ASTERISK_INBOUND_LAT=9.9312
ASTERISK_INBOUND_LNG=76.2673

# Real, offline speech (optional; without it the loopback providers are used).
SPEECH_PROVIDER=whisper
SPEECH_SYNTHESIS_PROVIDER=espeak
WHISPER_CPP_BINARY=whisper-cli
WHISPER_CPP_MODEL=/opt/whisper.cpp/models/ggml-base.en.bin
WHISPER_CPP_LANGUAGE=auto
ESPEAK_NG_BINARY=espeak-ng
ESPEAK_NG_VOICE=en-gb
ESPEAK_NG_SPEED_WPM=145
```

eSpeak NG's `-s` unit is approximate words per minute (default 175); 145 is
about 83% of that default. The exact voice must be installed on the server.
This configuration uses British English where no Indian-English voice is
available; do not describe it as an `en-IN` voice.

`ASTERISK_INBOUND_LAT` / `ASTERISK_INBOUND_LNG` are mandatory: a trunk carries no
location, and a session cannot exist without one, so the emergency is opened at
these service-area coordinates and flagged for the operator to confirm the real
position. They are required at boot, so a missing location fails once, at start,
rather than on every call.

## 6. Run the server

Run it **inside WSL2**, alongside Asterisk, so the two share `127.0.0.1`:

```bash
npm install
npm run dev            # or the server's production start
```

At boot the log must show, before it accepts traffic:

```
Asterisk telephony runtime started  ami=127.0.0.1:5038 audioSocket=0.0.0.0:9092 ...
```

If it fails, it says why: AMI login rejected, or the AudioSocket port is already
in use. It does not start a half-configured line.

> **Networking note.** Under WSL2 mirrored networking (Windows 11 22H2+) the
> Windows host reaches WSL services on `localhost`. Under the older NAT mode the
> softphone must be pointed at the WSL IP (`hostname -I` inside WSL) and
> `ASTERISK_AUDIOSOCKET_ADVERTISE_HOST` still stays `127.0.0.1`, because it is
> Asterisk, not the phone, that dials AudioSocket.

## 7. Register the softphone

There are two accounts, and which one the softphone registers as decides what it
can do:

- **Inbound testing.** To dial the emergency extension `1000`, register the
  softphone as the **`emergency`** endpoint — username `emergency`, password
  `CHANGE_ME_EMERGENCY`. Its context is `resus-inbound`, which is the only place
  `exten 1000` exists. A softphone registered as `1001` cannot reach `1000`:
  `1001`'s context is `resus`, which only has `exten s` (outbound).

- **Outbound testing.** To receive a call the server originates, register as
  **`1001`** — username `1001`, password `CHANGE_ME_1001`. The server dials
  `PJSIP/1001` (`ASTERISK_DEFAULT_ENDPOINT`), so that account must be registered
  for the phone to ring.

Both endpoints allow `max_contacts = 1`, so register the same softphone under
both accounts if you need to test inbound and outbound together, or switch the
registered account between tests. Confirm after registering:

```bash
sudo asterisk -rx 'pjsip show contacts'
```

The contact list must show the account you registered
(`emergency/sip:emergency@...` or `1001/sip:1001@...`). With `baresip`, the
account line looks like `<sip:emergency@127.0.0.1>` for the inbound account.


## 8. Verification

The inbound path (items 1–4 and 6–9) has been observed end to end with an
automated SIP client (`baresip`) registered as the `emergency` endpoint, playing
a captured caller audio file: the call reached `exten 1000`, AudioSocket
connected, the protocol conversation ran, caller utterances were transcribed and
stored, and the hangup left the `CallSession` `ENDED`. The remaining items still
require a human softphone: the caller hearing the greeting (5) and the
server-originated call ringing the phone (10). Do not mark the whole checklist
verified until those two are observed by hand.

**A real call reaches the system**

1. From the softphone, dial the inbound extension (`1000`).
2. `sudo asterisk -rx 'core show channels'` shows a live channel.
3. The server log shows `inbound Asterisk call opened a session` with a
   `callSessionId`.
4. `GET /calls/:id` (or the dashboard) shows exactly one `CallSession` for that
   call — one Asterisk call, one session, no duplicates.
5. The softphone plays the greeting (`ASTERISK_GREETING`) — audio from the server
   back to the caller.

**Real audio both ways**

6. Speak a sentence. The transcript for the session gains a `CALLER` utterance
   whose text matches what was said — not a placeholder.
7. The confidence on that utterance is derived from the recogniser, and an
   unintelligible utterance is dropped rather than stored.

**Hangup is honoured**

8. End the call on the softphone. The server log shows the session closing, and
   the `CallSession` is `ENDED` with a duration.
9. Hang up from the operator side instead, and confirm the Asterisk channel
   actually drops (`core show channels` is clear) — the row and the leg must not
   diverge.

**Outbound still works**

10. Originate a call from the server to `PJSIP/1001`. The softphone rings, and no
    inbound session is created for it (the marker variables differ).

## 9. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Boot fails `Asterisk rejected the AMI login` | secret or username in `manager.conf` does not match the environment |
| Boot fails `Timed out connecting to Asterisk AMI` | `bindaddr` in `manager.conf` is not the address in `TRANSPORT_SIGNALLING_URL`, or the port is closed |
| Boot fails `AudioSocket port is in use` | something already holds `ASTERISK_AUDIOSOCKET_BIND_PORT` |
| Calls connect but no transcript | AudioSocket not connected: check `AudioSocket()` in the dialplan and that the address matches `advertiseHost:bindPort`; check the server log for `AudioSocket channel connected` |
| Audio is garbled or recogniser is wrong | the leg negotiated a wideband codec — lock the endpoint back to `ulaw,alaw` |
| No session created on an inbound call | the dialplan does not set `RESUS_INBOUND_UUID`, or the endpoint's `context=` is not `resus-inbound` |
| An outbound call creates an inbound session | the outbound context is setting `RESUS_INBOUND_UUID` |
| `AudioSocket frame before the UUID was ignored` | the dialplan passed an empty or non-UUID first argument |

## 10. What this does not cover

- No real PBX is installed by this repository; nothing here provisions Asterisk.
- Trunking/ITSP registration is out of scope — the endpoints above are local.
- `whisper.cpp` and `espeak-ng` must be installed and built separately; the model
  path is a hard requirement when `SPEECH_PROVIDER=whisper`.
- TLS/SRTP for the SIP leg is not configured here. An emergency line carrying
  medical information probably wants it; that is a deployment decision, not
  something this repository can make for you.
