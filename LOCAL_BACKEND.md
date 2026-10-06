# Local Backend (Windows)

Run the first three API services directly on Windows with Python virtual environments and local PostgreSQL. Docker and Podman are not needed. Install Python and PostgreSQL for Windows; configure PostgreSQL to listen on port `5433` (or change the port in each `.env` if your local server uses `5432`).

## Create databases

In PowerShell, create the service databases using `psql` (or run the SQL in pgAdmin):

```powershell
psql -h localhost -p 5433 -U postgres -d postgres
```

At the `psql` prompt:

```sql
CREATE DATABASE motofix_auth;
CREATE DATABASE motofix_mechanics;
CREATE DATABASE motofix_matching;
\q
```

The configured PostgreSQL user's password must match the `password` part of the service `DATABASE_URL` values below. If you use another password or port, update each service's `.env` accordingly.

Generate one shared JWT key once, then paste that exact value into all three service `.env` files:

```powershell
py -c "import secrets; print(secrets.token_hex(32))"
```

## Create the service environments

Run these commands once for each service. Copy `.env.example` to `.env`, then edit `.env` to set `SECRET_KEY` to the shared value, confirm `DATABASE_URL`, and adjust optional integrations as needed. Do not commit `.env`.

### Auth (port 8000)

```powershell
Set-Location E:\downloads\TECH\motofix\services\motofix-auth-service
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
Copy-Item .env.example .env
# Edit .env: DATABASE_URL=postgresql://postgres:password@localhost:5433/motofix_auth
# Set SECRET_KEY to the shared JWT key.
uvicorn app.main:app --reload --port 8000
```

### Verification (port 8002)

Open another PowerShell terminal:

```powershell
Set-Location E:\downloads\TECH\motofix\services\motofix-verification-service
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
Copy-Item .env.example .env
# Edit .env: DATABASE_URL=postgresql://postgres:password@localhost:5433/motofix_mechanics
# Set SECRET_KEY to the same shared JWT key.
uvicorn app.main:app --reload --port 8002
```

### Matching (port 8003)

Open a third PowerShell terminal:

```powershell
Set-Location E:\downloads\TECH\motofix\services\motofix-matching-service
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
Copy-Item .env.example .env
# Edit .env: DATABASE_URL=postgresql://postgres:password@localhost:5433/motofix_matching
# Set SECRET_KEY to the same shared JWT key; keep MECHANICS_SERVICE_URL=http://localhost:8002.
uvicorn app.main:app --reload --port 8003
```

PowerShell may block activation scripts. For the current terminal only, run `Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned`, then activate the venv again. The activation is per terminal; each service should stay running in its own terminal.

## Health checks

In another PowerShell terminal:

```powershell
curl.exe http://localhost:8000/health
curl.exe http://localhost:8002/health
curl.exe http://localhost:8003/health
```

The service startup creates or migrates its tables in the corresponding database. Dispatch (`8001`), core (`8008`), and diagnosis (`8007`) can be added later; they are not required for this initial three-service setup.