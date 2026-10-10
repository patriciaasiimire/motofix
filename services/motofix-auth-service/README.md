# motofix-auth-service

Authentication and account management for the MOTOFIX platform. Handles OTP-based
driver sign-up/login, mechanic (provider) registration and login, admin login,
provider applications and approval, user profiles/preferences, and the spare-parts
catalog and driver parts orders.

- **Stack:** Python / FastAPI
- **Port:** 8000
- **Database:** motofix_auth
- **External services:** Africa's Talking (OTP SMS), Claude/Anthropic (document verification)

## Endpoints

Interactive API docs at `/docs`. Main groups:

| Group | Examples |
|-------|----------|
| Driver auth (`/auth`) | `POST /auth/register/driver`, `POST /auth/verify-otp`, `GET /auth/me`, `POST /auth/logout`, `POST /auth/verify-document` |
| Provider auth (`/auth`) | `POST /auth/register/provider`, `POST /auth/login/provider`, `GET /auth/me/provider`, `PATCH /auth/provider/me/availability`, `GET /auth/providers/{mechanic_id}/public` |
| Admin (`/auth`) | `POST /auth/login/admin`, `POST /auth/admin/verify-provider/{id}` |
| Users | `GET|PATCH /users/me`, `POST /users/me/fcm-token`, `GET|PATCH /users/me/preferences`, `GET /users/`, `GET /users/{id}`, `PATCH /users/{id}/status` |
| Provider applications (`/providers`) | `POST|GET /providers/applications`, `GET /providers/applications/status`, `POST /providers/applications/{id}/approve|reject|reopen|verify|request-reupload` |
| Spare parts (`/auth`) | `GET|PUT|DELETE /auth/admin/parts-catalog[/{fault_category}]`, `GET /auth/parts-catalog/{fault_category}`, `POST|GET /auth/me/parts-orders` |
| System | `GET /health` |

## Configuration (environment)

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres connection (motofix_auth). |
| `SECRET_KEY` / `ALGORITHM` | JWT signing (must match the other services). |
| `ACCESS_TOKEN_EXPIRE_HOURS` | Driver/provider token lifetime (default `87600`, about 10 years). |
| `ADMIN_TOKEN_EXPIRE_HOURS` | Admin token lifetime. |
| `AT_USERNAME` / `AT_API_KEY` | Africa's Talking creds for OTP SMS. Falls back to printing the OTP to the server console if unset. |
| `ANTHROPIC_API_KEY` | Claude key for AI document verification. |
| `UPLOAD_DIR` | Where uploaded application documents are stored. |
| `PROVIDER_APP_URL` | Provider app base URL (used in application emails/links). |
| `DISPATCH_SERVICE_URL` / `DISPATCH_DATABASE_URL` | Cross-service calls/reads to dispatch. |
| `ENV` | `development` / `production` (controls secure-cookie flags). |

Driver sessions do not expire due to inactivity. OTP is required only after
explicit logout, a new install, or cleared app data—not for periodic re-authentication.

## Run locally

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env               # fill in values
uvicorn app.main:app --reload --port 8000
```

Health check: `GET /health`.

> Security note: OTPs are kept in an in-memory store in development. For production,
> use a store with expiry and rate limiting, and never commit real credentials.

See the [root README](../../README.md) and [docs/RUNBOOK.md](../../docs/RUNBOOK.md)
for the full platform overview.
