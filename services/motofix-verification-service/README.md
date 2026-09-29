# motofix-verification-service

Mechanic verification and approval for the MOTOFIX platform. Manages provider
applications and verification status used by matching and dispatch.

- **Stack:** Python / FastAPI
- **Port:** 8002
- **Database:** motofix_mechanics

## Running locally

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt    # note: requirements.txt is UTF-16 encoded
cp .env.example .env               # fill in values
uvicorn app.main:app --reload --port 8002
```

## Endpoints

Interactive API docs at `/docs`. Main groups:

| Group | Examples |
|-------|----------|
| Mechanic auth | `POST /auth/register`, `POST /auth/login`, `GET /auth/me` |
| Mechanic self-service | `PATCH /mechanics/me/availability`, `PATCH /mechanics/me/location`, `GET /mechanics/me/current-job`, `GET /mechanics/me/{completed-jobs,handled-jobs,job-history,strikes,reviews}`, `POST /mechanics/me/fcm-token` |
| Matching provider list (`/mechanics`) | `GET /mechanics/` (verified/available filters; provider writes are owned by auth-service) |
| System | `GET /health` |

## Configuration (environment)

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres connection (motofix_mechanics). |
| `SECRET_KEY` | JWT signing (must match the other services). |
| `TOKEN_EXPIRE_HOURS` | Mechanic token lifetime. |
| `DISPATCH_SERVICE_URL` | Used to fetch the mechanic's current/handled jobs from dispatch. |

Health check: `GET /health`.

See the [root README](../../README.md) and [docs/RUNBOOK.md](../../docs/RUNBOOK.md)
for the full platform overview.
