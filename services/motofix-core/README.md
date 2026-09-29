# motofix-core — Core Gateway

A small central service that the other MOTOFIX services and the admin dashboard talk to.
It holds **no business logic** of its own — think of it as the platform's switchboard /
notice board. It does three jobs:

1. **Service registry** — keeps the master list of where every other service lives.
2. **Health aggregation** — pings each service's `/health` and reports who is up/degraded/down.
3. **Shared config** — hands out platform-wide settings (subscription price, bank details,
   feature flags).

## Endpoints

| Method | Path          | Auth     | Description |
|--------|---------------|----------|-------------|
| GET    | `/`           | none     | Service banner + links to the routes below. |
| GET    | `/health`     | none     | Liveness check for the gateway itself. |
| GET    | `/services`   | none     | The service registry (names → base URLs). |
| GET    | `/health/all` | none     | Probes every registered service concurrently and returns an overall verdict (`healthy` / `degraded` / `critical`). Used by the admin status panel. |
| GET    | `/config`     | Bearer JWT | Platform-wide config: service URLs, feature flags, subscription pricing, payment/bank details. |

Interactive API docs: `/docs`.

## Configuration (environment)

| Variable | Default | Purpose |
|----------|---------|---------|
| `SECRET_KEY` | Required | JWT signing key (must match the auth service and be set before startup). |
| `ALGORITHM`  | `HS256` | JWT algorithm. |
| `ENV`        | `development` | Reported in `/config`. |
| `AUTH_SERVICE_URL` | `http://localhost:8000` | Registry entry — auth. |
| `DISPATCH_SERVICE_URL` | `http://localhost:8001` | Registry entry — dispatch. |
| `VERIFICATION_SERVICE_URL` | `http://localhost:8002` | Registry entry — verification. |
| `MATCHING_SERVICE_URL` | `http://localhost:8003` | Registry entry — matching. |
| `NOTIFICATIONS_SERVICE_URL` | `http://localhost:8004` | Registry entry — notifications. |
| `ANALYTICS_SERVICE_URL` | `http://localhost:8005` | Registry entry — analytics. |
| `INSURANCE_SERVICE_URL` | `http://localhost:8006` | Registry entry — insurance. |
| `DIAGNOSIS_SERVICE_URL` | `http://localhost:8007` | Registry entry — diagnosis. |
| `AT_API_KEY` | _(unset)_ | Presence flips the `whatsapp_enabled` feature flag. |
| `FCM_PROJECT_ID` | _(unset)_ | Presence flips the `fcm_push_enabled` feature flag. |

## Run locally

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8008
```
