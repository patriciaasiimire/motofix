import { useEffect, useRef, useState } from 'react'
import { buildRouteMeta, pointAtDist, remainingPath, type LL, type RouteMeta } from '@/utils/routeFollow'
import { serverNow } from '@/utils/serverClock'

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic, time-based "mechanic on the way" simulation.
//
// We don't have real mechanic GPS, so instead of streaming jittery positions we
// derive everything from three values BOTH apps already share for a request:
//   • the driver's location (the request's pinned coordinates)
//   • the request id  (seeds a fixed, believable start point)
//   • en_route_at     (the moment the journey began)
//
// Because the inputs are identical on both sides, the driver app and the
// mechanic app independently compute the SAME shortest road route, the SAME pin
// position, and the SAME monotonically-decreasing ETA — no broadcast needed.
// The whole journey is compressed into SIM_MINUTES so a demo never drags on.
// ─────────────────────────────────────────────────────────────────────────────

export const SIM_MINUTES = 5              // total journey length (~5 min solid for demos)
const SIM_MS = SIM_MINUTES * 60 * 1000

function hashSeed(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

// A fixed, believable start ~4–5 km from the driver. Seeded by the request id so
// every device computes the identical point (and therefore the identical route).
export function simMechStart(driver: LL, seed: string): LL {
  const h = hashSeed(seed || 'x')
  const angle = ((h % 360) * Math.PI) / 180
  const distKm = 4 + (h % 1000) / 1000        // 4.0 – 5.0 km
  const dLat = (distKm / 111) * Math.cos(angle)
  const dLng = (distKm / (111 * Math.cos((driver.lat * Math.PI) / 180))) * Math.sin(angle)
  return { lat: driver.lat + dLat, lng: driver.lng + dLng }
}

function parseTs(ts?: string | null): number {
  if (!ts) return Date.now()
  const t = new Date(/[Z+]/.test(ts) ? ts : ts + 'Z').getTime()
  return isNaN(t) ? Date.now() : t
}

export interface JobSim {
  ready: boolean
  routeMeta: RouteMeta | null
  start: LL | null
  mechPos: LL | null
  remaining: LL[] | null
  progress: number          // 0 → 1
  etaMinutes: number | null // monotonically decreasing
  distanceKm: number | null
}

export function useJobSim(opts: {
  active: boolean                 // a mechanic is assigned & heading over (accepted/en_route)
                                  // → BUILD + show the fixed route and both endpoints
  advancing?: boolean             // status === 'en_route' → ADVANCE the pin/ETA along it
                                  // (defaults to `active` for back-compat)
  driver: LL | null               // the request's pinned location (canonical on both apps)
  seed: string                    // request id
  enRouteAt?: string | null
}): JobSim {
  const { active, driver, seed, enRouteAt } = opts
  const advancing = opts.advancing ?? active

  const metaRef = useRef<RouteMeta | null>(null)
  const startRef = useRef<LL | null>(null)
  const reqRef = useRef(false)
  const seedRef = useRef('')
  // Frozen journey-clock start (ms). Used ONLY when en_route_at is absent so the
  // progress can't reset every render — see the progress note below.
  const clockStartRef = useRef<number | null>(null)
  const [, setTick] = useState(0)

  // New job → discard the old fixed route so it's rebuilt for this request.
  useEffect(() => {
    if (seed !== seedRef.current) {
      seedRef.current = seed
      reqRef.current = false
      metaRef.current = null
      startRef.current = null
      clockStartRef.current = null
      setTick(x => x + 1)
    }
  }, [seed])

  // Freeze a local journey start the FIRST time we go en route without a shared
  // en_route_at. Without this, parseTs(null) returns Date.now() every render, so
  // progress is pinned to ~0 (jittering with the server-clock offset) and the
  // route never visibly shrinks. When en_route_at IS present we use it directly
  // (below) so both apps stay in lock-step.
  useEffect(() => {
    if (!advancing || enRouteAt) { clockStartRef.current = null; return }
    if (clockStartRef.current == null) clockStartRef.current = serverNow()
  }, [advancing, enRouteAt])

  // Draw a simple straight-line route between the deterministic start and driver.
  useEffect(() => {
    if (!active || !driver || reqRef.current) return
    reqRef.current = true
    const start = simMechStart(driver, seed)
    startRef.current = start
    metaRef.current = buildRouteMeta([start, driver])
    setTick(x => x + 1)
  }, [active, driver?.lat, driver?.lng, seed])

  // Animation clock — re-render a few times a second while the pin is advancing.
  useEffect(() => {
    if (!advancing) return
    const t = setInterval(() => setTick(x => x + 1), 400)
    return () => clearInterval(t)
  }, [advancing])

  const meta = metaRef.current
  // serverNow() (not the device clock) so every device shows the same point.
  // Prefer the shared en_route_at (keeps both apps in lock-step); fall back to the
  // frozen local start so the journey still advances when the snapshot didn't
  // carry en_route_at.
  const startMs = enRouteAt ? parseTs(enRouteAt) : clockStartRef.current
  // Progress only moves while advancing (en route). At the accepted stage it stays
  // 0, so the route is fully drawn with the pin parked at its start.
  const progress = advancing && startMs != null
    ? Math.max(0, Math.min(1, (serverNow() - startMs) / SIM_MS))
    : 0

  let mechPos: LL | null = null
  let remaining: LL[] | null = null
  let distanceKm: number | null = null
  if (meta && meta.total > 0) {
    const dist = progress * meta.total
    mechPos = pointAtDist(meta, dist)
    remaining = remainingPath(meta, dist)
    distanceKm = meta.total * (1 - progress)
  }
  const etaMinutes = meta ? Math.max(0, Math.ceil((1 - progress) * SIM_MINUTES)) : null

  return {
    ready: !!meta,
    routeMeta: meta,
    start: startRef.current,
    mechPos,
    remaining,
    progress,
    etaMinutes,
    distanceKm,
  }
}
