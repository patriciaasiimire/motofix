# motofix-driver-app

The driver-facing app for the MOTOFIX platform: request roadside assistance,
track providers, find fuel stations and spare-parts dealers, get maintenance
reminders, and chat with the MOTOBOT AI assistant.

- **Stack:** React + Vite + TypeScript
- **Production container port:** 8083

## Running locally

```bash
npm install
cp .env.example .env.local    # set VITE_GOOGLE_MAPS_API_KEY
npm run dev
```

Vite serves the driver app at `http://127.0.0.1:8085` by default. Configure the
Google Maps API key's HTTP referrer restrictions to allow both:

- `http://127.0.0.1:8085/*`
- `http://localhost:8085/*`

Enable Maps JavaScript API, Geocoding API, and Directions API in the key's Google
Cloud project, and ensure billing is active. The app uses Maps JavaScript API for
map tiles, Geocoding API for address lookups, and Directions API for routes; it
does not use Places API. `VITE_GOOGLE_MAPS_MAP_ID` is optional and is only used
for 3D styling in the fuel flow. Restart Vite after changing `.env.local`.

Build for production: `npm run build`. All `VITE_`-prefixed variables are baked
into the bundle at build time — see [.env.example](.env.example).

MOTOBOT diagnosis, chat, and AI parts pricing are disabled by default in every
environment. Enable them explicitly at build time with
`VITE_MOTOBOT_ENABLED=true`. Spare-parts orders remain available through the
manual parts catalogue and its category picker; the selected category is saved
with the order. Nearby dealer lookup does not require MOTOBOT.

See the [root README](../../README.md) for the full platform overview.
