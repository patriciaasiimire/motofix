# MotoFix local Windows development

Run the three lightweight APIs directly on Windows, then use the driver app in a
desktop browser. This setup does not use Docker or Podman and does not require
Android Studio, the Android SDK, or Capacitor.

## Prerequisites

- Python 3.11 or newer
- Node.js 20 or newer (npm is included)
- PostgreSQL running on your machine, or a Neon PostgreSQL database
- For a local PostgreSQL install, make it listen on port `5433` as used in the
  examples below. If yours uses another port, update each service's `DATABASE_URL`.

## Create the databases

Run this SQL in pgAdmin or a `psql` session connected to the `postgres` database:

```sql
CREATE DATABASE motofix_auth;
CREATE DATABASE motofix_mechanics;
CREATE DATABASE motofix_matching;
```

For example, connect to a local PostgreSQL server with:

```powershell
psql -h 127.0.0.1 -p 5433 -U postgres -d postgres
```

Use the matching database name in each service's connection string:

```text
Local:
postgresql://postgres:password@127.0.0.1:5433/motofix_auth
postgresql://postgres:password@127.0.0.1:5433/motofix_mechanics
postgresql://postgres:password@127.0.0.1:5433/motofix_matching

Neon (use the matching database name at the end of each URL):
postgresql://USER:PASSWORD@HOST/motofix_auth?sslmode=require
```

Replace the local example's `password` with your local PostgreSQL password.
URL-encode special characters in database credentials when required.

## Configure each API

Generate one development JWT key, then put the same value in `SECRET_KEY` in
all three service `.env` files:

```powershell
python -c "import secrets; print(secrets.token_hex(32))"
```

In each service, create and activate its own virtual environment, install its
dependencies, and copy the example environment file. Run each block in a
separate PowerShell terminal from the repository root; edit the new `.env`
before starting the service.

If PowerShell blocks activation, allow scripts for only the current terminal,
then activate again:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
.\.venv\Scripts\Activate.ps1
```

### Auth API — port 8000

```powershell
Set-Location .\services\motofix-auth-service
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
```

Edit `.env` and set the shared `SECRET_KEY` and the auth database URL ending in
`/motofix_auth`. The service creates its initial tables at startup. On a brand
new database, start it once to bootstrap the `users` table, stop it with
`Ctrl+C`, then apply its Alembic revision from the same activated terminal:

```powershell
alembic upgrade head
```

Start (or restart) the service:

```powershell
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

### Verification API — port 8002

```powershell
Set-Location .\services\motofix-verification-service
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
```

Edit `.env` and set the shared `SECRET_KEY` and the verification database URL
ending in `/motofix_mechanics`. The service creates and updates its tables at
startup; there are no Alembic revision files to apply in this service.

```powershell
uvicorn app.main:app --reload --host 127.0.0.1 --port 8002
```

### Matching API — port 8003

```powershell
Set-Location .\services\motofix-matching-service
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
```

Edit `.env` and set the shared `SECRET_KEY` and the matching database URL ending
in `/motofix_matching`. Keep `MECHANICS_SERVICE_URL=http://127.0.0.1:8002`.
The matching service creates its dispatch-history table at startup.

```powershell
uvicorn app.main:app --reload --host 127.0.0.1 --port 8003
```

### Command Prompt alternative

In Command Prompt, use `.\.venv\Scripts\activate.bat` instead of
`.\.venv\Scripts\Activate.ps1`; the other commands are the same.

Keep each API running in its own terminal. Start them in this order:

1. Auth (`8000`)
2. Verification (`8002`)
3. Matching (`8003`), which calls Verification

Check each service from a separate terminal:

```powershell
curl.exe http://127.0.0.1:8000/health
curl.exe http://127.0.0.1:8002/health
curl.exe http://127.0.0.1:8003/health
```

Interactive API documentation is available at
`http://127.0.0.1:8000/docs`,
`http://127.0.0.1:8002/docs`, and
`http://127.0.0.1:8003/docs`.

## Run the driver app in a browser

Open a fourth terminal from the repository root:

```powershell
Set-Location .\interfaces\motofix-driver-app
npm install
if (-not (Test-Path .env.local)) { Copy-Item .env.example .env.local }
```

The existing `.env.example` uses the app's actual `VITE_API_AUTH_URL` and
`VITE_API_MATCHING_URL` variables and points those APIs to local ports `8000`
and `8003`. Check those values in `.env.local` if you already have one. The
other existing API URL variables point at services outside this minimal setup;
flows needing dispatch/requests (`8001`), insurance (`8006`), or diagnosis
(`8007`) will need those services started separately.

Start Vite:

```powershell
npm run dev
```

Open the URL printed by Vite; with the checked-in configuration it is
`http://127.0.0.1:8085`. The driver app is served as a browser app over HTTP;
no APK build is part of this workflow.

## Scope notes

- Dispatch (`8001`), Core (`8008`), and Diagnosis (`8007`) are optional additions
  for later; they are not required to start these three APIs and the driver UI.
- An Android phone APK cannot use its own `localhost` to reach services running
  on your PC. Local UI development is browser-based on the same Windows machine.
- Do not commit service `.env` or app `.env.local` files. Keep real secrets out
  of `.env.example`; use placeholders there.
