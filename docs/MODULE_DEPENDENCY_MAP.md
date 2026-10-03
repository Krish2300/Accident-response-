# Module Dependency Map

Pre-Hospital Emergency Survival System — cross-module architecture.

**Status of this document.** Everything below is derived from the code in this
repository, not from an external specification. Where a module is not implemented,
its row says so explicitly and no behaviour is claimed on its behalf.

---

## 1. Current repository inventory (verified)

The repository was inspected exhaustively before this document was written:

| Check | Result |
| --- | --- |
| `F:\minor\modules\*` | Only `module_05`, `module_06`, `module_11`, `module_12` exist |
| Git history (`git log --all`, `git cat-file --batch-all-objects`) | 0 commits, 0 objects — no recoverable prior implementation |
| Other git repos on `F:\` | Only `F:\ld\couple-app` and `F:\ieee` (SignVerse); neither is this domain |
| Filesystem search for `module_0[1-4]`, `module_(07|08|09|10)` across `F:\` and `C:\Users\sanja` | No matches |
| Content search for `prehospital\|ambulance\|bystander\|triage\|CORRIDOR\|HospitalSelector\|route_optimizer` outside this repo | Only unrelated false positives (a mental-health chatbot string, an Arduino sketch, a compiled Dart blob) |
| Documentation sweep for a 12-module spec (README/MD/PDF/DOCX) | None exists on this machine |

**Conclusion: Modules 1–4 and 7–10 are not implemented and do not exist anywhere
accessible.** They are greenfield. There is no existing interface from those
modules to integrate with, and nothing in this repository duplicates them
because nothing in this repository implements them.

This means the "do not bypass Modules 7–10" constraint is currently
**non-actionable as written**: there is no code to preserve, integrate with, or
avoid duplicating. The risk this constraint guards against — silently
reimplementing routing, hospital selection or corridor management inside
Modules 5/6/11/12 — is handled differently, described in §8.

---

## 2. Module responsibilities

### Implemented in this repository

| Module | Path | Responsibility | State |
| --- | --- | --- | --- |
| **5 — Bystander assistance** | `modules/module_05_bystander_assistance` | Guides a bystander through an emergency: deterministic protocol state machine, versioned protocol catalogue, local LLM for extraction/classification/rephrasing, medical safety gate, protocol session service and HTTP API | Complete except the bystander frontend |
| **6 — Ambulance management** | `modules/module_06_ambulance_management` | Fleet lifecycle: ambulance/crew state, assignment, dispatch, location reporting, utilisation | **Manifest only — no source** |
| **11 — Database & event system** | `modules/module_11_database_event_system` | Sole owner of persistence and the append-only event log; repositories, event bus, real-time forwarding | Implemented; seed pending |
| **12 — Dashboard & analytics** | `modules/module_12_dashboard_analytics` | Read-only analytics and the operator dashboard over Module 11 projections | **Manifest only — no source** |
| **core** (shared) | `packages/core` | Cross-module contracts only: event vocabulary, ports, errors, enums, provenance, geo, HTTP route abstraction. Contains no business logic and no I/O | Implemented |

### Not present (greenfield, no code, no spec on this machine)

Modules 1, 2, 3, 4, 7, 8, 9, 10.

The system is commonly described as containing twelve modules. This repository
contains four of them plus the shared core. The remaining eight have no
implementation, no interface, and no written specification available here, so
this document does not invent their responsibilities. If their definitions exist
elsewhere, they should be added to this file before the remaining modules are
built against it.

---

## 3. Dependency graph (as actually built)

```
        ┌──────────────────────┐
        │  Modules 1–4, 7–10   │   NOT IMPLEMENTED — no interfaces exist
        │  (greenfield)        │   no code to integrate with or preserve
        └──────────┬───────────┘
                   │ (no edges: nothing to connect to yet)
                   │
   ┌───────────────┴───────────────┐
   │                               │
   ▼                               ▼
┌─────────────────────────┐   ┌─────────────────────────┐
│  Module 5               │   │  Module 6               │
│  Bystander assistance   │   │  Ambulance management   │
│  protocol engine        │   │  fleet / dispatch       │
│  + LLM layer            │   │  (manifest only)        │
└───────────┬─────────────┘   └───────────┬─────────────┘
            │                             │
            │  EventPublisherPort         │  EventPublisherPort
            │  AnalyticsReadPort          │  (repositories)
            │                             │
            └──────────┬──────────────────┘
                       ▼
            ┌─────────────────────┐
            │  Module 11          │
            │  Database + events  │  sole owner of persistence
            │  append-only log    │  and of the real-time bus
            └──────────┬──────────┘
                       │  AnalyticsReadPort (read-only projections)
                       ▼
            ┌─────────────────────┐
            │  Module 12          │
            │  Dashboard +        │  read-only; cannot write
            │  analytics          │
            └─────────────────────┘

   Every module also consumes the shared contracts in packages/core
   (event vocabulary, ports, errors) and is assembled by apps/server.
```

**Key property: there is no direct edge from Module 5 to Module 6, or from
either to Module 12.** They are peers over shared infrastructure, not a
sequential pipeline. Module numbering is not execution order.

---

## 4. APIs between modules

All cross-module coupling goes through `packages/core/src/ports.ts`. No module
imports another module's internals.

| Port | Interface | Implemented by | Consumed by |
| --- | --- | --- | --- |
| `EventPublisherPort` | `record`, `recordMany`, `recordInTransaction` | Module 11 (`EventService`) | 5, 6, and anything with a state change |
| `EventQueryPort` | `list`, `getById`, `timeline` | Module 11 | 5 (replay), 12 (reconstruction) |
| `ProtocolSessionPort` | `createSession`, `getSession`, `listSessionsForEmergency`, `stepsForSession`, `applyTransition` | Module 11 (`ProtocolRepository`) | **5 only** |
| `AnalyticsReadPort` | `dashboardSummary`, `emergencyDurations`, `liveState`, `eventBreakdown`, `learningSamples`, `snapshotSeries` | Module 11 (`AnalyticsReadRepository`) | **12 only** |
| `RealtimePublisherPort` | `publish`, `subscriberCount` | `apps/server` WebSocket hub | Module 11 forwards to it |
| `DomainEventBusPort` | `subscribe`, `publish` | Module 11 (`DomainEventBus`) | 5, 6 for reactions; 12 for live refresh |
| `Database` | opaque, `unique symbol` | Module 11 | 5, 6 via repository methods only |
| `RouteDefinition` | `packages/core/src/http.ts` | each module exposes | `apps/server` mounts |

`Database` carries a `unique symbol` property so that no consumer can satisfy it
by accident. This is deliberate: only Module 11 may hand out database access,
and consumers receive repositories rather than the client.

**Coordination pattern.** Where Module 5 and Module 6 need to react to each
other, they do it by subscribing to event types, never by calling each other:

```ts
// illustrative - Module 5 reacting to a dispatch, not calling Module 6
bus.subscribe(['AMBULANCE_DISPATCHED'], (event) => { /* update session */ });
```

---

## 5. Events between modules

The vocabulary is fixed in `packages/core/src/domain/events.ts`
(`SYSTEM_EVENT_TYPES`), and the payload for each type in `EventPayloadMap`.
This file is the contract; adding a type requires editing it there first.

| Producer | Events |
| --- | --- |
| Call intake | `EMERGENCY_CREATED`, `CALL_STARTED`, `TRANSCRIPT_UPDATED`, `EMERGENCY_CLASSIFIED`, `EMERGENCY_STATUS_CHANGED` |
| Module 5 | `PROTOCOL_STARTED`, `PROTOCOL_STEP_PRESENTED`, `CALLER_RESPONSE_RECEIVED`, `PROTOCOL_STEP_COMPLETED`, `PROTOCOL_CLARIFICATION_REQUESTED`, `PROTOCOL_ESCALATED`, `PROTOCOL_COMPLETED`, `PROTOCOL_CANCELLED`, `LLM_CALL_FAILED` |
| Module 6 | `AMBULANCE_CREATED`, `AMBULANCE_UPDATED`, `AMBULANCE_ASSIGNMENT_REQUESTED`, `AMBULANCE_ASSIGNED`, `AMBULANCE_ASSIGNMENT_CANCELLED`, `AMBULANCE_DISPATCHED`, `AMBULANCE_LOCATION_UPDATED`, `AMBULANCE_STATUS_CHANGED`, `AMBULANCE_ARRIVED_SCENE`, `PATIENT_ONBOARD`, `HOSPITAL_SELECTED`, `AMBULANCE_ARRIVED_HOSPITAL`, `EMERGENCY_COMPLETED` |
| Decision / outcome | `DECISION_CREATED`, `OUTCOME_RECORDED`, `CORRIDOR_ACTIVATED`, `ROUTE_UPDATED` |
| Analytics | `ANALYTICS_SNAPSHOT_CREATED`, `LEARNING_MODEL_UPDATED` |

The naming already anticipates modules 7–10 (`CORRIDOR_ACTIVATED`,
`HOSPITAL_SELECTED`, `ROUTE_UPDATED` sit in the decision/outcome group rather
than in Module 5 or 6's groups). **When those modules are implemented they should
emit these existing event types rather than inventing new ones**, so Module 12's
analytics and the dashboard work without modification.

---

## 6. Database relationships

Module 11 is the only writer. Models are in
`modules/module_11_database_event_system/prisma/schema.prisma` (25 models).

```
Emergency ─┬─ CallSession ─── Transcript
           ├─ ProtocolSession ─── ProtocolStep
           ├─ AmbulanceAssignment ─── Ambulance ─┬─ AmbulanceCrew
           │                                     ├─ AmbulanceLocation
           │                                     └─ (assignments)
           ├─ Corridor ─── Hospital
           ├─ Route ─── RouteUpdate
           ├─ Decision
           ├─ Outcome
           ├─ LearningSample
           └─ SystemEvent*        (* append-only, indexed by [emergencyId, seq])
```

Notable: `SystemEvent.emergencyId` cascades on emergency deletion, so an
emergency's full history is removed together. `seq` is an autoincrement integer
giving **total order** — timestamps are never used to sequence events, because
concurrent writers can produce identical timestamps.

Enums and JSON payloads are stored as `String` columns and validated by Zod at
the repository boundary. This keeps the schema portable between SQLite and
PostgreSQL.

**Two migrations:**
- `20260929151801_init` — tables, indexes, relations
- `20260929151900_append_only_event_log` — the append-only guard triggers, the
  coordinate range check, and the step-order check

---

## 7. Real-time communication paths

```
  module 5 / 6  ──write──►  Module 11  ──commit──►  DomainEventBus.publish()
                                                       │
                                    ┌──────────────────┴──────────────────┐
                                    ▼                                     ▼
                        in-process subscribers              RealtimePublisherPort
                        (5, 6, 12 react)                              │
                                                                    ▼
                                                    apps/server WebSocket hub
                                                                    │
                                                                    ▼
                                                    Module 12 dashboard browser
```

- Channels are fixed in `REALTIME_CHANNELS`: `system`, `emergencies`,
  `ambulances`, `protocols`, `hospitals`, `routes`, `corridors`, `events`.
- Modules only ever **publish**. They never hold socket handles; the WebSocket
  hub lives in `apps/server` and is injected as a port.
- Every message carries `isSimulation` so a simulated event can never be
  mistaken for a real one by the dashboard.
- **Commit ordering is guaranteed**: an event is published only after its
  transaction commits (see §9), so a subscriber can never observe a state change
  that was rolled back.

---

## 8. Handling of the Modules 7–10 constraint

Because those modules do not exist, duplication risk is addressed as follows.

**Boundary rule, in force now.** The following capabilities are *reserved* for
Modules 7–10 and must not be implemented inside Modules 5, 6, 11 or 12:

| Capability | Reserved owner | What Modules 5/6/11/12 do instead |
| --- | --- | --- |
| Route / corridor optimisation | Module 7–10 | Module 6 stores and displays routes; it does not compute optimal paths |
| Hospital selection | Module 7–10 | `HOSPITAL_SELECTED` is consumed as an event; no selection algorithm lives in Module 6 |
| Traffic estimation | Module 7–10 | No traffic model is implemented anywhere in this repository |
| GPS / geofencing | Module 7–10 | Module 6 only *records* `AmbulanceLocation` rows it is given |
| Notifications / dispatch to external services | Module 7–10 | No SMS/voice/push integration exists; `HOSPI*` and dispatch events are recorded, not sent |

**What this prevents concretely.** Module 6 is the module most at risk of
absorbing fleet-optimisation logic. Its repositories (`AmbulanceRepository`,
`RouteRepository`, `HospitalRepository`) were written to persist and report state
only. `Hospitals` has no scoring or selection method, and `routes` has no
computation — so there is nothing to duplicate later, and the eventual Module
7–10 implementation slots in behind the same events.

**Interface reserved for them.** The event types, the `corridors` / `routes` /
`route_updates` / `hospitals` tables and the `routes` / `corridors` /
`hospitals` real-time channels already exist. Modules 7–10 will emit and consume
these; no schema or vocabulary change should be required.

---

## 9. Transaction and event-ordering guarantee

This is the invariant most easily broken by future modules, so it is stated
explicitly.

**Rule:** a domain state change and the event describing it commit in the same
transaction, and the event is broadcast only after that transaction commits.

**How it is enforced:** `withTransaction` in
`modules/module_11_database_event_system/src/db/client.ts` wraps every
transaction body in an `AsyncLocalStorage` scope
(`db/transactionScope.ts`). `EventService.recordInTransaction` buffers the event
into the *current* scope. The buffer is drained to the bus only on commit and is
discarded on rollback.

**Why `AsyncLocalStorage` and not a module-level array:** an earlier
implementation used a module-global `pendingBroadcasts` array. Under concurrent
transactions, one transaction's `flushPending()` would publish events buffered
by *other* in-flight transactions, including events for work that later rolled
back. Subscribers would then be told about emergencies that never existed. The
scoped buffer removes that failure mode; it is covered by
`modules/module_11_database_event_system/tests/transactionSafety.test.ts`, which
asserts that a rolling-back transaction's event is not delivered even when a
concurrent transaction commits while it is still in flight.

**Rule for future modules:** never publish directly. Call
`recordInTransaction(tx, event)` inside a `withTransaction` body, or
`record(event)` outside one. Never add a global broadcast buffer.

---

## 10. Modules that operate independently

- **Module 5 and Module 6 are independent.** Neither imports the other. A
  bystander protocol session does not require an ambulance to be dispatched, and
  a dispatch does not require a protocol session.
- **Module 12 depends on Module 11 only**, and only through the read-only
  `AnalyticsReadPort`. It cannot write, so it cannot corrupt an event log.
- **`packages/core` has no dependencies** and no I/O. It is a contract library,
  which is what keeps the dependency graph acyclic.
- **Module 11 depends on nobody.** It is the only module that knows Prisma
  exists.

Upstream (nothing depends on them): `packages/core`, Module 11.
Mid: Module 5, Module 6.
Downstream: Module 12, `apps/server` (composition root), `apps/dashboard` (UI).

---

## 11. Modules that must not be modified

| Module / path | Rule |
| --- | --- |
| `packages/core/src/domain/events.ts` | The event vocabulary is the cross-module contract. Additions must be additive; changing an existing payload shape breaks every producer and consumer. |
| `packages/core/src/ports.ts` | Port signatures are the seams. Widening is safe; changing a signature forces edits in the owning module. |
| `packages/core/src/domain/provenance.ts` | Clinical review state (`UNREVIEWED` / `IN_REVIEW` / `CLINICALLY_REVIEWED`) and simulation marking. Must not be relaxed. |
| `migrations/20260929151900_append_only_event_log` | The append-only trigger is the audit guarantee. It is currently blocking `DELETE` on `system_events`, verified by test. |
| `modules/module_11_database_event_system/prisma/schema.prisma` | Owned by Module 11. Other modules request schema changes through Module 11, never by editing it. |
| All protocol JSON in `modules/module_05_bystander_assistance/protocols` | Clinically authored content. Not generated, not reworded, not version-bumped by tooling. Every file is `UNREVIEWED` and must stay so until a clinician reviews it. |

---

## 12. Open items

1. **Modules 1–4 and 7–10 are unimplemented.** Their definitions are not
   available in this repository. This map should be extended when they are
   specified; until then §8 is what keeps the four implemented modules from
   absorbing their responsibilities.
2. Module 6 and Module 12 have manifests but no source.
3. Module 5's protocol session service, HTTP API and composition root are now
   implemented, and a development-only harness drives them over HTTP. The
   bystander frontend (`apps/dashboard`) and the caller-facing client are not.
4. `package.json` invokes `scripts/prisma-generate.mjs`, which generates the
   client and repairs the generated files. Ollama availability is unverified;
   the heuristic fallback is what runs today, and every scenario in §14 was
   verified through it.
5. `npm run lint` does not run: the repository has no `eslint.config.js`, so
   ESLint 9 exits with a configuration error. Adding a flat config is
   outstanding.

---

## 13. Verified defects found while building Module 5

Recorded because each one is a safety property, not a cosmetic bug, and each is
now covered by a regression test.

| Defect | Consequence | Fix |
| --- | --- | --- |
| The event log used a module-global broadcast buffer | A rolling-back transaction's event could be published by a concurrent transaction, telling operators about an emergency that never existed | `AsyncLocalStorage` scope in `db/transactionScope.ts`; `transactionSafety.test.ts` |
| Protocol entry required facts that the entry step exists to establish | `cardiac-arrest-adult` could not start until breathing was already known, making `confirm-arrest` unreachable and blocking triage at the moment a bystander calls | Three-valued `isDefinitivelyFalse`: unknown does not refuse entry, a contradicting known fact still does |
| A `CRITICAL` escalation rule was recorded but not acted on | With an unsafe scene the engine looped to a clarification question and stayed `ACTIVE`, although the protocol states no physical intervention may be directed | `CRITICAL` escalations now halt the session regardless of the step transition |
| `clarificationLimit` was configured but never enforced | The engine could ask "Can you confirm that again?" indefinitely | Bounded retries on both the missing-facts and unmatched-transition paths; either now escalates |
| Catalogues tested for `AGHASTIC`; the extraction vocabulary emits `GASPNING_AGAINST` | Gasping-breathing patients were never routed into the arrest pathway — the exact patients who need CPR | `GASPNING_AGAINST` added to the `breathing_status` condition lists in `cardiac-arrest-adult.json` and `active-seizure.json`; the original term is retained |

---

## 14. Server composition root

`apps/server/src/app.ts` is the only place modules meet. It owns the process,
the Prisma client, the WebSocket hub and the route table, and injects ports.

```
main.ts ── loadServerConfig ── buildServer
                                 │
                                 ├── RealtimeHub                (WebSocket fan-out target)
                                 ├── createModule11({ db, logger, realtime })
                                 │     └── DomainEventBus → RealtimeHub  (inject, never a setter)
                                 ├── new Module5({ sessions: module11.protocols, logger })
                                 │     └── ProtocolSessionPort  ← the only persistence Module 5 sees
                                 ├── AuthService (bcrypt + fastify-jwt)
                                 ├── RouteTable ← module11.routeDefinitions() + module5.register()
                                 ├── /api/health, /api, /ws
                                 └── registerDevHarness  (skipped when NODE_ENV=production)
```

Verified on a live process: 18 routes across `module_05` and `module_11`,
5 protocols and 33 steps loaded, `POST /api/emergencies` →
`POST /api/protocol-sessions` → `POST /api/protocol-sessions/:id/utterance`
producing `EMERGENCY_CREATED` → `CALL_STARTED` → `PROTOCOL_STARTED` →
`PROTOCOL_STEP_PRESENTED` in the event log.

### Development-only surfaces

| Surface | Mounted when | Purpose |
| --- | --- | --- |
| `GET /dev/protocol-chat` | `NODE_ENV !== production` | Interactive Module 5 harness: drives the real public API, shows extracted facts, engine action, current step, missing facts, escalation and degraded-LLM state, and can copy the transcript |
| `POST /api/dev/harness/emergency` | `NODE_ENV !== production` | Creates a throwaway `isSimulation` emergency so the harness needs no dispatch data |
| `POST /api/auth/dev-token` | `NODE_ENV !== production` | Mints a local operator token without persisting an account; there is no seed or user yet |

Verified absent under `NODE_ENV=production`: all three return `404` while the
real API continues to serve. Neither route appears in the `/api` index, and
`GET /api/health/llm` is available in every environment because it reports
whether the language model is actually usable.

### Defects found by running the harness against the live server

Found by replaying the five required scenarios over HTTP, not by reading code.
Each is now covered by a regression test.

| Defect | Consequence | Fix |
| --- | --- | --- |
| The keyword fallback had no hazard lexicon and only recognised *positive* safety words | With Ollama unavailable — the current runtime — "there are wires sparking across the road" was filed as a note. The bystander was told to go and check a patient beside live wires | `sceneSafety()` in `heuristicProvider.ts`: hazard language produces `scene_safe=NO`, hazards beat reassurance, and reassurance is masked before scanning so "no danger" is not read as a danger report. The lexicon describes danger to the approaching bystander, not the mechanism of injury: "he fell down the stairs" is not a scene hazard, because escalating that would halt an arrest |
| `gasping` was classified as normal `BREATHING` | An unresponsive person with agonal breathing took the *reassure and monitor* branch — "keep them still and warm, give nothing to eat or drink" — instead of cardiac arrest | `breathingStatus()`: gasping, agonal, snorting, gurgling and irregular breathing emit `GASPNING_AGAINST`; the intent becomes `PATIENT_NOT_BREATHING`. The Ollama prompt schema now says the same, so the model is told that gasping is never `BREATHING` |
| A bundled step question was re-asked in full while clarifying | After a caller reported unresponsiveness the assistant asked "Is the person unresponsive and are they not breathing normally?", re-asking a settled fact | Optional `fact_questions` per step, authored in the protocol files so the wording is reviewed with the protocol. The engine asks only for the facts still missing and never invents a question |
| Engine bookkeeping leaked into API responses | Clients received `__completedSteps` and `__repeatCount` inside `collectedFacts` | `presentSession()` strips them from every response while persistence keeps them, so a resumed session still remembers its progress |
| A `CRITICAL` escalation re-read the step that happened to be active | After the scene-safety escalation the last thing a bystander heard was "check whether the person is unresponsive" — the opposite of "do not approach" | Optional `escalation_step` on escalation rules; the engine speaks the named `ESCALATE` step's reviewed wording. Rules with no target (e.g. `bystander-alone`) keep their previous behaviour |
| `LLM_PROVIDER=heuristic-fallback` was reported as a healthy deployment | The gateway only labelled itself degraded when the fallback was reached *after* a failure, so configuring it as the primary claimed working LLM inference | `resolve()` reports degraded whenever the resolved provider is the heuristic matcher |
| `.env` set `PROTOCOL_MAX_CLARIFICATIONS`; the config read `PROTOCOL_CLARIFICATION_LIMIT` | The configured clarification limit silently fell back to the default | Config accepts the documented name first, with the older spelling as a fallback |
| `Module11` exposed repositories but no HTTP surface | The server had no way to mount Module 11's routes without reaching into internals | `routeDefinitions()` on `Module11`, alongside the other public facades |
| `routeAdapter` called `fastify.get(config)` with the URL inside the options object | The server refused to start: `URL must be a string. Received 'object'` | Single `fastify.route({ method, url, ... })` call |
