// tabs/ActiveJob.tsx — the focused screen for the job the mechanic is currently doing: live
// map + route to the customer, the status steps (en route → arrived → in progress → complete),
// call/message actions, the diagnostic tool, and recording the charge + what was fixed at the end.

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Navigation2, Phone, MessageCircle, MapPin, Maximize2, Minimize2, Stethoscope, ChevronLeft, Wrench, Smartphone, Clock, User, Star, Ban, Check, Sparkles, Wallet, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import CancelJobModal from '@/components/CancelJobModal'
import type { LL } from '@/utils/routeFollow'
import { useJobSim, SIM_MINUTES } from '@/hooks/useJobSim'
import { reverseGeocode } from '@/utils/geocode'
import { C } from '@/styles/tokens'
import { jobService, reviewService, chatService, estimateService } from '@/config/api'
import type { ServiceEstimate } from '@/config/api'
import { useLocation } from '@/hooks/useLocation'
import StatusBar from '@/components/StatusBar'
import EmptyState from '@/components/EmptyState'
import DiagnosticTool from '@/components/DiagnosticTool'
import TrackingMap from '@/components/TrackingMap'
import { formatUGX } from '@/utils/formatters'
import { MOTOBOT_ENABLED } from '@/config/features'
import type { ServiceRequest } from '@/types'

function initials(name?: string) {
  if (!name) return 'D'
  const p = name.trim().split(' ')
  return p.length === 1 ? p[0].slice(0, 2).toUpperCase() : (p[0][0] + p[p.length - 1][0]).toUpperCase()
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function parseEtaMinutes(text: string): number | null {
  const h = text.match(/(\d+)\s*h/i)
  const m = text.match(/(\d+)\s*m/i)
  if (!h && !m) return null
  return (h ? parseInt(h[1]) * 60 : 0) + (m ? parseInt(m[1]) : 0)
}

// ─── Shared traffic-aware ETA ─────────────────────────────────────────────────
// MUST stay identical to the driver app's estimateEta() (RequestDetail.tsx) so
// both screens always show the same time. Effective speed adapts to time of day.
function estimateEta(distanceKm: number, now: Date = new Date()): { minutes: number; durationText: string; distanceText: string } {
  const hour = now.getHours()
  let speed: number // average effective km/h including traffic
  if      (hour >= 7  && hour < 10) speed = 17 // morning rush — heavy jam
  else if (hour >= 10 && hour < 16) speed = 27 // midday — moderate
  else if (hour >= 16 && hour < 20) speed = 15 // evening rush — worst jam
  else if (hour >= 20 && hour < 23) speed = 33 // evening — light traffic
  else                              speed = 42 // late night / early morning — clear
  const roadKm = distanceKm * 1.35
  const minutes = Math.max(1, Math.round((roadKm / speed) * 60))
  const durationText = minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr ${minutes % 60} min`
  const distanceText = roadKm < 1 ? `${Math.round(roadKm * 1000)} m` : `${roadKm.toFixed(1)} km`
  return { minutes, durationText, distanceText }
}

// Shared arrival-time window — MUST match the driver app's arrivalWindow().
function arrivalWindow(enRouteAt?: string, etaMinutes?: number | null): string | null {
  if (!enRouteAt || etaMinutes == null) return null
  const ts = /[Z+]/.test(enRouteAt) ? enRouteAt : enRouteAt + 'Z'
  const start = new Date(ts)
  if (isNaN(start.getTime())) return null
  const arrival = start.getTime() + etaMinutes * 60000
  const pad = Math.max(10, Math.round(etaMinutes * 0.4)) * 60000
  const round5 = (ms: number) => { const d = new Date(ms); d.setMinutes(Math.round(d.getMinutes() / 5) * 5, 0, 0); return d }
  const fmt = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const loStr = fmt(round5(arrival)), hiStr = fmt(round5(arrival + pad))
  return loStr.slice(-2) === hiStr.slice(-2) ? `${loStr.replace(/\s?[AP]M$/i, '')} – ${hiStr}` : `${loStr} – ${hiStr}`
}

// Arrival threshold in metres
const ARRIVAL_THRESHOLD_M = 20

const JOB_STATUS_BADGE: Record<string, { label: string; color: string }> = {
  accepted:               { label: 'Accepted',              color: '#3B82F6' },
  en_route:               { label: 'On the Way',            color: '#F59E0B' },
  arrived:                { label: 'Arrived',               color: '#8B5CF6' },
  in_progress:            { label: 'In Progress',           color: '#F97316' },
  awaiting_confirmation:  { label: 'Awaiting Confirmation', color: '#A78BFA' },
  completed:              { label: 'Completed',             color: '#22C55E' },
}

interface ActiveJobProps {
  activeRequest: ServiceRequest | null
  sendMessage: (data: object) => void
  lastMessage: unknown
  onJobCompleted: () => void
  onBack?: () => void
}

// Treat a naive timestamp as UTC so it renders correctly in EAT.
function normTs(ts: string): string {
  return /[Z+]/.test(ts) ? ts : ts + 'Z'
}

// Condense the driver's request description for the mechanic: keep the core issue,
// strip the verbose MOTOBOT photo-check parenthetical, and surface the AI verdict separately.
function splitDescription(desc: string): { main: string; aiNote: string } {
  const marker = 'MOTOBOT photo check:'
  const idx = desc.indexOf(marker)
  if (idx === -1) return { main: desc.trim(), aiNote: '' }
  const main = desc.slice(0, idx).trim()
  const aiNote = desc.slice(idx + marker.length).replace(/\s*\([^)]*\)\s*$/, '').trim() // drop the long parenthetical detail
  return { main, aiNote }
}

// Pull the driver's chosen tow-to garage out of the request description.
function parseGarageDest(desc?: string | null): { name: string; area: string; phone: string; lat?: number; lng?: number } | null {
  if (!desc || !/specified garage/i.test(desc)) return null
  const name  = desc.match(/Name:\s*(.+)/i)?.[1]?.trim() ?? ''
  const area  = desc.match(/Area:\s*(.+)/i)?.[1]?.trim() ?? ''
  const phone = desc.match(/Phone:\s*(.+)/i)?.[1]?.trim() ?? ''
  const m = desc.match(/Map:\s*([-\d.]+)\s*,\s*([-\d.]+)/i)
  if (!name && !area) return null
  return { name, area, phone, lat: m ? parseFloat(m[1]) : undefined, lng: m ? parseFloat(m[2]) : undefined }
}

export default function ActiveJob({ activeRequest, sendMessage, lastMessage, onJobCompleted, onBack }: ActiveJobProps) {
  const navigate = useNavigate()
  const [actionLoading, setActionLoading] = useState(false)
  const [driverPos, setDriverPos] = useState<{ lat: number; lng: number } | null>(null)
  const [locationText, setLocationText] = useState('Loading location…')
  const [showCompletion, setShowCompletion] = useState(false)
  const [actualFee, setActualFee] = useState('')
  const [serviceNote, setServiceNote] = useState('')
  // AI completion helper: tickable fixes + cost/transport estimate + reasonableness.
  const [estimate, setEstimate] = useState<ServiceEstimate | null>(null)
  const [estimateLoading, setEstimateLoading] = useState(false)
  const [selectedFixes, setSelectedFixes] = useState<string[]>([])

  // Quote state
  const [quoteAmount, setQuoteAmount] = useState('')
  const [quoteDesc, setQuoteDesc] = useState('')
  const [quoteSent, setQuoteSent] = useState(false)

  // Diagnostic tool
  const [showDiagnostic, setShowDiagnostic] = useState(false)

  // Arrival detection
  const [arrivedToast, setArrivedToast] = useState(false)
  const [bdOutcome, setBdOutcome] = useState<'fixed' | 'towing' | null>(null)  // breakdown: fixed on-site vs towed
  const arrivedTriggeredRef = useRef(false)
  const fiveMinMsgSentRef  = useRef(false)

  // GPS Simulator (dev-only)
  const [simPos, setSimPos] = useState<{ lat: number; lng: number } | null>(null)
  const simIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const activeRequestRef = useRef(activeRequest)
  const driverPosRef = useRef<{ lat: number; lng: number } | null>(null)

  // Call options sheet
  const [showCallSheet, setShowCallSheet] = useState(false)

  // Driver rating prompt (shown when awaiting_confirmation or completed)
  const [driverRating, setDriverRating] = useState(0)
  const [driverComment, setDriverComment] = useState('')
  const [isSubmittingRating, setIsSubmittingRating] = useState(false)
  // Payment-received confirmation — opens when the driver completes payment.
  const [paymentReq, setPaymentReq] = useState<{ method: string; amount: number } | null>(null)
  const [ratingSubmitted, setRatingSubmitted] = useState(false)
  const [ratingDismissed, setRatingDismissed] = useState(false)

  const lastLocationSentRef = useRef(0)
  // Refs for current position values — used inside intervals to avoid stale closures
  // Mechanic-initiated cancellation (with reason + suspension warning).
  const [cancelOpen, setCancelOpen] = useState(false)
  const handleCancelled = useCallback((outcome: { strikes: number; suspended: boolean; limit: number; suspension_count?: number } | null) => {
    setCancelOpen(false)
    if (outcome?.suspended) {
      const repeat = (outcome.suspension_count ?? 1) > 1
      toast.error(
        repeat
          ? 'Account suspended again for repeated cancellations. You must contact MOTOFIX Support to be reinstated — further offences may close your account.'
          : 'Account suspended after 3 cancellations. Contact MOTOFIX Support to explain and be reinstated. A repeat will be treated more seriously.',
        { duration: 9000 },
      )
    } else if (outcome && outcome.strikes > 0) {
      // Escalating warning so the mechanic knows exactly where they stand.
      const left = Math.max(0, (outcome.limit ?? 3) - outcome.strikes)
      toast(
        `Cancellation recorded — strike ${outcome.strikes} of ${outcome.limit ?? 3}. Cancel ${left} more in a row and you'll be temporarily suspended.`,
        { icon: '⚠️', duration: 7000 },
      )
    } else {
      toast('Job cancelled — the driver has been notified.', { duration: 5000 })
    }
    onBack?.()  // the cancelled status also broadcasts over WS and clears the active job
  }, [onBack])

  // Unread chat count shown on the Chat button (driver messages not yet opened).
  const [chatUnread, setChatUnread] = useState(0)
  useEffect(() => {
    if (!activeRequest?.id) return
    chatService.unread(String(activeRequest.id), 'mechanic')
      .then(res => setChatUnread(res.data?.unread ?? 0))
      .catch(() => {})
  }, [activeRequest?.id])
  useEffect(() => {
    const m = lastMessage as { type?: string; service_request_id?: string; sender_role?: string } | null
    if (m?.type === 'chat_message' && String(m.service_request_id) === String(activeRequest?.id) && m.sender_role === 'driver') {
      setChatUnread(c => c + 1)
    }
  }, [lastMessage, activeRequest?.id])

  const { lat: myLat, lng: myLng } = useLocation(!!activeRequest)
  // In dev, fall back to Makerere University when the laptop has no real GPS
  const DEV_LAT = import.meta.env.DEV ? (Number(import.meta.env.VITE_DEV_MECH_LAT) || 0.3347) : null
  const DEV_LNG = import.meta.env.DEV ? (Number(import.meta.env.VITE_DEV_MECH_LNG) || 32.5679) : null
  const effectiveLat = myLat ?? DEV_LAT ?? undefined
  const effectiveLng = myLng ?? DEV_LNG ?? undefined
  // Keep refs in sync so interval callbacks always read the latest position
  useEffect(() => { effectiveLatRef.current = effectiveLat ?? null }, [effectiveLat])
  useEffect(() => { effectiveLngRef.current = effectiveLng ?? null }, [effectiveLng])

  useEffect(() => {
    // Only ever derive location text from real GPS coordinates — never from raw text fields
    // which may contain phone numbers, freeform notes, etc.
    if (activeRequest?.location_lat != null && activeRequest?.location_lng != null) {
      setDriverPos({ lat: activeRequest.location_lat, lng: activeRequest.location_lng })
      reverseGeocode(activeRequest.location_lat, activeRequest.location_lng).then(setLocationText)
    } else if (activeRequest?.location) {
      const parts = activeRequest.location.split(',').map(Number)
      if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        setDriverPos({ lat: parts[0], lng: parts[1] })
        reverseGeocode(parts[0], parts[1]).then(setLocationText)
      } else {
        // Raw text field — ignore, wait for live GPS from WebSocket
        setLocationText('Locating driver…')
      }
    } else {
      setLocationText('Locating driver…')
    }
    arrivedTriggeredRef.current = false
  }, [activeRequest?.id])

  // Keep refs up-to-date (used inside intervals where closure would otherwise be stale)
  useEffect(() => { activeRequestRef.current = activeRequest }, [activeRequest])
  useEffect(() => { driverPosRef.current = driverPos }, [driverPos])

  // Update driver position + geocode address from live WS location updates
  useEffect(() => {
    const msg = lastMessage as { type?: string; role?: string; lat?: number; lng?: number } | null
    if (
      msg?.type === 'location_update' &&
      msg.lat != null && msg.lng != null &&
      msg.role !== 'mechanic'
    ) {
      setDriverPos({ lat: msg.lat, lng: msg.lng })
      reverseGeocode(msg.lat, msg.lng).then(setLocationText)
    }
  }, [lastMessage])

  // Driver completed payment → ask the mechanic to confirm they received it.
  useEffect(() => {
    const msg = lastMessage as { type?: string; service_request_id?: string | number; method?: string; amount?: number } | null
    if (msg?.type === 'payment_completed' && activeRequest && String(msg.service_request_id) === String(activeRequest.id)) {
      setPaymentReq({ method: msg.method || 'momo', amount: Number(msg.amount) || 0 })
    }
  }, [lastMessage, activeRequest?.id])

  const updateStatus = useCallback(async (status: string, extra?: Record<string, unknown>) => {
    if (!activeRequest) return
    setActionLoading(true)
    try {
      await jobService.updateStatus(activeRequest.id, status, extra)
      if (status === 'awaiting_confirmation') setShowCompletion(false)
      if (status === 'completed') onJobCompleted()
    } finally {
      setActionLoading(false)
    }
  }, [activeRequest, onJobCompleted])

  // When the completion sheet opens, fetch the AI fix-list + cost/transport estimate
  // for this fault so the mechanic can tick (not type) and get a fair-price guide.
  useEffect(() => {
    if (!showCompletion || !activeRequest) return
    let alive = true
    setEstimate(null)
    setSelectedFixes([])
    setEstimateLoading(true)
    estimateService.get({
      issue_type: activeRequest.issue_type ?? activeRequest.service_type,
      description: activeRequest.description,
      distance_km: activeRequest.distance_km,
    })
      .then(est => { if (alive && est) setEstimate(est) })
      .finally(() => { if (alive) setEstimateLoading(false) })
    return () => { alive = false }
  }, [showCompletion, activeRequest?.id])

  // Deterministic shared simulation — identical route/pin/ETA as the driver app.
  // Keyed off the STABLE request location (not the live-GPS driverPos, which the
  // driver may broadcast) so both apps compute exactly the same route.
  const enRoute = activeRequest?.status === 'en_route'
  // The driver's STABLE pinned location. normalizeRequest() already parses the
  // request's "lat,lng" string into location_lat/location_lng, so use those — they
  // never go null (unlike the live-GPS `driverPos`, which is only set intermittently
  // by WS broadcasts and was making the blue driver pin disappear). Fall back to a
  // raw location string, then the live driverPos, only if coords aren't present.
  const reqDriver: LL | null = useMemo(() => {
    const r = activeRequest as any
    if (r?.location_lat != null && r?.location_lng != null) {
      return { lat: Number(r.location_lat), lng: Number(r.location_lng) }
    }
    const loc = r?.location ?? r?.location_address
    if (loc) {
      const [lat, lng] = String(loc).split(',').map(Number)
      if (!isNaN(lat) && !isNaN(lng) && (lat !== 0 || lng !== 0)) return { lat, lng }
    }
    return driverPos
  }, [
    (activeRequest as any)?.location_lat, (activeRequest as any)?.location_lng,
    (activeRequest as any)?.location, (activeRequest as any)?.location_address, driverPos,
  ])
  const sim = useJobSim({
    isLoaded,
    active: !!enRoute,
    driver: reqDriver,
    seed: String(activeRequest?.id ?? ''),
    enRouteAt: (activeRequest as any)?.en_route_at ?? null,
  })

  // Pin the driver at the request's fixed coordinates — i.e. the route's destination —
  // so the blue pin always sits exactly at the end of the drawn route. Using live GPS
  // here would let the pin drift off the route end (or hide under the mechanic pin)
  // whenever the driver app broadcasts a position different from the pinned request.
  const driverMarkerPos: LL | null = reqDriver ?? driverPos

  // Auto-advance to "arrived" once the simulated journey completes.
  useEffect(() => {
    if (enRoute && sim.ready && sim.progress >= 1 && !arrivedTriggeredRef.current) {
      arrivedTriggeredRef.current = true
      updateStatus('arrived')
      setArrivedToast(true)
      setTimeout(() => setArrivedToast(false), 4000)
    }
  }, [enRoute, sim.ready, sim.progress, updateStatus])

  const submitDriverReview = useCallback(async () => {
    if (!activeRequest || driverRating === 0) return
    setIsSubmittingRating(true)
    try {
      await reviewService.submit(activeRequest.id, { rating: driverRating, comment: driverComment })
      setRatingSubmitted(true)
    } catch {
      // Non-blocking — just dismiss on failure
      setRatingSubmitted(true)
    } finally {
      setIsSubmittingRating(false)
    }
  }, [activeRequest, driverRating, driverComment])

  // Broadcast own location every 10s + auto-detect arrival when en_route
  // Skipped when GPS simulator is active (simulator handles its own broadcasts)
  useEffect(() => {
    if (!activeRequest || myLat == null || myLng == null) return
    const now = Date.now()
    if (now - lastLocationSentRef.current < 10000) return
    lastLocationSentRef.current = now
    sendMessage({ type: 'location_update', role: 'mechanic', lat: myLat, lng: myLng, service_request_id: activeRequest.id })

    // Auto-detect arrival: when en_route and within threshold of driver
    if (
      activeRequest.status === 'en_route' &&
      !arrivedTriggeredRef.current &&
      driverPos
    ) {
      const distM = haversineKm(myLat, myLng, driverPos.lat, driverPos.lng) * 1000
      if (distM <= ARRIVAL_THRESHOLD_M) {
        arrivedTriggeredRef.current = true
        updateStatus('arrived')
        setArrivedToast(true)
        setTimeout(() => setArrivedToast(false), 4000)
      }
    }
  }, [myLat, myLng, activeRequest, sendMessage, driverPos, updateStatus])

  // Broadcast mechanic position every 15s when en_route — ensures driver map updates even if GPS hasn't moved
  useEffect(() => {
    if (!activeRequest || activeRequest.status !== 'en_route') return
    const tick = () => {
      const lat = effectiveLatRef.current
      const lng = effectiveLngRef.current
      if (lat == null || lng == null) return
      sendMessage({ type: 'location_update', role: 'mechanic', lat, lng, service_request_id: activeRequest.id })
      lastLocationSentRef.current = Date.now()
    }
    tick() // broadcast immediately on en_route
    const timer = setInterval(tick, 15000)
    return () => clearInterval(timer)
  }, [activeRequest?.status, activeRequest?.id, sendMessage])

  // Check the shared ETA every 15s when en_route and auto-chat "5 minutes away"
  // once. The route itself stays fixed — we only re-evaluate the time.
  useEffect(() => {
    if (activeRequest?.status !== 'en_route') return
    const check = () => {
      const lat = effectiveLatRef.current
      const lng = effectiveLngRef.current
      const dp  = driverPosRef.current
      if (lat == null || lng == null || !dp) return
      const etaMins = estimateEta(haversineKm(lat, lng, dp.lat, dp.lng)).minutes
      if (etaMins <= 5 && !fiveMinMsgSentRef.current) {
        fiveMinMsgSentRef.current = true
        const curReq = activeRequestRef.current
        if (curReq) {
          sendMessage({
            type: 'chat_message',
            service_request_id: String(curReq.id),
            message: `⏱ I'll be at your location in about ${etaMins > 1 ? `${etaMins} minutes` : '1 minute'}!`,
            sender_id: 'system',
          })
        }
      }
    }
    check()
    const timer = setInterval(check, 15000)
    return () => clearInterval(timer)
  }, [activeRequest?.status, activeRequest?.id, sendMessage])

  const sendQuote = () => {
    if (!activeRequest || !quoteAmount) return
    sendMessage({ type: 'price_quote', service_request_id: activeRequest.id, amount: Number(quoteAmount), description: quoteDesc })
    setQuoteSent(true)
    setTimeout(() => setQuoteSent(false), 3000)
  }

  const handleDiagnosisComplete = (
    _result: Record<string, unknown>,
    suggestedPrice: number,
    diagDescription: string
  ) => {
    setQuoteAmount(String(suggestedPrice))
    setQuoteDesc(diagDescription)
    setShowDiagnostic(false)
  }

  if (!activeRequest) {
    return <EmptyState icon={Navigation2} title="No Active Job" subtitle="Accept a request from the Jobs tab to see it here." />
  }

  const status = activeRequest.status
  const garageDest = parseGarageDest((activeRequest as { description?: string } | null)?.description)
  const driverPhotos = (activeRequest.media_files ?? []).filter(m => m.file_type === 'photo' || m.file_type === 'image').map(m => m.url)
  const myPos = effectiveLat != null && effectiveLng != null ? { lat: effectiveLat, lng: effectiveLng } : null

  // "I Have Arrived" is removed — only these manual transitions remain
  const actionConfig: Record<string, { label: string; next: string; disabled?: boolean }> = {
    accepted:    { label: "🚗 I'm On My Way",          next: 'en_route' },
    // en_route: handled automatically by proximity detection
    arrived:     { label: '🔧 Starting Work Now',      next: 'in_progress' },
    in_progress: { label: '✅ Service Provided – Done', next: 'awaiting_confirmation' },
  }
  const action = actionConfig[status]
  // Roadside assist is triage/first aid; explicit tow jobs are completed after delivery.
  const jobTypeText = `${activeRequest.issue_type ?? ''} ${activeRequest.service_type ?? ''}`.toLowerCase()
  const isTowJob = /tow|recovery/.test(jobTypeText)
  const isRoadsideAssist = !isTowJob && /roadside assist|breakdown/.test(jobTypeText)
  // Specific "in progress" wording for the job-progress card — no generic "repair / refuel".
  const _issueLabel = activeRequest.issue_type ?? activeRequest.service_type ?? ''
  const _svcText = `${activeRequest.issue_type ?? ''} ${activeRequest.service_type ?? ''}`.toLowerCase()
  const serviceDesc =
    /fuel/.test(_svcText) ? 'Refuelling your vehicle' :
    /tow/.test(_svcText)  ? 'Towing your vehicle to safety' :
    _issueLabel           ? `Working on your ${_issueLabel.toLowerCase()}` :
    'Service work is underway'
  const needOutcome = isRoadsideAssist && status === 'in_progress' && !bdOutcome
  const isAwaitingConfirmation = status === 'awaiting_confirmation'
  // Who started the completion handshake. If the DRIVER (or the system) did, the
  // mechanic is the one who needs to confirm; otherwise the mechanic is waiting.
  const completionBy = (activeRequest as any)?.completion_by as string | null | undefined
  const mechanicInitiated = !completionBy || completionBy === 'mechanic'
  const showRatingPrompt = (isAwaitingConfirmation || status === 'completed') && !ratingSubmitted && !ratingDismissed

  return (
    <>
      <style>{`
        @keyframes slideUp { from{transform:translateY(100%)} to{transform:translateY(0)} }
        @keyframes arrivedPop { 0%{transform:translateY(40px);opacity:0} 20%{transform:translateY(0);opacity:1} 80%{opacity:1} 100%{opacity:0} }
        .motofix-map .gm-style-cc,
        .motofix-map a[href^="https://maps.google.com/maps"],
        .motofix-map .gmnoscreen { display: none !important; }
      `}</style>

      {/* Arrived toast */}
      {arrivedToast && (
        <div style={{
          position: 'fixed', bottom: 100, left: '50%', transform: 'translateX(-50%)', zIndex: 500,
          background: C.green, color: '#000', fontWeight: 800, fontSize: 14,
          padding: '12px 24px', borderRadius: 20, boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
          animation: 'arrivedPop 4s ease forwards', whiteSpace: 'nowrap',
        }}>
          📍 You've arrived — driver has been notified!
        </div>
      )}

      <div style={{ height: 'calc(100vh - 84px)', overflowY: 'auto', overflowX: 'hidden' }}>

        {/* Sticky header — matches driver app style */}
        {(() => {
          const jobBadge = JOB_STATUS_BADGE[status] ?? { label: status.replace(/_/g, ' '), color: C.amber }
          const shortId = `#${String(activeRequest.id).padStart(6, '0')}`
          return (
            <div style={{
              position: 'sticky', top: 0, zIndex: 50,
              background: 'var(--header-bg)',
              backdropFilter: 'blur(16px)',
              WebkitBackdropFilter: 'blur(16px)',
              borderBottom: `1px solid ${C.border}`,
              padding: '12px 16px',
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              {onBack && (
                <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px 6px 6px 0', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                  <ChevronLeft style={{ width: 20, height: 20, color: C.textHi }} />
                </button>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <h1 style={{ fontSize: 15, fontWeight: 700, color: C.textHi, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }}>
                  {activeRequest.issue_type ?? activeRequest.service_type ?? 'Active Job'}
                </h1>
                <p style={{ fontSize: 11, color: C.textMuted, marginTop: 1 }}>{shortId}</p>
              </div>
              {/* Simple pill badge matching driver app */}
              <span style={{
                padding: '4px 12px', borderRadius: 9999,
                fontSize: 11, fontWeight: 700, flexShrink: 0,
                background: jobBadge.color + '22',
                color: jobBadge.color,
                border: `1px solid ${jobBadge.color}50`,
              }}>
                {jobBadge.label}
              </span>
            </div>
          )
        })()}

        {/* Content cards — map is the first card so it shares the same padding/alignment */}
        <div style={{ padding: '16px 16px 100px' }}>

        {/* Map — shown only during the travel phase (accepted → en route → arrived).
            Once service starts it closes (matching the driver app), leaving just the
            progress card + job details. */}
        {['accepted', 'en_route', 'arrived'].includes(status) && (() => {
          const mapCardStyle: React.CSSProperties = {
            height: 320, borderRadius: 16, overflow: 'hidden',
            border: `1px solid ${C.border}`,
            marginBottom: 12,
            position: 'relative',
          }

          if (loadError || mapTimedOut) return (
            <div style={{ ...mapCardStyle, background: C.surface2, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '0 24px' }}>
              <MapPin style={{ width: 36, height: 36, color: C.amber, opacity: 0.8 }} />
              <p style={{ fontSize: 13, color: C.textMuted, textAlign: 'center', lineHeight: 1.5 }}>{locationText}</p>
              {reqDriver && (
                <a
                  href={`https://www.google.com/maps/dir/?api=1&destination=${reqDriver.lat},${reqDriver.lng}`}
                  target="_blank" rel="noreferrer"
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 18px', borderRadius: 20, background: C.amber, color: '#000', fontSize: 12, fontWeight: 700, textDecoration: 'none' }}
                >
                  <Navigation2 style={{ width: 13, height: 13 }} /> Open in Maps
                </a>
              )}
            </div>
          )

          if (!isLoaded) return (
            <div style={{ ...mapCardStyle, background: C.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ color: C.textFaint, fontSize: 13 }}>Loading map…</span>
            </div>
          )

          // Monotonic ETA + distance from the shared simulation (no flicker).
          const etaText  = enRoute && sim.etaMinutes != null
            ? (sim.etaMinutes <= 0 ? 'Arriving' : `${sim.etaMinutes} min`)
            : null
          const distText = enRoute && sim.distanceKm != null
            ? (sim.distanceKm >= 1 ? `${sim.distanceKm.toFixed(1)} km` : `${Math.round(sim.distanceKm * 1000)} m`)
            : null
          // Shared arrival window — identical to what the driver sees
          const arrivalText = enRoute
            ? arrivalWindow((activeRequest as any).en_route_at, (activeRequest as any).eta_minutes)
            : null
          const amberGrad: React.CSSProperties = {
            background: 'linear-gradient(135deg, #FBBF24, #F59E0B)',
            WebkitBackgroundClip: 'text', backgroundClip: 'text',
            WebkitTextFillColor: 'transparent', color: '#F59E0B',
          }
          const etaNum = etaText && etaText !== 'Arriving' ? etaText.replace(/\D+$/, '').trim() : null

          return (
            <>
              {/* Arrival loader strip — ABOVE the map (mirrors the driver app); the
                  time range sits just under the big ETA, never on the map itself. */}
              {enRoute && (
                <div style={{ padding: '2px 2px 12px' }}>
                  <p style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.14em', color: C.textFaint, marginBottom: 3 }}>Arriving in</p>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: arrivalText ? 4 : 10 }}>
                    {etaNum ? (
                      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
                        <span style={{ ...amberGrad, fontSize: 44, fontWeight: 900, lineHeight: 0.95, letterSpacing: '-0.03em' }}>{etaNum}</span>
                        <span style={{ ...amberGrad, fontSize: 18, fontWeight: 800 }}>min</span>
                      </span>
                    ) : (
                      <span style={{ ...amberGrad, fontSize: 34, fontWeight: 900, lineHeight: 1 }}>{etaText ?? 'Estimating…'}</span>
                    )}
                    {distText && <span style={{ fontSize: 13, fontWeight: 700, color: C.textMuted }}>· {distText} away</span>}
                  </div>
                  {arrivalText && (
                    <p style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 10 }}>
                      Between <span style={{ color: '#F59E0B', fontWeight: 800 }}>{arrivalText}</span>
                    </p>
                  )}
                  <div style={{ height: 8, borderRadius: 999, background: C.surface3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.round(Math.max(0, Math.min(1, sim.progress ?? 0)) * 100)}%`, background: 'linear-gradient(90deg, #F59E0B, #FBBF24)', borderRadius: 999, transition: 'width 1.2s linear' }} />
                  </div>
                </div>
              )}
              {/* Same map component the driver sees — identical pins + shrinking route.
                  Anchored to the driver's pinned location (reqDriver). */}
              <div style={{ marginBottom: 12 }}>
                <TrackingMap
                  driverLat={reqDriver?.lat ?? null}
                  driverLng={reqDriver?.lng ?? null}
                  arrived={activeRequest.status === 'arrived'}
                  assigned={['accepted', 'en_route'].includes(activeRequest.status)}
                  simActive={enRoute}
                  requestId={activeRequest.id}
                  enRouteAt={(activeRequest as any).en_route_at}
                />
              </div>
            </>
          )
        })()}

          {/* Driver details card — matches driver app middle card layout */}
          <div style={{ marginBottom: 12, background: C.surface2, borderRadius: 20, border: `1px solid ${C.border}`, padding: 16 }}>

            {/* Driver name */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
              <User style={{ width: 20, height: 20, color: C.amber, flexShrink: 0, marginTop: 1 }} />
              <div>
                <p style={{ fontSize: 12, color: C.amber, fontWeight: 700, marginBottom: 2 }}>Driver</p>
                <p style={{ fontSize: 14, color: C.textHi }}>{activeRequest.driver_name ?? '—'}</p>
              </div>
            </div>

            {/* Location */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
              <MapPin style={{ width: 20, height: 20, color: C.amber, flexShrink: 0, marginTop: 1 }} />
              <div>
                <p style={{ fontSize: 12, color: C.amber, fontWeight: 700, marginBottom: 2 }}>Location</p>
                <p style={{ fontSize: 14, fontWeight: 500, color: C.textHi }}>{locationText}</p>
              </div>
            </div>

            {/* Description (summarised) + driver's photo + MOTOBOT verdict */}
            {activeRequest.description && (() => {
              const { main, aiNote } = splitDescription(activeRequest.description)
              return (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
                  <Wrench style={{ width: 20, height: 20, color: C.amber, flexShrink: 0, marginTop: 1 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 12, color: C.amber, fontWeight: 700, marginBottom: 2 }}>Description</p>
                    {main && <p style={{ fontSize: 14, color: C.textHi, whiteSpace: 'pre-wrap' }}>{main}</p>}
                    {driverPhotos.length > 0 && (
                      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', marginTop: 8 }}>
                        {driverPhotos.map((u, i) => (
                          <a key={i} href={u} target="_blank" rel="noreferrer" style={{ flexShrink: 0 }}>
                            <img src={u} alt="Reported damage" style={{ height: 110, borderRadius: 10, border: `1px solid ${C.border}`, objectFit: 'cover', display: 'block' }} />
                          </a>
                        ))}
                      </div>
                    )}
                    {MOTOBOT_ENABLED && aiNote && (
                      <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 10, background: `${C.amber}14`, border: `1px solid ${C.amber}33` }}>
                        <span style={{ fontSize: 11, fontWeight: 800, color: C.amber }}>🤖 MOTOBOT: </span>
                        <span style={{ fontSize: 12.5, color: C.textHi }}>{aiNote}</span>
                      </div>
                    )}
                  </div>
                </div>
              )
            })()}

            {/* Requested at */}
            {activeRequest.created_at && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <Clock style={{ width: 20, height: 20, color: C.amber, flexShrink: 0, marginTop: 1 }} />
                <div>
                  <p style={{ fontSize: 12, color: C.amber, fontWeight: 700, marginBottom: 2 }}>Requested at</p>
                  <p style={{ fontSize: 14, color: C.textHi }}>
                    {new Date(normTs(activeRequest.created_at)).toLocaleString('en-UG', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Kampala' })}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Progress card — Call/Chat/Navigate now ride beside the current step */}
          <div style={{ marginBottom: 12, background: C.surface2, borderRadius: 16, border: `1px solid ${C.border}`, padding: '14px 16px' }}>
            <StatusBar
              status={status}
              serviceDesc={serviceDesc}
              actions={{
                onCall: () => setShowCallSheet(true),
                onChat: () => { setChatUnread(0); navigate(`/chat/${activeRequest.id}`) },
                onNavigate: () => setMapExpanded(true),
                chatUnread,
              }}
            />
          </div>

          {/* AI diagnosis — only once the mechanic has actually started the service */}
          {MOTOBOT_ENABLED && status === 'service_started' && (
            <div style={{ marginBottom: 12 }}>
              <button
                onClick={() => setShowDiagnostic(true)}
                style={{
                  width: '100%', height: 48, borderRadius: 12, border: `1px solid ${C.amber}50`,
                  background: `${C.amber}12`, color: C.amber, fontWeight: 700, fontSize: 14,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                }}>
                <Stethoscope style={{ width: 16, height: 16 }} />
                Diagnose Vehicle with AI
              </button>
            </div>
          )}

          {/* Awaiting confirmation — mechanic initiated → waiting on the driver */}
          {isAwaitingConfirmation && mechanicInitiated && (
            <div style={{
              borderRadius: 16,
              background: 'rgba(167,139,250,0.10)',
              border: '1.5px solid rgba(167,139,250,0.35)',
              padding: '20px 18px',
              textAlign: 'center',
              marginTop: 4,
            }}>
              <div style={{ fontSize: 28, marginBottom: 10 }}>⏳</div>
              <p style={{ fontSize: 15, fontWeight: 800, color: '#A78BFA', marginBottom: 6 }}>
                Waiting for driver to confirm
              </p>
              <p style={{ fontSize: 12, color: C.textMuted, lineHeight: 1.55 }}>
                The driver has been notified that you marked the job as done. It auto-completes if there's no response within 30 minutes.
              </p>
            </div>
          )}

          {/* Awaiting confirmation — driver/system initiated → mechanic confirms */}
          {isAwaitingConfirmation && !mechanicInitiated && (
            <div style={{
              borderRadius: 16,
              background: 'rgba(34,197,94,0.10)',
              border: '1.5px solid rgba(34,197,94,0.35)',
              padding: '18px', marginTop: 4,
            }}>
              <p style={{ fontSize: 15, fontWeight: 800, color: C.green, marginBottom: 4, textAlign: 'center' }}>
                {completionBy === 'system' ? 'Is this job complete?' : 'The driver marked the job as done'}
              </p>
              <p style={{ fontSize: 12, color: C.textMuted, lineHeight: 1.55, textAlign: 'center', marginBottom: 14 }}>
                Confirm the work is complete to finalise the job and proceed to payment.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <button
                  onClick={() => updateStatus('completed')}
                  disabled={actionLoading}
                  style={{
                    width: '100%', height: 50, borderRadius: 14, border: 'none',
                    background: `linear-gradient(135deg, ${C.green}, #16A34A)`,
                    color: '#000', fontWeight: 800, fontSize: 15, cursor: 'pointer',
                  }}
                >
                  ✓ Yes, the job is complete
                </button>
                <button
                  onClick={() => updateStatus('service_started')}
                  disabled={actionLoading}
                  style={{
                    width: '100%', height: 46, borderRadius: 12,
                    background: 'var(--surface-2)', border: '1px solid var(--border-3)',
                    color: C.textMuted, fontWeight: 700, fontSize: 14, cursor: 'pointer',
                  }}
                >
                  No, not done yet
                </button>
              </div>
            </div>
          )}

          {/* Rate the driver */}
          {showRatingPrompt && (
            <div style={{
              borderRadius: 16,
              background: 'rgba(245,158,11,0.06)',
              border: '1.5px solid rgba(245,158,11,0.28)',
              padding: '16px',
              marginTop: 4,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Star style={{ width: 16, height: 16, color: C.amber }} />
                  <p style={{ fontSize: 13, fontWeight: 700, color: C.textHi }}>
                    Rate {activeRequest.driver_name?.split(' ')[0] ?? 'the driver'}
                  </p>
                </div>
                <button
                  onClick={() => setRatingDismissed(true)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textFaint, fontSize: 18, lineHeight: 1, padding: '2px 4px' }}
                >
                  ×
                </button>
              </div>

              {/* Star row */}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 12 }}>
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    onClick={() => setDriverRating(star)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}
                  >
                    <Star
                      style={{
                        width: 28, height: 28,
                        color: star <= driverRating ? C.amber : C.textFaint,
                        fill: star <= driverRating ? C.amber : 'transparent',
                        transition: 'color 0.15s, fill 0.15s',
                      }}
                    />
                  </button>
                ))}
              </div>

              <textarea
                placeholder="Optional comment…"
                value={driverComment}
                onChange={(e) => setDriverComment(e.target.value)}
                rows={2}
                style={{
                  width: '100%', borderRadius: 10,
                  background: C.inputBg,
                  border: `1px solid ${C.border}`,
                  color: C.textHi, fontSize: 12,
                  padding: '10px 12px', outline: 'none',
                  resize: 'none', marginBottom: 10,
                  boxSizing: 'border-box',
                }}
              />

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => setRatingDismissed(true)}
                  style={{
                    flex: 1, height: 38, borderRadius: 10,
                    border: `1px solid ${C.border}`,
                    background: 'transparent',
                    color: C.textMuted, fontSize: 13, fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Skip
                </button>
                <button
                  onClick={submitDriverReview}
                  disabled={driverRating === 0 || isSubmittingRating}
                  style={{
                    flex: 2, height: 38, borderRadius: 10, border: 'none',
                    background: driverRating > 0 ? `linear-gradient(135deg, ${C.amber}, ${C.amberDark})` : C.surface3,
                    color: driverRating > 0 ? '#000' : C.textFaint,
                    fontSize: 13, fontWeight: 700,
                    cursor: driverRating > 0 ? 'pointer' : 'not-allowed',
                  }}
                >
                  {isSubmittingRating ? '…' : 'Submit Rating'}
                </button>
              </div>
            </div>
          )}

          {/* (Driver's photo now shown inside the Description card above.) */}

          {/* Tow-to destination — driver specified their own garage */}
          {garageDest && (
            <div style={{ marginBottom: 12, padding: 14, borderRadius: 14, background: C.surface1, border: `1px solid ${C.border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <Navigation2 style={{ width: 15, height: 15, color: C.amber }} />
                <span style={{ fontSize: 12, fontWeight: 800, color: C.textHi, letterSpacing: '0.02em' }}>TOW TO THIS GARAGE</span>
              </div>
              <div style={{ fontSize: 14.5, fontWeight: 800, color: C.textHi }}>{garageDest.name}</div>
              {garageDest.area && <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 2 }}>📍 {garageDest.area}</div>}
              {garageDest.phone && <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 2 }}>📞 {garageDest.phone}</div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 11 }}>
                {garageDest.phone && (
                  <a href={`tel:${garageDest.phone.replace(/[\s\-()]/g, '')}`} style={{ flex: 1, textAlign: 'center', padding: '9px 0', borderRadius: 10, background: 'rgba(245,158,11,0.14)', border: `1px solid ${C.amber}55`, color: C.amber, textDecoration: 'none', fontSize: 12.5, fontWeight: 800 }}>Call garage</a>
                )}
                {garageDest.lat != null && (
                  <a href={`https://www.google.com/maps/dir/?api=1&destination=${garageDest.lat},${garageDest.lng}`} target="_blank" rel="noreferrer" style={{ flex: 1, textAlign: 'center', padding: '9px 0', borderRadius: 10, background: C.surface3, border: `1px solid ${C.border}`, color: C.textMuted, textDecoration: 'none', fontSize: 12.5, fontWeight: 800 }}>Directions</a>
                )}
              </div>
            </div>
          )}

          {/* Breakdown Rescue — resolve on-site as a repair or a tow */}
          {isRoadsideAssist && status === 'in_progress' && (
            <div style={{ marginBottom: 12, padding: 14, borderRadius: 14, background: 'rgba(251,146,60,0.10)', border: '1px solid rgba(251,146,60,0.35)' }}>
              <p style={{ fontSize: 12.5, fontWeight: 800, color: C.textHi, marginBottom: 4 }}>Breakdown outcome</p>
              <p style={{ fontSize: 11.5, color: C.textFaint, marginBottom: 10, lineHeight: 1.5 }}>Could you assist on site, or does it need a tow to a garage?</p>
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={() => { setBdOutcome('fixed'); sendMessage({ type: 'chat_message', service_request_id: String(activeRequest.id), message: '✅ On-site assist is done — the vehicle should be able to continue.', sender_id: 'system' }) }}
                  style={{ flex: 1, padding: '11px 0', borderRadius: 12, cursor: 'pointer', fontSize: 13, fontWeight: 800, border: bdOutcome === 'fixed' ? `2px solid ${C.green}` : '1px solid rgba(255,255,255,0.15)', background: bdOutcome === 'fixed' ? 'rgba(34,197,94,0.16)' : C.surface3, color: bdOutcome === 'fixed' ? C.green : C.textMuted }}>
                  🔧 Fixed on-site
                </button>
                <button
                  onClick={() => { setBdOutcome('towing'); sendMessage({ type: 'chat_message', service_request_id: String(activeRequest.id), message: '🚛 It needs a tow to a garage — I will recover the vehicle.', sender_id: 'system' }) }}
                  style={{ flex: 1, padding: '11px 0', borderRadius: 12, cursor: 'pointer', fontSize: 13, fontWeight: 800, border: bdOutcome === 'towing' ? `2px solid ${C.amber}` : '1px solid rgba(255,255,255,0.15)', background: bdOutcome === 'towing' ? 'rgba(251,146,60,0.18)' : C.surface3, color: bdOutcome === 'towing' ? C.amber : C.textMuted }}>
                  🚛 Needs towing
                </button>
              </div>
            </div>
          )}

          {/* Main status action */}
          {action && (
            <>
              {action.disabled && (
                <p style={{ fontSize: 12, color: C.amber, textAlign: 'center', marginBottom: 8, fontWeight: 600 }}>
                  Send a price quote to the driver before starting work
                </p>
              )}
              {needOutcome && !action.disabled && (
                <p style={{ fontSize: 12, color: C.amber, textAlign: 'center', marginBottom: 8, fontWeight: 600 }}>
                  Choose the outcome (fixed or towing) above before completing
                </p>
              )}
              <button
                onClick={() => {
                  if (action.next === 'awaiting_confirmation') { setShowCompletion(true); return; }
                  // Starting the journey → attach the compressed-demo ETA so both
                  // apps show the same arrival window, matching the SIM_MINUTES sim.
                  if (action.next === 'en_route') {
                    updateStatus('en_route', { eta_minutes: SIM_MINUTES })
                  } else {
                    updateStatus(action.next)
                  }
                }}
                disabled={actionLoading || !!action.disabled || needOutcome}
                style={{
                  width: '100%', height: 56, borderRadius: 14, border: 'none',
                  background: (action.disabled || needOutcome)
                    ? C.surface3
                    : `linear-gradient(135deg, ${C.amber}, ${C.amberDark})`,
                  color: (action.disabled || needOutcome) ? C.textFaint : '#000',
                  fontWeight: 800, fontSize: 16,
                  cursor: actionLoading || action.disabled ? 'not-allowed' : 'pointer',
                  marginTop: 4,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                }}>
                {actionLoading ? '…' : action.label}
              </button>
            </>
          )}

          {/* Cancel — only before the work has started. Opening this always shows
              the suspension warning. */}
          {['accepted', 'en_route', 'arrived'].includes(status) && (
            <button
              onClick={() => setCancelOpen(true)}
              style={{
                width: '100%', height: 44, borderRadius: 12, marginTop: 10,
                border: '1px solid rgba(239,68,68,0.4)', background: 'rgba(239,68,68,0.08)',
                color: '#EF4444', fontWeight: 700, fontSize: 13.5, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              }}>
              <Ban style={{ width: 15, height: 15 }} /> Cancel this job
            </button>
          )}
        </div>
      </div>

      {cancelOpen && activeRequest && (
        <CancelJobModal
          requestId={activeRequest.id}
          onClose={() => setCancelOpen(false)}
          onCancelled={handleCancelled}
        />
      )}

      {/* Call Options Sheet */}
      {showCallSheet && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 250 }}>
          <div
            style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)' }}
            onClick={() => setShowCallSheet(false)}
          />
          <div style={{
            position: 'absolute', bottom: 0, left: 0, right: 0,
            background: 'var(--surface-1)', borderRadius: '22px 22px 0 0',
            padding: '20px 20px 40px',
            animation: 'slideUp 0.28s ease',
          }}>
            <div style={{ width: 36, height: 4, borderRadius: 2, background: C.border, margin: '0 auto 22px' }} />
            <p style={{ fontSize: 17, fontWeight: 800, color: C.textHi, marginBottom: 2 }}>
              Contact {activeRequest.driver_name?.split(' ')[0] ?? 'Driver'}
            </p>
            <p style={{ fontSize: 12, color: C.textFaint, marginBottom: 22 }}>
              {activeRequest.driver_phone ?? 'Phone not available'}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* Phone call */}
              <a
                href={activeRequest.driver_phone ? `tel:${activeRequest.driver_phone}` : undefined}
                onClick={() => setShowCallSheet(false)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 14,
                  padding: '14px 16px', borderRadius: 14,
                  background: C.surface2, border: `1.5px solid ${C.amber}50`,
                  textDecoration: 'none',
                  opacity: activeRequest.driver_phone ? 1 : 0.5,
                  pointerEvents: activeRequest.driver_phone ? 'auto' : 'none',
                }}
              >
                <div style={{ width: 46, height: 46, borderRadius: 13, background: C.amber + '20', border: `1px solid ${C.amber}35`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Phone style={{ width: 20, height: 20, color: C.amber }} />
                </div>
                <div>
                  <p style={{ fontSize: 15, fontWeight: 700, color: C.textHi }}>Phone Call</p>
                  <p style={{ fontSize: 12, color: C.textFaint }}>Dial from your phone's dialer</p>
                </div>
              </a>

              {/* In-app voice call (coming soon) */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 14,
                padding: '14px 16px', borderRadius: 14,
                background: C.surface2, border: `1.5px solid ${C.blue}30`,
                opacity: 0.55,
              }}>
                <div style={{ width: 46, height: 46, borderRadius: 13, background: C.blue + '15', border: `1px solid ${C.blue}25`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Smartphone style={{ width: 20, height: 20, color: C.blue }} />
                </div>
                <div style={{ flex: 1 }}>
                  <p style={{ fontSize: 15, fontWeight: 700, color: C.textHi }}>In-App Voice Call</p>
                  <p style={{ fontSize: 12, color: C.textFaint }}>VoIP calling — voice over internet</p>
                </div>
                <div style={{ background: C.surface3, borderRadius: 8, padding: '3px 9px', flexShrink: 0 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: C.textFaint, letterSpacing: '0.05em' }}>SOON</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Payment-received confirmation — persistent, blurs the page until answered. */}
      {paymentReq && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 210, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ width: '100%', maxWidth: 380, borderRadius: 24, background: C.surface1, border: `1.5px solid ${C.amber}55`, boxShadow: '0 24px 80px rgba(0,0,0,0.7)', padding: '24px 20px', textAlign: 'center', animation: 'irm-pop-in 0.3s cubic-bezier(0.34,1.56,0.64,1)' }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', margin: '0 auto 14px', background: `${C.amber}1e`, border: `2px solid ${C.amber}55`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Wallet style={{ width: 26, height: 26, color: C.amber }} />
            </div>
            <h2 style={{ fontSize: 18, fontWeight: 900, color: C.textHi, marginBottom: 6 }}>Have you received the payment?</h2>
            <p style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.55, marginBottom: 4 }}>
              The driver completed a <strong style={{ color: C.textHi }}>{paymentReq.method === 'cash' ? 'cash' : 'Mobile Money'}</strong> payment.
            </p>
            <p style={{ fontSize: 26, fontWeight: 900, color: C.amber, letterSpacing: '-0.02em', marginBottom: 18 }}>UGX {paymentReq.amount.toLocaleString()}</p>
            <button
              onClick={() => {
                // Persist the payment so admin revenue/payments reflect it, then ack + complete.
                jobService.recordPayment(activeRequest.id, paymentReq.method === 'cash' ? 'cash' : 'momo').catch(() => {})
                sendMessage({ type: 'payment_ack', service_request_id: activeRequest.id, received: true })
                setPaymentReq(null)
                updateStatus('completed')
              }}
              style={{ width: '100%', height: 52, borderRadius: 15, border: 'none', cursor: 'pointer', background: 'linear-gradient(135deg, #22C55E, #16A34A)', color: '#fff', fontSize: 15, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, marginBottom: 10 }}>
              <CheckCircle2 style={{ width: 18, height: 18 }} /> Yes, I’ve received it
            </button>
            <button
              onClick={() => { sendMessage({ type: 'payment_ack', service_request_id: activeRequest.id, received: false }); setPaymentReq(null) }}
              style={{ width: '100%', height: 48, borderRadius: 14, cursor: 'pointer', background: C.surface3, border: `1px solid ${C.border}`, color: C.textMuted, fontSize: 14, fontWeight: 700 }}>
              No, not yet
            </button>
          </div>
        </div>
      )}

      {/* Completion modal */}
      {showCompletion && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div style={{ background: C.surface1, borderRadius: '20px 20px 0 0', padding: 24, width: '100%', maxWidth: 480, maxHeight: '90vh', overflowY: 'auto', animation: 'slideUp 0.3s ease' }}>
            <div style={{ width: 36, height: 4, borderRadius: 2, background: C.border, margin: '0 auto 20px' }} />
            <h2 style={{ fontSize: 20, fontWeight: 800, color: C.amber, textAlign: 'center', marginBottom: 6 }}>Service Provided</h2>
            <p style={{ fontSize: 13, color: C.textMuted, textAlign: 'center', marginBottom: 18, lineHeight: 1.5 }}>
              Tick what you did and set the charge. The driver pays only after they confirm the job is done.
            </p>

            {/* Tickable "what was fixed" — AI-suggested for this fault, no typing needed */}
            <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 8 }}>What did you fix?</label>
            {estimateLoading && !estimate ? (
              <p style={{ fontSize: 12.5, color: C.textFaint, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Sparkles style={{ width: 13, height: 13, color: C.amber }} /> Getting the common fixes for this fault…
              </p>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                {(estimate?.fix_options ?? []).map(opt => {
                  const on = selectedFixes.includes(opt)
                  return (
                    <button key={opt} type="button"
                      onClick={() => setSelectedFixes(s => on ? s.filter(x => x !== opt) : [...s, opt])}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 12, cursor: 'pointer',
                        fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
                        background: on ? 'rgba(34,197,94,0.16)' : C.surface2,
                        border: `1.5px solid ${on ? C.green : C.border}`,
                        color: on ? C.green : C.textMuted,
                      }}>
                      {on && <Check style={{ width: 13, height: 13 }} />} {opt}
                    </button>
                  )
                })}
              </div>
            )}
            <textarea placeholder="Anything else? (optional)" value={serviceNote} onChange={e => setServiceNote(e.target.value)}
              rows={2} style={{ width: '100%', borderRadius: 12, background: C.inputBg, border: `1px solid ${C.border}`, color: C.textHi, fontSize: 13, padding: '11px 14px', outline: 'none', resize: 'none', marginBottom: 16, boxSizing: 'border-box' }} />

            {/* AI fair-price estimate (transport boda + labour + parts) */}
            {estimate && (
              <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 14, padding: '12px 14px', marginBottom: 14 }}>
                <p style={{ fontSize: 11, fontWeight: 800, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Sparkles style={{ width: 12, height: 12, color: C.amber }} /> AI fair-price estimate
                </p>
                {[
                  { label: 'Transport (boda)', v: estimate.transport },
                  { label: 'Labour', v: estimate.labour },
                  ...(estimate.parts.max > 0 ? [{ label: 'Parts', v: estimate.parts }] : []),
                ].map(row => (
                  <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                    <span style={{ fontSize: 12.5, color: C.textMuted }}>{row.label}</span>
                    <span style={{ fontSize: 12.5, color: C.textHi, fontWeight: 600 }}>UGX {row.v.min.toLocaleString()}–{row.v.max.toLocaleString()}</span>
                  </div>
                ))}
                <div style={{ height: 1, background: C.border, margin: '8px 0' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 13, color: C.textHi, fontWeight: 800 }}>Typical total</span>
                  <span style={{ fontSize: 13, color: C.amber, fontWeight: 800 }}>UGX {estimate.total.min.toLocaleString()}–{estimate.total.max.toLocaleString()}</span>
                </div>
              </div>
            )}

            <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 8 }}>Final service charge (UGX):</label>
            <input type="number" placeholder="e.g. 50000" value={actualFee} onChange={e => setActualFee(e.target.value)}
              style={{ width: '100%', height: 52, borderRadius: 12, background: C.inputBg, border: `1px solid ${C.border}`, color: C.textHi, fontSize: 20, fontWeight: 700, padding: '0 16px', outline: 'none', marginBottom: 10, boxSizing: 'border-box' }} />

            {/* Real-time reasonableness vs the AI range */}
            {estimate && Number(actualFee) > 0 && (() => {
              const fee = Number(actualFee)
              const within = fee >= estimate.total.min && fee <= estimate.total.max
              const above  = fee > estimate.total.max
              const col = within ? C.green : above ? C.amber : C.blue
              const msg = within
                ? '✓ Within the fair range — looks reasonable.'
                : above
                ? `⚠ Above the typical UGX ${estimate.total.min.toLocaleString()}–${estimate.total.max.toLocaleString()}. The driver will see this.`
                : 'Below the typical range — make sure your costs are covered.'
              return <p style={{ fontSize: 12, color: col, fontWeight: 600, marginBottom: 14, lineHeight: 1.5 }}>{msg}</p>
            })()}

            <button onClick={() => updateStatus('awaiting_confirmation', { actual_fee: Number(actualFee), note: [...selectedFixes, serviceNote.trim()].filter(Boolean).join('; ') })} disabled={!actualFee || actionLoading}
              style={{ width: '100%', height: 48, borderRadius: 12, border: 'none', background: actualFee ? `linear-gradient(135deg, ${C.amber}, ${C.amberDark})` : C.surface3, color: actualFee ? '#000' : C.textFaint, fontWeight: 700, fontSize: 15, cursor: actualFee ? 'pointer' : 'not-allowed', marginBottom: 8 }}>
              {actionLoading ? '…' : 'Notify Driver – Job Done'}
            </button>
            <button onClick={() => setShowCompletion(false)}
              style={{ width: '100%', height: 44, borderRadius: 12, border: `1px solid ${C.border}`, background: 'transparent', color: C.textMuted, fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* AI Diagnostic Tool overlay */}
      {MOTOBOT_ENABLED && showDiagnostic && activeRequest && (
        <DiagnosticTool
          serviceType={activeRequest.issue_type ?? activeRequest.service_type ?? 'vehicle fault'}
          description={activeRequest.description ?? ''}
          onDiagnosisComplete={handleDiagnosisComplete}
          onClose={() => setShowDiagnostic(false)}
        />
      )}
    </>
  )
}
