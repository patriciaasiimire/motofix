# MotoFix V1 release

## Scope

V1 is a driver-first, area-based roadside-help launch. Drivers choose mechanic or
tow, optionally tag the issue or describe something else, select an area, then
see verified and available mechanic matches and call a mechanic from the app.
GPS coordinates are optional; matching uses service-area membership.

The driver app is the V1 client. The service-provider app and its online/job
acceptance/WebSocket workflow are deferred to V2 and remain in the repository.
MOTOBOT and diagnosis are off unless `VITE_MOTOBOT_ENABLED` is exactly `true`.
Maps are optional; the request flow must remain usable when map data is absent.
V1 does not require Google Maps.

Driver sessions do not expire from inactivity. OTP is required after explicit
logout, a new install, or cleared app data. The configured driver token lifetime
is 87,600 hours (10 years); admins retain their separate token lifetime.
Mechanics are contacted directly by phone using the device dialer.

## Run locally

Use the service `.env` files already configured for your local databases and
shared JWT secret. Do not copy or replace local `.env` files as part of this
release setup.

From the repository root, start each process in a separate terminal:

```powershell
cd services\motofix-auth-service
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --reload --port 8000
```

```powershell
cd services\motofix-verification-service
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --reload --port 8002
```

```powershell
cd services\motofix-matching-service
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --reload --port 8003
```

```powershell
cd services\motofix-dispatch-service
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --reload --port 8001
```

```powershell
cd interfaces\motofix-driver-app
npm run dev
```

Start dispatch along with auth, verification, and matching: it stores request
logs and serves the driver's sanitized match list. The driver app uses the Vite
URL printed by the final command. Confirm local API service URLs and credentials
in the already-configured ignored `.env` files.

## Returning to the full product

Switch back to `main` to continue working with the full incremental product,
including provider-app fulfillment and later MOTOBOT/diagnosis work:

```powershell
git switch main
```

`release/v1` is a separate launch branch; these V1 changes do not remove the
fuller product from `main`.
