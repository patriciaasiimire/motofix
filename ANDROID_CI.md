# Android Builds in GitHub Actions

Android builds target `interfaces/motofix-driver-app`. The workflow runs on GitHub-hosted `ubuntu-latest` runners and creates the native Android project there when it is missing. Developers do not install Capacitor, Android Studio, or the Android SDK and do not run `cap add android` or Gradle locally.

## Run a build

1. Push to `main` or `master` for an automatic debug build, or open **Actions → Android Build → Run workflow**.
2. For a manual run, select `debug` or `release`. Debug is the default.
3. Wait for the workflow run to complete, then download its artifact from the run's **Artifacts** section. Debug builds are named `motofix-driver-debug-apk`; release builds are named `motofix-driver-release-apk-aab` and contain both the APK and AAB.
4. For a debug APK, transfer it to the Android phone and open it. Approve **Install unknown apps** for the file/browser app if Android asks, then confirm installation. Release APKs can be installed the same way; upload the AAB to Google Play Console for store distribution.

If Android reports that the app conflicts with an existing package, the installed `org.motofix.driver` was signed with a different certificate. Uninstall the existing app before installing this APK; uninstalling deletes its local app data. By default, GitHub's fresh runners use different debug certificates, so debug APKs from separate runs may require this. To install future debug builds as updates, configure the stable debug signing secrets below. A debug-signed APK cannot update a release-signed installation; those must use the same release signing key.

## GitHub Secrets

Create these repository secrets for release signing:

- `ANDROID_KEYSTORE_BASE64`: base64-encoded Java keystore file
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Debug builds require none of the signing secrets.

Optional stable debug signing secrets let debug APKs from different workflow runs update the same installation. Generate a dedicated debug keystore, do not reuse the release keystore, and add these repository secrets:

- `ANDROID_DEBUG_KEYSTORE_BASE64`: base64-encoded debug keystore file
- `ANDROID_DEBUG_KEYSTORE_PASSWORD`
- `ANDROID_DEBUG_KEY_ALIAS`
- `ANDROID_DEBUG_KEY_PASSWORD`

On Windows, generate the keystore with `keytool -genkeypair -v -keystore motofix-debug.keystore -storepass <store-password> -alias motofix-debug -keypass <key-password> -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=MotoFix Debug,O=MotoFix,C=UG"`, then encode it with `[Convert]::ToBase64String([IO.File]::ReadAllBytes("motofix-debug.keystore"))`. Keep the keystore out of source control. If these secrets are absent, the workflow uses the standard ephemeral debug signing key.

Optional Vite build secrets are written to `.env.production` only when set; unset values are omitted:

- Backend URLs: `VITE_API_AUTH_URL`, `VITE_API_REQUESTS_URL`, `VITE_API_PAYMENTS_URL`, `VITE_API_DIAGNOSIS_URL`, `VITE_API_MATCHING_URL`, `VITE_API_INSURANCE_URL`
- Realtime/provider links: `VITE_WS_URL`, `VITE_PROVIDER_URL`
- Google Maps: `VITE_GOOGLE_MAPS_API_KEY`, `VITE_GOOGLE_MAPS_MAP_ID`
- Firebase: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`, `VITE_FIREBASE_VAPID_KEY`

Vite embeds these values in the client bundle; restrict public API keys such as Google Maps keys in their provider consoles. No Capacitor or Android tooling is required on the developer PC.