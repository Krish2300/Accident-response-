# Module 5 disconnect policy — owner decision requested

**Status: pending protocol-owner approval. No disconnect policy change is implemented.**

## Decision scenario

A caller disconnects while the Module 5 protocol session is unresolved in
`WAITING_FOR_RESPONSE`. A telephony disconnect is a transport event; it does not
establish that the clinical protocol is complete or that emergency services
have arrived.

## Decisions required

1. **Session status:** Should the existing `WAITING_FOR_RESPONSE` session remain
   unresolved and reviewable, or should an already-supported status be used?
   The current status set has no dedicated disconnect state. Retaining the
   existing status preserves the last protocol step but does not itself make a
   disconnect visible in the protocol status.
2. **`completedAt`:** Should it remain null on disconnect? Today it is set when
   the protocol completes or when `cancel()` records that emergency services
   reached the scene. Setting it on a disconnect would make an unresolved
   session look terminal; leaving it null preserves the distinction between
   transport closure and protocol completion.
3. **Operator review:** Should the unresolved session remain available to
   operators? If yes, specify the role and existing view/projection that should
   expose it. Existing escalation preserves an open session for review, but
   escalation is an operator action and must not be inferred from a disconnect.
4. **Resumption:** Is reconnecting/resuming supported? If yes, define how the
   caller/session is identified, any expiry, and whether to continue from the
   last persisted step. Existing persisted steps preserve progress, but there is
   no approved telephony reconnect contract to reuse.
5. **Audit linkage:** Should the existing `CALL_DISCONNECTED` event be linked to
   the Module 5 session and last protocol step? It currently identifies the
   call session and emergency, while protocol events identify the protocol
   session. Specify the authoritative identifiers and linkage; do not infer a
   new event type.
6. **Operator display:** What status and information should the dashboard show
   after the disconnect, and through which existing projection/API? The current
   call event can show that the call ended, but does not update Module 5 status.

## Proposed safest interpretation — not approved

Keep an unresolved protocol session unresolved with `completedAt = null`, retain
its current step for review, and record the transport disconnect using the
existing call lifecycle event with an owner-approved link to the protocol
session/step. Show the call-ended fact separately from protocol status. Do not
resume automatically; permit resumption only if the owner defines its identity,
expiry, and restart rules. This proposal preserves current clinical state and
requires explicit owner approval before implementation.

`SessionService.cancel()` is not a hangup handler: it means emergency services
reached the scene, sets `CANCELLED` and `completedAt`, and emits
`PROTOCOL_CANCELLED`. No code or regression test should encode disconnect
semantics until the owner has answered all six decisions.

## Owner response

Protocol owner: ____________________  Date: ____________________

1. Status: ______________________________________________________
2. `completedAt`: _______________________________________________
3. Operator review role/view: ___________________________________
4. Resumption identity/expiry/restart: __________________________
5. Event and call/session/step linkage: __________________________
6. Operator display/projection: __________________________________

