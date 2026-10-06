# GitHub Actions CI

All frontend builds run on GitHub-hosted runners. Developers do not need Docker, Podman, Android Studio, an Android SDK, or local Capacitor/Gradle builds. Actions build and test the project; live APIs must be deployed to Railway, Render, Fly.io, or a VPS. See [LOCAL_BACKEND.md](LOCAL_BACKEND.md) only for optional offline development.

| Workflow | What it does | Artifacts |
|---|---|---|
| `.github/workflows/android-build.yml` | Driver web build, runner-side Capacitor/Android generation, debug APK every run; manual release also builds signed APK and Play Store AAB | `motofix-driver-debug-apk`; on release, `motofix-driver-release-apk-aab` (contains APK + AAB) |
| `.github/workflows/web-provider-build.yml` | Builds the web-only provider app | `motofix-provider-web-dist` |
| `.github/workflows/admin-build.yml` | Builds the admin portal | `motofix-admin-portal-dist` |
| `.github/workflows/ci.yml` | Runs pytest for auth, verification, matching, diagnosis, dispatch, and analytics; compile-checks Python services | None |

Build artifacts are retained for 14 days. Use the debug APK artifact for phone sideloading; use the release AAB for Play Store distribution. Provider and admin workflows also run on pull requests; all frontend workflows support pushes to `main`/`master`, with manual dispatch enabled where configured.

## Secrets

Release signing secrets are required only for a driver release run: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. Debug APK builds need no signing secrets.

Optional frontend secrets are mapped only when set; unset values are omitted from `.env.production`:

- Driver: `VITE_API_AUTH_URL`, `VITE_API_REQUESTS_URL`, `VITE_API_PAYMENTS_URL`, `VITE_API_DIAGNOSIS_URL`, `VITE_API_MATCHING_URL`, `VITE_API_INSURANCE_URL`, `VITE_WS_URL`, `VITE_PROVIDER_URL`, `VITE_GOOGLE_MAPS_API_KEY`, `VITE_GOOGLE_MAPS_MAP_ID`, and `VITE_FIREBASE_*` values. See [ANDROID_CI.md](ANDROID_CI.md) for the full list.
- Provider: `PROVIDER_VITE_API_AUTH_URL`, `PROVIDER_VITE_API_MECHANICS_URL`, `PROVIDER_VITE_API_REQUESTS_URL`, `PROVIDER_VITE_API_DIAGNOSIS_URL`, `PROVIDER_VITE_API_SUBSCRIPTIONS_URL`, `PROVIDER_VITE_GOOGLE_MAPS_API_KEY`, and `PROVIDER_VITE_FIREBASE_*` values.
- Admin: `ADMIN_VITE_API_ADMIN_URL`, `ADMIN_VITE_API_REQUESTS_URL`, `ADMIN_VITE_API_MECHANICS_URL`, `ADMIN_VITE_API_AUTH_URL`, `ADMIN_VITE_API_NOTIFICATIONS_URL`, `ADMIN_VITE_API_BASE_URL`, and `ADMIN_VITE_GOOGLE_MAPS_API_KEY`.

These Vite values are embedded in built frontend files; restrict public API keys in their provider consoles. Web artifacts can be deployed to Cloudflare Pages, Netlify, or another static host. API services need a persistent host; GitHub Actions runners are not for running APIs continuously.