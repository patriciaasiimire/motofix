# Keep MotoFix Render services warm

Configure a free external uptime monitor such as UptimeRobot or cron-job.org
with one HTTPS monitor per service:

| Service | Health URL |
| --- | --- |
| Auth | https://motofix-auth.onrender.com/health |
| Matching | https://motofix-matching.onrender.com/health |
| Verification | https://motofix-verification.onrender.com/health |
| Dispatch | https://motofix-dispatch.onrender.com/health |

Use **HTTP GET**, check every **10–14 minutes**, and configure an alert for any
non-2xx response or request timeout. These `/health` endpoints return HTTP 200
without requiring authentication or a database connection. The auth endpoint
also includes existing service metadata in its JSON response.

Create and enable the monitors in the provider's website; the repository cannot
create monitor accounts or configure them on your behalf.

External pingers reduce Render free-tier sleeping but cannot guarantee that a
service will never sleep or cold-start. The first request after a long gap can
still be slow, and an external monitor may itself miss a scheduled ping.
