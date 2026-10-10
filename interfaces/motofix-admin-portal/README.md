# motofix-admin-portal

The admin control center for the MOTOFIX platform: analytics and reporting,
breakdown hotspots, user/provider management, and platform settings.

- **Stack:** React + Vite + TypeScript
- **Production container port:** 8082

## Running locally

```bash
npm install
cp .env.example .env.local    # fill in API URLs as needed
npm run dev
```

Build for production: `npm run build`. All `VITE_`-prefixed variables are baked
into the bundle at build time — see [.env.example](.env.example).

Maps use OpenStreetMap tiles and Nominatim reverse geocoding; no Google Maps
API key is required.

See the [root README](../../README.md) for the full platform overview.
