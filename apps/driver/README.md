# Flutter Driver App

The driver app uses the existing Fastify bearer-token API. It displays only the assignment associated with the authenticated driver, records explicit accept/decline decisions, uploads GPS while duty tracking is active, and reads response-route details after dispatch.

## Local development

From the repository root, start the already configured backend and dashboard with:

```powershell
npm run dev
```

This uses the repository's configured database and existing credentials. Do not run database setup/reset commands as part of starting the app.

From `apps/driver`, run the Android emulator build with its default API URL:

```powershell
flutter run
```

The default `API_BASE_URL` is `http://10.0.2.2:4000`, which targets the host from an Android emulator. For a physical device on a trusted local network, pass the development machine's reachable LAN address:

```powershell
flutter run --dart-define=API_BASE_URL=http://<DEVELOPMENT_MACHINE_LAN_IP>:4000
```

The backend must be bound to an address reachable from that device (`HOST=0.0.0.0` for a temporary local-network session). Do not expose the development server to an untrusted network. iOS simulators may use `http://127.0.0.1:4000`; device networking and platform location permissions must be verified on the target device.

## Driver workflow

1. Sign in with an existing driver account.
2. Review the time-limited pending offer and explicitly accept or decline it. Offers expire after the configured Module 6 TTL (default 60 seconds); expiry/decline releases the unit and does not automatically reassign or dispatch another ambulance.
3. Start duty to upload phone GPS. Location permission and enabled device location are required. Uploads occur at most once every ten seconds and do not overlap. Network or location errors are shown in the app.
4. Dispatch remains a separate dispatcher action. After a persisted dispatch, the driver can refresh and view the response route, provider, estimated distance/time and actual `isLiveTraffic` value.

Routes are displayed as persisted geometry and metadata; this stage does not add turn-by-turn navigation or a map provider. A simulated route acknowledgement is not real police contact, traffic clearance, or signal control.
