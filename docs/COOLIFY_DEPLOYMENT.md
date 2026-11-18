# MotoFix deployment on Coolify

This checklist targets the full Docker stack currently running on the PC, not
only the `release/v1` driver launch scope. Use Coolify-generated HTTPS URLs for
the first deployment if permanent domain names are not available yet.

## Current local source of truth

- Git branch: `release/v1`.
- Compose project: `motofix-pc`, using `docker-compose.yml` plus the local
  override `D:\Backups\motofix-local.override.yml`.
- The local override selects PostgreSQL 18 and binds the database to
  `127.0.0.1:5434`. It is a PC-specific file and must not be used as the VPS
  override.
- The running stack contains PostgreSQL, Auth, Verification, Dispatch,
  Matching, Notifications, Analytics, Insurance, Diagnosis, Core, and all
  three web apps (driver, provider, admin).

## Database and volume backup

Six custom-format database dumps were made from the running PostgreSQL 18
container and checked with `pg_restore -l`:

- `motofix_auth`
- `motofix_dispatch`
- `motofix_mechanics`
- `motofix_matching`
- `motofix_insurance`
- `motofix_analytics`

The files are in `D:\Backups\motofix-coolify-migration-20261118`. Keep them
private. The `auth_uploads` and `dispatch_media` Docker volumes contained no
files at backup time.

Restore into empty PostgreSQL 18 databases on the VPS, then start the app
services. Do not copy the PC's raw PostgreSQL volume into another PostgreSQL
major version.

## Required work before deployment

1. **Prepare a Coolify-specific Compose configuration.** The local Compose
   setup publishes host ports and includes a hard-coded development database
   password. Keep PostgreSQL private to the Compose network, use a new database
   password, and route public traffic through Coolify.
2. **Supply production environment variables in Coolify.** The service `.env`
   files are ignored by Git and are not present in the repository checkout that
   Coolify deploys. Do not commit them. Create fresh secrets in Coolify; do not
   reuse the Neon password or the JWT secret pasted into chat.
3. **Use service-name URLs for backend-to-backend calls** inside the Compose
   network, such as `http://dispatch-service:8001` and
   `http://verification-service:8002`.
4. **Set public HTTPS/WSS URLs for browser apps.** Vite bakes these values into
   the built web apps, so rebuild the apps whenever their API or WebSocket URLs
   change. Configure Auth, Dispatch, Matching, Verification, Analytics,
   Notifications, Diagnosis, and Insurance URLs as required by each app.
5. **Restore the six database dumps** after the VPS PostgreSQL service is
   healthy, and verify the services connect to the intended databases.

## Local code changes prepared for Coolify

- Driver production builds now accept a configured public HTTPS Auth URL instead
  of being pinned to the old Render hostname.
- The Android workflow checks for the configured Auth URL in its output bundle.
- Admin login now uses the configured Auth API client instead of posting to the
  admin portal's static web origin (the prior 405 failure).

These edits are local on `release/v1`; they have not been pushed. `git diff --check` passed. No build or test suite was run.

## Features that need third-party credentials

The containers can run without every external integration being active. Add
credentials in Coolify only for features you intend to use:

- Africa's Talking for OTP/SMS and notification delivery.
- Firebase service-account configuration for push notifications.
- MTN MoMo or Airtel credentials for live payments.
- Anthropic and Groq keys for AI diagnosis and MOTOBOT. The local diagnosis
  service currently has neither key configured.
- Cloudinary or S3 if uploaded media should be stored outside the Docker volume.

## Public URL plan

The domain names are not available in this workspace yet. Use Coolify-generated
temporary HTTPS URLs first, then replace them with the permanent domains and
rebuild the web apps. The driver Android workflow also needs its API and provider
URLs set in GitHub Actions variables/secrets before generating a production APK.
