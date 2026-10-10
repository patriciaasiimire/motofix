# motofix-service-provider-app

The mechanic / service-provider dashboard for the MOTOFIX platform: receive
incoming requests, manage active jobs, navigate to drivers, handle spare parts,
and manage subscriptions.

- **Stack:** React + Vite + TypeScript
- **Production container port:** 8084

## Running locally

```bash
npm install
cp .env.example .env.local    # fill in API URLs and keys
npm run dev
```

Build for production: `npm run build`. All `VITE_`-prefixed variables are baked
into the bundle at build time — see [.env.example](.env.example).

MOTOBOT diagnosis, chat, and AI parts pricing are disabled by default in every
environment. They can be enabled explicitly at build time with
`VITE_MOTOBOT_ENABLED=true`. Repair guides and catalogue-based spare-parts
ordering remain available when MOTOBOT is off.

See the [root README](../../README.md) for the full platform overview.
