// utils/warmup.ts — wakes the backend services up before the driver needs them.
//
// Render's free tier sleeps idle services, and a sleeping service takes up to a minute
// to answer. Opening the app is a good moment to nudge them: by the time the driver has
// typed a phone number, entered the code and picked an area, everything is awake.
//
// Each call is fire-and-forget: it hits the lightweight /health route, ignores the
// answer, and never shows anything to the user. `no-cors` means it still wakes the
// service even if the browser would not let us read the reply.
//
// No imports on purpose, so it can be tested on its own.

const WARM_INTERVAL_MS = 5 * 60 * 1000;
let lastWarmAt = 0;

export function warmServices(
  baseUrls: Array<string | undefined | null>,
  options: { force?: boolean } = {},
): void {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

  const now = Date.now();
  if (!options.force && now - lastWarmAt < WARM_INTERVAL_MS) return;

  const unique = Array.from(
    new Set(
      baseUrls
        .filter((url): url is string => typeof url === 'string' && url.length > 0)
        .map((url) => url.replace(/\/+$/, '')),
    ),
  );
  if (unique.length === 0) return; // e.g. local dev, where the Vite proxy is used instead
  lastWarmAt = now;

  for (const base of unique) {
    try {
      void fetch(`${base}/health`, { mode: 'no-cors', cache: 'no-store' }).catch(() => undefined);
    } catch {
      // Never let a warm-up problem affect the app.
    }
  }
}

/** Test helper: forget when we last warmed up. */
export function resetWarmupThrottle(): void {
  lastWarmAt = 0;
}
