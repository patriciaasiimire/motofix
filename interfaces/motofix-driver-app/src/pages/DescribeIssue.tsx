// DescribeIssue.tsx — the screen where the driver describes what's wrong before sending
// a request. They can type it, get a MOTOBOT cost estimate (repair vs replace) and an
// optional photo verdict, then submit. Admin-set catalog prices override the AI estimate
// (see withCatalogOverride below). Leads into dispatching a mechanic.

import { useState, useLayoutEffect, useEffect, useRef, useMemo } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { ArrowLeft, MapPin, Send, Sparkles } from 'lucide-react'
import { authService, requestsService, diagnosisService, partsService, type DiagnosisResult } from '@/config/api'
import { MOTOBOT_ENABLED } from '@/config/features'
import { useAuth } from '@/hooks/useAuth'

/* ── Admin catalog override ───────────────────────────────────────────────────
   The prices an admin sets in the Spare Parts → Price Catalog are authoritative:
   if an entry exists for this fault category, its parts + service-fee range REPLACE
   the AI's estimate before the driver sees it (same rule as PartsNeeded.tsx). ── */
async function withCatalogOverride(est: DiagnosisResult | null): Promise<DiagnosisResult | null> {
  if (!est?.fault_category) return est
  try {
    const { data: cat } = await partsService.getCatalog(est.fault_category)
    if (cat && (cat.parts?.length || cat.service_fee_min != null || cat.service_fee_max != null)) {
      return {
        ...est,
        required_parts: cat.parts?.length
          ? cat.parts.map(p => ({ name: p.name, price_min: p.price_min, price_max: p.price_max }))
          : est.required_parts,
        service_fee_min: cat.service_fee_min ?? est.service_fee_min,
        service_fee_max: cat.service_fee_max ?? est.service_fee_max,
      }
    }
  } catch { /* 404 → no admin override, keep the AI estimate */ }
  return est
}

/* ── Photo helpers — used to persist the uploaded photo across an iOS tab
   reload (sessionStorage can't hold a File, so we keep a compressed data URL)
   and to fingerprint a photo so re-uploading the SAME one can be detected. ── */
function fileToCompressedDataUrl(file: File, maxDim = 1024, quality = 0.7): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      let { width, height } = img
      if (Math.max(width, height) > maxDim) {
        const s = maxDim / Math.max(width, height)
        width = Math.round(width * s); height = Math.round(height * s)
      }
      const canvas = document.createElement('canvas')
      canvas.width = width; canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('no canvas context')); return }
      ctx.drawImage(img, 0, 0, width, height)
      resolve(canvas.toDataURL('image/jpeg', quality))
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')) }
    img.src = url
  })
}

function dataUrlToFile(dataUrl: string, name: string): File {
  const [head, b64] = dataUrl.split(',')
  const mime = /:(.*?);/.exec(head)?.[1] || 'image/jpeg'
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return new File([arr], name, { type: mime })
}

/** Content fingerprint of a photo (SHA-256 when available, else a sampled FNV-1a). */
async function hashFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  try {
    if (crypto?.subtle?.digest) {
      const d = await crypto.subtle.digest('SHA-256', buf)
      return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('')
    }
  } catch { /* fall through to the cheap hash */ }
  const bytes = new Uint8Array(buf)
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i += 997) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) }
  return `f${(h >>> 0).toString(16)}-${bytes.length}`
}

/* ── Palette ─────────────────────────────────────────────────────────────── */
const SOS   = '#ff2d2d'
const SOSD  = '#cc1515'
const AMBER = '#F59E0B'
const AMBRD = '#D97706'

/* ── Issue lookup maps ───────────────────────────────────────────────────── */
const ISSUE_LABELS: Record<string, string> = {
  flat_tire: 'Flat Tyre',
  engine:    'Engine Fault',
  battery:   'Dead Battery',
  fuel:      'Out of Fuel',
  towing:    'Tow / recovery',
  breakdown: 'Roadside assist or tow',
  other:     'Other Issue',
}

const ISSUE_DEFAULTS: Record<string, string> = {
  flat_tire: 'Flat tyre – needs roadside assistance',
  engine:    'Engine issue – needs mechanic',
  battery:   'Battery problem – needs jump start or replacement',
  fuel:      'Out of fuel – needs fuel delivery',
  towing:    'Vehicle needs tow / recovery to a garage or safer place',
  breakdown: 'Vehicle needs roadside triage; if it is unsafe or too complex to fix, request a tow to a garage',
  other:     'Needs roadside assistance',
}

/* ── Route state ─────────────────────────────────────────────────────────── */
interface RouteState {
  issueType?:   string
  serviceType?: string
  breakdownPrefs?: { fixOnSpot: boolean; allowTow: boolean }
  aiSummary?:   string
  aiDiagnosis?: { severity?: string; fault_category?: string; provider_type?: string } | null
  reRequestServiceType?: string
  reRequestDescription?: string
  reRequestId?: string
  lat?:         number
  lng?:         number
  accuracy?:    number
  address?:     string
}

/* ── Dispatch overlay phases ─────────────────────────────────────────────── */
type DispatchPhase = 'idle' | 'finding_garage' | 'searching' | 'found' | 'dispatched'

const DISPATCH_MSGS: Record<Exclude<DispatchPhase, 'idle'>, { title: string; sub: string }> = {
  finding_garage: { title: 'Finding Tow Destination', sub: 'Locating the garage you specified…' },
  searching:  { title: 'Searching Nearby',   sub: 'Finding available service providers in your area…' },
  found:      { title: 'Providers Found!',   sub: 'Alerting nearby verified providers…' },
  dispatched: { title: 'Request Dispatched!', sub: 'A provider will confirm shortly. Stand by.' },
}

/* ─────────────────────────────────────────────────────────────────────────── */
/*  Dispatch animation overlay                                                 */
/* ─────────────────────────────────────────────────────────────────────────── */
function DispatchOverlay({ phase, issueType }: { phase: Exclude<DispatchPhase, 'idle'>; issueType?: string }) {
  const isDispatched = phase === 'dispatched'
  const msg = DISPATCH_MSGS[phase]

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(0,0,0,0.90)',
      backdropFilter: 'blur(24px)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      gap: 28, padding: 32,
      animation: 'di-fade-in 0.4s ease both',
    }}>

      {/* Radar / checkmark graphic */}
      <div style={{ position: 'relative', width: 130, height: 130 }}>

        {!isDispatched ? (
          <>
            {/* Expanding rings */}
            {[130, 96, 62].map((size, i) => (
              <div key={size} style={{
                position: 'absolute', top: '50%', left: '50%',
                width: size, height: size, borderRadius: '50%',
                border: `1.5px solid ${AMBER}${['20', '38', '60'][i]}`,
                transform: 'translate(-50%,-50%)',
                animation: `di-ring ${2 + i * 0.45}s ease-out ${i * 0.4}s infinite`,
              }} />
            ))}

            {/* Rotating sweep line */}
            <div style={{ position: 'absolute', inset: 0, animation: 'di-spin 2s linear infinite' }}>
              <svg width="130" height="130" viewBox="0 0 130 130" fill="none">
                <defs>
                  <linearGradient id="radarG" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={AMBER} stopOpacity="0" />
                    <stop offset="100%" stopColor={AMBER} stopOpacity="0.85" />
                  </linearGradient>
                </defs>
                {/* Sweep wedge */}
                <path
                  d={`M65 65 L65 8 A57 57 0 0 1 ${65 + 57 * Math.sin(Math.PI / 6)} ${65 - 57 * Math.cos(Math.PI / 6)} Z`}
                  fill={`${AMBER}18`}
                />
                <line x1="65" y1="65" x2="65" y2="8" stroke={`url(#radarG)`} strokeWidth="2" strokeLinecap="round" />
              </svg>
            </div>

            {/* Centre dot */}
            <div style={{
              position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
              width: 22, height: 22, borderRadius: '50%',
              background: AMBER,
              boxShadow: `0 0 0 4px ${AMBER}40, 0 0 20px ${AMBER}cc`,
              animation: 'di-pulse 1.4s ease-in-out infinite',
            }} />
          </>
        ) : (
          /* Checkmark when dispatched */
          <svg width="130" height="130" viewBox="0 0 130 130" fill="none">
            <circle cx="65" cy="65" r="58" stroke={`${AMBER}25`} strokeWidth="2" />
            <circle cx="65" cy="65" r="58"
              stroke={AMBER} strokeWidth="2.5" strokeLinecap="round"
              strokeDasharray="364" strokeDashoffset="364"
              transform="rotate(-90 65 65)"
              style={{ animation: 'di-draw-circle 0.7s cubic-bezier(0.4,0,0.2,1) forwards', filter: `drop-shadow(0 0 10px ${AMBER})` }} />
            <path d="M40 65 L56 81 L90 47"
              stroke={AMBER} strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round"
              strokeDasharray="80" strokeDashoffset="80"
              style={{ animation: 'di-draw-check 0.5s ease 0.65s forwards', filter: `drop-shadow(0 0 8px ${AMBER})` }} />
          </svg>
        )}
      </div>

      {/* Text */}
      <div style={{ textAlign: 'center', animation: 'di-slide-up 0.4s ease both' }}>
        <h2 style={{ color: '#fff', fontWeight: 900, fontSize: 24, marginBottom: 10, letterSpacing: '-0.02em' }}>
          {msg.title}
        </h2>
        <p style={{ color: 'rgba(255,255,255,0.58)', fontSize: 14, lineHeight: 1.6, maxWidth: 260 }}>
          {msg.sub}
        </p>
      </div>

      {/* Progress pills */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {(['searching', 'found', 'dispatched'] as const).map((p, i) => {
          const phaseOrder = ['searching', 'found', 'dispatched']
          const done = phaseOrder.indexOf(phase) >= i
          return (
            <div key={p} style={{
              width: done ? 28 : 8, height: 8, borderRadius: 4,
              background: done ? AMBER : 'rgba(255,255,255,0.18)',
              transition: 'all 0.35s ease',
            }} />
          )
        })}
      </div>

      {/* Monospace tag */}
      <p style={{ color: 'rgba(255,255,255,0.28)', fontSize: 11, fontFamily: 'monospace', letterSpacing: '0.12em' }}>
        {issueType ? `ISSUE: ${ISSUE_LABELS[issueType]?.toUpperCase() ?? 'OTHER'}` : 'REQUEST PROCESSING'}
      </p>

      <style>{`
        @keyframes di-fade-in       { from { opacity: 0; } to { opacity: 1; } }
        @keyframes di-slide-up      { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes di-spin          { to   { transform: rotate(360deg); } }
        @keyframes di-pulse         { 0%,100% { transform: translate(-50%,-50%) scale(1); } 50% { transform: translate(-50%,-50%) scale(1.2); } }
        @keyframes di-ring          { 0% { transform: translate(-50%,-50%) scale(0.7); opacity: 0.9; } 100% { transform: translate(-50%,-50%) scale(2.2); opacity: 0; } }
        @keyframes di-draw-circle   { to { stroke-dashoffset: 0; } }
        @keyframes di-draw-check    { to { stroke-dashoffset: 0; } }
      `}</style>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────────────── */
/*  Main page                                                                  */
/* ─────────────────────────────────────────────────────────────────────────── */
function getComp(components: any[], type: string): string | null {
  return components.find((c: any) => c.types.includes(type))?.long_name ?? null
}

async function reverseGeocode(lat: number, lng: number): Promise<string> {
  const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY
  if (!key) return `${lat.toFixed(4)}, ${lng.toFixed(4)}`
  try {
    const r = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${key}`
    )
    const d = await r.json()
    if (d.status !== 'OK' || !d.results?.length) return `${lat.toFixed(4)}, ${lng.toFixed(4)}`

    // Filter out any result that embeds phone numbers in its address text
    const results: any[] = d.results.filter((r: any) => !/\d{8,}/.test(r.formatted_address ?? ''))
    if (!results.length) return `${lat.toFixed(4)}, ${lng.toFixed(4)}`

    // Build a short "Area, City" label from address components
    let route = null, sub2 = null, neighborhood = null, sub1 = null, locality = null
    for (const result of results) {
      const c = result.address_components
      route        = route        || getComp(c, 'route')
      sub2         = sub2         || getComp(c, 'sublocality_level_2')
      neighborhood = neighborhood || getComp(c, 'neighborhood')
      sub1         = sub1         || getComp(c, 'sublocality_level_1')
      locality     = locality     || getComp(c, 'locality')
    }
    const area = sub2 || neighborhood || sub1
    // Strip trailing numeric road codes Google assigns in Uganda (e.g. "Kabowa 14782" → "Kabowa")
    const cleanRoute = route ? route.replace(/\s+\d+$/, '').trim() : null
    if (cleanRoute && area)     return `${cleanRoute}, ${area}`
    if (cleanRoute && locality) return `${cleanRoute}, ${locality}`
    if (area && locality)  return `${area}, ${locality}`
    return area || locality || `${lat.toFixed(4)}, ${lng.toFixed(4)}`
  } catch {
    return `${lat.toFixed(4)}, ${lng.toFixed(4)}`
  }
}

export default function DescribeIssue() {
  const navigate    = useNavigate()
  const routeState  = useLocation().state as RouteState | null
  const { user }    = useAuth()

  const issueType  = routeState?.issueType
  const breakdownPrefs = routeState?.breakdownPrefs

  const aiSummary  = routeState?.aiSummary
  const lat        = routeState?.lat
  const lng        = routeState?.lng
  const accuracy   = routeState?.accuracy   // metres; undefined = fallback / unknown
  const isApprox   = accuracy == null || accuracy > 500

  // Draft persistence — iOS Safari evicts/reloads backgrounded tabs (memory pressure),
  // which wipes in-memory React state. Persist the in-progress request to sessionStorage
  // (survives the tab reload) and restore it on mount so nothing typed is lost.
  const DRAFT_KEY = `motofix_describe_draft_${issueType ?? 'general'}_${routeState?.reRequestId ?? 'new'}`
  const PHOTO_KEY = `${DRAFT_KEY}_photo`
  const draft0 = (() => { try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || '{}') } catch { return {} } })() as Partial<{ description: string; towChoice: 'find' | 'own'; garageName: string; garageArea: string; garagePhone: string }>
  // Photo + its analysis persisted alongside the text draft (separate key — it's large).
  // Parse once (the data URL is sizeable; re-parsing every render would lag typing).
  const savedPhoto = useMemo(() => {
    try { return JSON.parse(sessionStorage.getItem(PHOTO_KEY) || 'null') as { dataUrl: string; estimate: DiagnosisResult; hash: string } | null } catch { return null }
  }, [PHOTO_KEY])

  const [description,    setDescription]    = useState(draft0.description ?? routeState?.reRequestDescription ?? '')
  const [dispatchPhase,  setDispatchPhase]  = useState<DispatchPhase>('idle')
  const [submitError,    setSubmitError]    = useState('')
  const [towChoice,      setTowChoice]      = useState<'find' | 'own'>(draft0.towChoice ?? 'find')
  const [garageName,     setGarageName]     = useState(draft0.garageName ?? '')
  const [garageArea,     setGarageArea]     = useState(draft0.garageArea ?? '')
  const [garagePhone,    setGaragePhone]    = useState(draft0.garagePhone ?? '')
  const [estimate,        setEstimate]        = useState<DiagnosisResult | null>(savedPhoto?.estimate ?? null)
  const [estimateLoading, setEstimateLoading] = useState(!savedPhoto)
  const [photoChecked,    setPhotoChecked]    = useState(!!savedPhoto)
  const [photoChecking,   setPhotoChecking]   = useState(false)
  const [photoFile,       setPhotoFile]       = useState<File | null>(() => savedPhoto ? dataUrlToFile(savedPhoto.dataUrl, 'damage.jpg') : null)
  const [photoError,      setPhotoError]      = useState('')
  const [samePhoto,       setSamePhoto]       = useState(false)
  const [betterPhotoHint, setBetterPhotoHint] = useState('')
  const [photoMismatch,   setPhotoMismatch]   = useState('')  // photo doesn't match the reported issue → flag, hide price
  const lastPhotoHashRef = useRef<string | null>(savedPhoto?.hash ?? null)
  const [displayAddress, setDisplayAddress] = useState<string | null>(null)
  const [preferredMechanicId, setPreferredMechanicId] = useState<number | undefined>()

  const towRecommended = routeState?.aiDiagnosis?.provider_type === 'towing_provider'
    || estimate?.provider_type === 'towing_provider'
    || ['high', 'critical'].includes(String(routeState?.aiDiagnosis?.severity ?? estimate?.severity ?? '').toLowerCase())
  const showTowDest = issueType === 'breakdown' && ((breakdownPrefs?.allowTow ?? true) || towRecommended)
  const requestedTow = routeState?.reRequestServiceType
    ? /tow|recovery/i.test(routeState.reRequestServiceType)
    : issueType === 'towing'
      || (issueType === 'breakdown' && (
        (breakdownPrefs?.fixOnSpot === false)
        || (showTowDest && towChoice === 'own')
        || (towRecommended && breakdownPrefs?.allowTow !== false)
      ))
  const jobTypeLabel = routeState?.reRequestServiceType
    ? (requestedTow ? 'Tow / recovery' : 'Roadside assist')
    : requestedTow ? 'Tow / recovery' : 'Roadside assist'

  useEffect(() => {
    authService.getPreferences()
      .then(({ data }) => {
        const savedId = Number(data?.preferences?.preferred_mechanic_id)
        if (Number.isSafeInteger(savedId) && savedId > 0) setPreferredMechanicId(savedId)
      })
      .catch(() => {})
  }, [])

  const fmtUGX = (n: number) => 'UGX ' + Math.round(n).toLocaleString()
  const rng = (a: number, b: number) => (a === b ? fmtUGX(a) : `${fmtUGX(a)} – ${fmtUGX(b)}`)

  // Save the draft on every change so a backgrounded-tab reload (iOS) can restore it.
  useEffect(() => {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ description, towChoice, garageName, garageArea, garagePhone })) } catch { /* storage full — ignore */ }
  }, [DRAFT_KEY, description, towChoice, garageName, garageArea, garagePhone])

  // Transparent MOTOBOT cost estimate — fetched once when the screen opens.
  // Skip if we restored a photo-based analysis (it's more accurate than the text one).
  useEffect(() => {
    if (!MOTOBOT_ENABLED || savedPhoto) {
      setEstimateLoading(false)
      return
    }
    let cancelled = false
    const seed = (aiSummary && aiSummary.trim())
      || routeState?.reRequestDescription?.trim()
      || `${ISSUE_LABELS[issueType ?? ''] ?? 'Vehicle issue'} — ${ISSUE_DEFAULTS[issueType ?? ''] ?? 'needs roadside assistance'}`
    setEstimateLoading(true)
    diagnosisService.diagnoseText(seed)
      .then(async r => { const merged = await withCatalogOverride(r.data); if (!cancelled) setEstimate(merged) })
      .catch(() => { if (!cancelled) setEstimate(null) })
      .finally(() => { if (!cancelled) setEstimateLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Driver photographs the damage → MOTOBOT re-checks repairable-vs-replace from the image.
  const handlePhoto = async (file: File) => {
    if (!MOTOBOT_ENABLED) {
      setPhotoFile(file)
      setPhotoError('')
      return
    }
    setPhotoError('')
    setPhotoChecking(true)
    // Is this the exact same photo as the last one we analysed? (fingerprint match)
    let isSame = false
    try {
      const hash = await hashFile(file)
      isSame = !!lastPhotoHashRef.current && hash === lastPhotoHashRef.current
      lastPhotoHashRef.current = hash
    } catch { /* hashing unavailable — treat as a new photo */ }
    const issueLabel = ISSUE_LABELS[issueType ?? ''] || (aiSummary?.trim()) || 'the reported problem'
    try {
      const r = await diagnosisService.diagnoseImage(file, issueLabel)
      if (r.data.image_relevant === false) {
        // Photo isn't a vehicle, or doesn't match the reported issue → flag it and show
        // NO price/recommendation. Drop the photo so an off-topic image isn't submitted.
        setPhotoMismatch(r.data.image_feedback || `That photo doesn’t match your ${issueLabel}. Please upload a clear photo of the actual problem.`)
        setPhotoChecked(false)
        setPhotoFile(null)
        setSamePhoto(false)
        setBetterPhotoHint('')
        try { sessionStorage.removeItem(PHOTO_KEY) } catch { /* ignore */ }
      } else {
        const merged = (await withCatalogOverride(r.data)) ?? r.data  // admin prices win
        setPhotoMismatch('')  // clear any prior mismatch — this photo is on-topic
        setEstimate(merged)
        setPhotoChecked(true)
        setPhotoFile(file)
        setSamePhoto(isSame)  // still analysed; we just tell the driver it's a repeat
        // Right subject but too unclear to read → nudge for another angle (still keep this one).
        setBetterPhotoHint(r.data.needs_better_photo ? (r.data.image_feedback || 'This photo is a bit unclear — please add another shot from a different angle, closer and in good light, for a sharper read.') : '')
        // Persist the photo + its analysis so an iOS tab reload can restore them.
        try {
          const dataUrl = await fileToCompressedDataUrl(file)
          sessionStorage.setItem(PHOTO_KEY, JSON.stringify({ dataUrl, estimate: merged, hash: lastPhotoHashRef.current }))
        } catch { /* quota / canvas issue — skip persistence, analysis still shows */ }
      }
    } catch {
      setPhotoError('Couldn’t check that photo — please try another one.')
    } finally {
      setPhotoChecking(false)
    }
  }
  const photoVerdict = (() => {
    if (!MOTOBOT_ENABLED || !photoChecked || !estimate) return null
    // Prefer MOTOBOT's decisive call from the photo; fall back to a heuristic if absent.
    const rec = (estimate.repair_or_replace || '').toLowerCase()
    const reason = estimate.repair_or_replace_reason?.trim()
    if (rec === 'repair')  return { tone: 'good' as const,  rec: 'repair' as const,  text: reason || 'Looks repairable — a fix should hold, so you likely do NOT need to buy a new part.' }
    if (rec === 'replace') return { tone: 'warn' as const,  rec: 'replace' as const, text: reason || 'The damage is too deep for a lasting fix — a new part is genuinely needed.' }
    if (rec === 'inspect') return { tone: 'mixed' as const, rec: 'inspect' as const, text: reason || 'Could go either way — ask the mechanic to physically show you the damage.' }
    // Fallback heuristic (older diagnoses without an explicit verdict).
    const rMax = estimate.repair_fee_max ?? 0
    const hasParts = (estimate.required_parts ?? []).length > 0
    const severe = ['high', 'critical'].includes((estimate.severity || '').toLowerCase())
    if (rMax > 0 && !severe) return { tone: 'good' as const,  rec: 'repair' as const,  text: 'Looks repairable — you likely do NOT need to buy a new part.' }
    if (hasParts && (rMax === 0 || severe)) return { tone: 'warn' as const, rec: 'replace' as const, text: 'The damage looks serious — a new part is likely genuinely needed.' }
    return { tone: 'mixed' as const, rec: 'inspect' as const, text: 'Could go either way — ask the mechanic to physically show you the damage.' }
  })()

  useLayoutEffect(() => {
    document.body.style.background = 'var(--page-bg)'
    return () => { document.body.style.background = '' }
  }, [])

  // Geocode actual GPS coords on mount — ignore any address string from route state
  useLayoutEffect(() => {
    if (lat == null || lng == null) return
    setDisplayAddress('Locating…')
    reverseGeocode(lat, lng).then(setDisplayAddress)
  }, [lat, lng])

  /* Forward-geocode a garage name + area → coords (so it's viewable on the map). */
  const geocodeArea = async (q: string): Promise<{ lat: number; lng: number } | null> => {
    const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY
    if (!key || !q.trim()) return null
    try {
      const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q + ', Uganda')}&key=${key}`)
      const d = await r.json()
      const loc = d.results?.[0]?.geometry?.location
      if (loc) return { lat: loc.lat, lng: loc.lng }
    } catch { /* fall through to simulated */ }
    return null
  }

  const handleSubmit = async (customDesc?: string) => {
    if (dispatchPhase !== 'idle') return
    setSubmitError('')
    const specified = showTowDest && towChoice === 'own'
    if (specified && !(garageName.trim() && garageArea.trim() && garagePhone.trim())) {
      setSubmitError('Please enter the garage name, area, and phone number.')
      return
    }

    // Specified garage → rescan to "find" it first (simulated — always found).
    let garageCoords: { lat: number; lng: number } | null = null
    if (specified) {
      setDispatchPhase('finding_garage')
      garageCoords =
        (await geocodeArea(`${garageName.trim()}, ${garageArea.trim()}`)) ??
        (lat != null && lng != null ? { lat: lat + 0.012, lng: lng + 0.012 } : null)
      await new Promise(r => setTimeout(r, 2400))
    }

    setDispatchPhase('searching')

    /* Staggered dispatch messages */
    const t1 = setTimeout(() => setDispatchPhase('found'),      2000)
    const t2 = setTimeout(() => setDispatchPhase('dispatched'), 3600)

    try {
      const notes = (customDesc ?? description).trim()
      let finalDescription: string
      if (issueType === 'breakdown') {
        const fix = breakdownPrefs?.fixOnSpot ?? true
        const tow = breakdownPrefs?.allowTow ?? true
        const headline = requestedTow
          ? specified
            ? 'Tow / recovery — take the vehicle to the specified garage.'
            : 'Tow / recovery — take the vehicle to a garage or safer place.'
          : !tow
            ? 'Roadside assist — first aid and triage only; no tow requested.'
            : 'Roadside assist — attempt a safe minor fix. If it needs a garage, request Tow / recovery in MOTOFIX.'
        const parts = [headline]
        if (specified) {
          parts.push(`Tow to garage:\n• Name: ${garageName.trim()}\n• Area: ${garageArea.trim()}\n• Phone: ${garagePhone.trim()}${garageCoords ? `\n• Map: ${garageCoords.lat.toFixed(5)},${garageCoords.lng.toFixed(5)}` : ''}`)
        }
        if (notes) parts.push(`Notes: ${notes}`)
        finalDescription = parts.join('\n\n')
      } else {
        finalDescription = aiSummary
          ? aiSummary + (notes ? `\n\nAdditional notes from driver: ${notes}` : '')
          : (notes || ISSUE_DEFAULTS[issueType ?? ''] || 'Needs roadside assistance')
      }
      // Attach MOTOBOT's photo verdict to the request so the mechanic sees it before quoting.
      if (photoChecked && photoVerdict) {
        finalDescription += `\n\nMOTOBOT photo check: ${photoVerdict.text}${estimate?.fault_description ? ` (${estimate.fault_description})` : ''}`
      }
      const svcType = jobTypeLabel
      const loc = lat != null && lng != null ? `${lat},${lng}` : '0,0'
      const preferredField = preferredMechanicId ? { preferred_mechanic_id: preferredMechanicId } : {}
      let newId = ''
      if (photoFile) {
        // Send the damage photo with the request (mechanic can view it before quoting).
        const fd = new FormData()
        fd.append('customer_name', user?.full_name || 'Driver')
        fd.append('service_type', svcType)
        fd.append('location', loc)
        fd.append('description', finalDescription)
        if (preferredMechanicId) fd.append('preferred_mechanic_id', String(preferredMechanicId))
        fd.append('media_files', photoFile)
        const res = await requestsService.createWithMedia(fd)
        newId = String(res.data?.id ?? '')
      } else {
        const res = await requestsService.create({
          customer_name: user?.full_name || 'Driver',
          service_type:  svcType,
          location:      loc,
          description:   finalDescription,
          ...preferredField,
        })
        newId = String(res.data?.id ?? '')
      }
      try { sessionStorage.removeItem(DRAFT_KEY); sessionStorage.removeItem(PHOTO_KEY) } catch { /* ignore */ }
      setTimeout(() => {
        clearTimeout(t1); clearTimeout(t2)
        navigate(newId ? `/requests/${newId}` : '/requests', { replace: true })
      }, 4800)
    } catch (err) {
      clearTimeout(t1); clearTimeout(t2)
      setDispatchPhase('idle')
      const e = err as { response?: { status?: number; data?: { detail?: unknown } } }
      const status = e?.response?.status
      const d = e?.response?.data?.detail
      const detail = typeof d === 'string' ? d : ''
      setSubmitError(
        status === 401 || status === 403
          ? 'Your session has expired — please log out and back in, then try again.'
          : status
            ? `Couldn't submit your request (server error ${status}${detail ? `: ${detail}` : ''}). Please try again.`
            : 'Can’t reach the server. Check your connection and that the MOTOFIX app server is running, then try again.',
      )
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 50,
      display: 'flex', flexDirection: 'column',
      background: 'var(--page-bg)', overflow: 'hidden',
    }}>

      {/* Ambient glows */}
      <div style={{ position: 'absolute', top: -60, left: '50%', transform: 'translateX(-50%)', width: 340, height: 340, borderRadius: '50%', background: `${SOS}08`, filter: 'blur(90px)', pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', bottom: -50, right: -40, width: 280, height: 280, borderRadius: '50%', background: `${AMBER}0a`, filter: 'blur(80px)', pointerEvents: 'none' }} />

      {/* ── Header ── */}
      <div style={{
        paddingTop: 'max(env(safe-area-inset-top, 0px), 16px)',
        paddingBottom: 12, paddingLeft: 16, paddingRight: 16,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0, position: 'relative', zIndex: 1,
      }}>
        <button
          onClick={() => navigate(-1)}
          style={{ width: 38, height: 38, borderRadius: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface-3)', border: '1px solid var(--border-3)', cursor: 'pointer' }}
        >
          <ArrowLeft style={{ width: 17, height: 17, color: 'var(--text-md)' }} />
        </button>
        <span style={{ color: AMBER, fontSize: 13, fontWeight: 900, letterSpacing: '0.12em', textShadow: `0 0 20px ${AMBER}55` }}>
          MOTOFIX
        </span>
        <div style={{ width: 38 }} />
      </div>

      {/* ── SOS status banner ── */}
      <div style={{
        marginLeft: 14, marginRight: 14, marginBottom: 14,
        borderRadius: 14,
        background: `linear-gradient(135deg, ${SOS}18 0%, rgba(10,10,18,0.85) 100%)`,
        border: `1.5px solid ${SOS}40`,
        padding: '14px 18px',
        display: 'flex', alignItems: 'center', gap: 14,
        flexShrink: 0, position: 'relative', zIndex: 1,
        boxShadow: `0 0 28px ${SOS}14`,
      }}>
        <div style={{ position: 'relative', width: 14, height: 14, flexShrink: 0 }}>
          <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: SOS, opacity: 0.35, animation: 'sos-ring 1.4s ease-out infinite' }} />
          <div style={{ position: 'absolute', inset: '3px', borderRadius: '50%', background: SOS, boxShadow: `0 0 8px ${SOS}` }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ color: SOS, fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.22em', marginBottom: 3 }}>
            Emergency Dispatch Active
          </p>
          <p style={{ color: 'var(--text-hi)', fontWeight: 700, fontSize: 16, lineHeight: 1 }}>
            {jobTypeLabel}
          </p>
        </div>
      </div>

      {/* ── Scrollable content ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 14px', position: 'relative', zIndex: 1 }}>

        {/* Location confirmed — always shown when we have GPS coords */}
        {lat != null && lng != null && (
          <div style={{
            borderRadius: 14, padding: '13px 16px',
            background: `${AMBER}0e`, border: `1.5px solid ${AMBER}33`,
            marginBottom: 14, display: 'flex', alignItems: 'flex-start', gap: 12,
            animation: 'card-pop 0.4s cubic-bezier(0.34,1.56,0.64,1) both',
          }}>
            <div style={{ width: 34, height: 34, borderRadius: 9, background: `${AMBER}20`, border: `1px solid ${AMBER}50`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
              <MapPin style={{ width: 16, height: 16, color: AMBER }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <p style={{ color: AMBER, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.15em' }}>
                  Your Location
                </p>
                {isApprox && (
                  <span style={{ fontSize: 9, fontWeight: 700, color: AMBER, background: `${AMBER}18`, border: `1px solid ${AMBER}40`, borderRadius: 6, padding: '1px 6px', letterSpacing: '0.06em' }}>
                    APPROXIMATE
                  </span>
                )}
              </div>
              <p style={{ color: 'var(--text-hi)', fontSize: 14, fontWeight: 500, lineHeight: 1.4 }}>
                {displayAddress ?? 'Getting location…'}
              </p>
              {accuracy != null && accuracy <= 500 && (
                <p style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 3 }}>
                  Accurate to ~{Math.round(accuracy)} m
                </p>
              )}
            </div>
          </div>
        )}

        <div style={{ borderRadius: 12, padding: '11px 13px', marginBottom: 14, background: requestedTow ? 'rgba(245,158,11,0.10)' : 'rgba(96,165,250,0.10)', border: `1px solid ${requestedTow ? `${AMBER}45` : 'rgba(96,165,250,0.32)'}` }}>
          <p style={{ color: 'var(--text-hi)', fontSize: 12, fontWeight: 800, marginBottom: 3 }}>{jobTypeLabel}</p>
          <p style={{ color: 'var(--text-lo)', fontSize: 11.5, lineHeight: 1.5 }}>
            {requestedTow
              ? 'A tow provider will take the vehicle to a garage or safer place.'
              : 'Roadside first aid and triage. Major or unsafe repairs belong at a garage.'}
          </p>
        </div>
        {towRecommended && !requestedTow && (
          <div role="alert" style={{ borderRadius: 12, padding: '11px 13px', marginBottom: 14, background: 'rgba(245,158,11,0.10)', border: `1px solid ${AMBER}55`, color: 'var(--text-hi)', fontSize: 12, lineHeight: 1.5 }}>
            MOTOBOT recommends a tow because this fault may be unsafe or too complex to repair on the road. You selected roadside assessment only.
          </div>
        )}

        {/* AI diagnosis summary — shown when arriving from the guided AI flow */}
        {aiSummary && (
          <div style={{
            borderRadius: 18, padding: '16px 18px',
            background: `${AMBER}0c`, border: `1.5px solid ${AMBER}40`,
            marginBottom: 14,
            animation: 'card-pop 0.4s cubic-bezier(0.34,1.56,0.64,1) 0.06s both',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <div style={{ width: 26, height: 26, borderRadius: 8, background: `linear-gradient(135deg, ${AMBER}, ${AMBRD})`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Sparkles style={{ width: 14, height: 14, color: '#000' }} />
              </div>
              <p style={{ color: AMBER, fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.14em' }}>
                AI Diagnosis Summary
              </p>
            </div>
            <p style={{ color: 'var(--text-hi)', fontSize: 12.5, lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>
              {aiSummary}
            </p>
            <p style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 10, lineHeight: 1.5 }}>
              This summary is sent to your mechanic so they understand the problem before they arrive.
            </p>
          </div>
        )}

        {/* Describe issue card */}
        <div style={{
          borderRadius: 20, padding: '20px',
          background: 'var(--surface-2)', border: '1.5px solid var(--border-2)',
          marginBottom: 14,
          animation: 'card-pop 0.4s cubic-bezier(0.34,1.56,0.64,1) 0.08s both',
        }}>
          <h2 style={{ color: 'var(--text-hi)', fontWeight: 900, fontSize: 20, marginBottom: 6 }}>
            {aiSummary ? 'Anything to add?' : 'Tell us more'}
          </h2>
          <p style={{ color: 'var(--text-lo)', fontSize: 13, lineHeight: 1.6, marginBottom: 18 }}>
            {aiSummary
              ? <>The AI summary above is already attached. Add anything else the mechanic should know, or just tap <strong style={{ color: 'var(--text-md)' }}>Submit</strong>.</>
              : <>Help our providers understand your situation. This is optional — you can also just tap <strong style={{ color: 'var(--text-md)' }}>I Don't Know</strong>.</>}
          </p>

          {showTowDest && (
            <div style={{ marginBottom: 18 }}>
              <p style={{ color: 'var(--text-hi)', fontSize: 13.5, fontWeight: 800, marginBottom: 4 }}>If it needs towing, where to?</p>
              <p style={{ color: 'var(--text-lo)', fontSize: 12, lineHeight: 1.5, marginBottom: 10 }}>Have your own mechanic? We can tow it there — even if they aren't on MOTOFIX.</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[
                  { v: 'find', t: 'Find a nearby garage for me', s: 'We pick the closest trusted provider' },
                  { v: 'own',  t: 'Tow to a specified garage',    s: 'Tell us which garage to take it to' },
                ].map(opt => {
                  const on = towChoice === opt.v
                  return (
                    <button key={opt.v} onClick={() => setTowChoice(opt.v as 'find' | 'own')} disabled={dispatchPhase !== 'idle'}
                      style={{ textAlign: 'left', padding: '12px 14px', borderRadius: 14, cursor: 'pointer', border: on ? `2px solid ${AMBER}` : '1.5px solid var(--border-3)', background: on ? 'rgba(245,158,11,0.12)' : 'var(--surface-1)', display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ width: 18, height: 18, borderRadius: '50%', flexShrink: 0, border: `2px solid ${on ? AMBER : 'var(--border-4)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{on && <span style={{ width: 9, height: 9, borderRadius: '50%', background: AMBER }} />}</span>
                      <span style={{ flex: 1 }}>
                        <span style={{ display: 'block', color: 'var(--text-hi)', fontSize: 13.5, fontWeight: 700 }}>{opt.t}</span>
                        <span style={{ display: 'block', color: 'var(--text-lo)', fontSize: 11, marginTop: 1 }}>{opt.s}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
              {towChoice === 'own' && (
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <input value={garageName} onChange={e => setGarageName(e.target.value)} disabled={dispatchPhase !== 'idle'} placeholder="Garage name — e.g. Katende Motors"
                    style={{ width: '100%', boxSizing: 'border-box', height: 44, borderRadius: 12, border: '1.5px solid var(--border-3)', background: 'var(--input-bg)', color: 'var(--text-hi)', padding: '0 14px', fontSize: 13.5, outline: 'none' }} />
                  <input value={garageArea} onChange={e => setGarageArea(e.target.value)} disabled={dispatchPhase !== 'idle'} placeholder="Area / location — e.g. Ntinda, Kampala"
                    style={{ width: '100%', boxSizing: 'border-box', height: 44, borderRadius: 12, border: '1.5px solid var(--border-3)', background: 'var(--input-bg)', color: 'var(--text-hi)', padding: '0 14px', fontSize: 13.5, outline: 'none' }} />
                  <input value={garagePhone} onChange={e => setGaragePhone(e.target.value)} disabled={dispatchPhase !== 'idle'} inputMode="tel" placeholder="Garage phone — e.g. 0772 123456"
                    style={{ width: '100%', boxSizing: 'border-box', height: 44, borderRadius: 12, border: '1.5px solid var(--border-3)', background: 'var(--input-bg)', color: 'var(--text-hi)', padding: '0 14px', fontSize: 13.5, outline: 'none' }} />
                </div>
              )}
            </div>
          )}

          <div style={{ position: 'relative' }}>
            <textarea
              value={description}
              onChange={e => { if (e.target.value.length <= 300) setDescription(e.target.value) }}
              placeholder="e.g. My car stalled after hitting a pothole and won't start…"
              rows={5}
              disabled={dispatchPhase !== 'idle'}
              style={{
                width: '100%', borderRadius: 14, padding: '14px 16px 28px',
                background: 'var(--input-bg)', border: '1.5px solid var(--border-3)',
                color: 'var(--text-hi)', fontSize: 14, lineHeight: 1.55,
                outline: 'none', resize: 'none', fontFamily: 'inherit',
                boxSizing: 'border-box', transition: 'border-color 0.2s ease',
              }}
              onFocus={e  => { e.currentTarget.style.borderColor = `${AMBER}70` }}
              onBlur={e   => { e.currentTarget.style.borderColor = 'var(--border-3)' }}
            />
            <span style={{ position: 'absolute', bottom: 10, right: 14, fontSize: 10, color: 'var(--text-faint)' }}>
              {description.length}/300
            </span>
          </div>

          {submitError && (
            <p style={{ color: SOS, fontSize: 12, marginTop: 10, fontWeight: 600 }}>{submitError}</p>
          )}
        </div>

        {MOTOBOT_ENABLED && (
        <div style={{ borderRadius: 16, border: '1px solid var(--border-2)', background: 'var(--surface-1)', padding: 16, margin: '0 0 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Sparkles style={{ width: 16, height: 16, color: AMBER }} />
            <p style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-hi)' }}>MOTOBOT cost estimate</p>
            {!estimateLoading && estimate && !photoMismatch && (
              <span style={{
                marginLeft: 'auto', fontSize: 9.5, fontWeight: 800, letterSpacing: '0.05em',
                padding: '3px 8px', borderRadius: 999, whiteSpace: 'nowrap',
                background: photoChecked ? 'rgba(34,197,94,0.14)' : 'var(--surface-2)',
                color:      photoChecked ? '#16A34A'             : 'var(--text-lo)',
                border: `1px solid ${photoChecked ? 'rgba(34,197,94,0.35)' : 'var(--border-3)'}`,
              }}>
                {photoChecked ? '✓ REFINED FROM PHOTO' : 'PRELIMINARY'}
              </span>
            )}
          </div>
          {photoVerdict && (
            <div style={{ display: 'flex', gap: 8, padding: '10px 12px', borderRadius: 12, marginBottom: 12, background: photoVerdict.tone === 'good' ? 'rgba(34,197,94,0.12)' : photoVerdict.tone === 'warn' ? 'rgba(245,158,11,0.12)' : 'var(--surface-2)', border: `1px solid ${photoVerdict.tone === 'good' ? 'rgba(34,197,94,0.35)' : photoVerdict.tone === 'warn' ? AMBER + '50' : 'var(--border-3)'}` }}>
              <span style={{ fontSize: 15, flexShrink: 0 }}>{photoVerdict.tone === 'good' ? '✅' : photoVerdict.tone === 'warn' ? '⚠️' : '🔎'}</span>
              <div>
                <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-hi)', marginBottom: 2 }}>MOTOBOT checked your photo</div>
                <div style={{ fontSize: 12, color: 'var(--text-md)', lineHeight: 1.45 }}>{photoVerdict.text}</div>
                {estimate?.fault_description && <div style={{ fontSize: 11, color: 'var(--text-lo)', lineHeight: 1.45, marginTop: 3 }}>{estimate.fault_description}</div>}
              </div>
            </div>
          )}
          {estimateLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-lo)', fontSize: 13, padding: '4px 0 8px' }}>
              <span style={{ width: 18, height: 18, borderRadius: '50%', border: `2.5px solid ${AMBER}33`, borderTopColor: AMBER, display: 'inline-block', animation: 'di-spin 0.7s linear infinite', flexShrink: 0 }} />
              MOTOBOT is checking typical Kampala prices…
            </div>
          ) : photoMismatch ? (
            <div style={{ display: 'flex', gap: 8, padding: '12px 14px', borderRadius: 12, background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.35)' }}>
              <span style={{ fontSize: 15, flexShrink: 0 }}>🚫</span>
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--text-hi)', marginBottom: 2 }}>That photo doesn’t match your issue</div>
                <div style={{ fontSize: 12, color: 'var(--text-md)', lineHeight: 1.45 }}>{photoMismatch}</div>
                <div style={{ fontSize: 11, color: 'var(--text-lo)', lineHeight: 1.45, marginTop: 4 }}>Upload a photo of the actual problem to get a price recommendation.</div>
              </div>
            </div>
          ) : (
          <>
          {photoChecking && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: AMBRD, fontSize: 12.5, fontWeight: 700, padding: '2px 0 12px' }}>
              <span style={{ width: 18, height: 18, borderRadius: '50%', border: `2.5px solid ${AMBER}33`, borderTopColor: AMBER, display: 'inline-block', animation: 'di-spin 0.7s linear infinite', flexShrink: 0 }} />
              MOTOBOT is checking your photo…
            </div>
          )}
          <div style={{ opacity: photoChecking ? 0.4 : 1, transition: 'opacity 0.2s' }}>
          {(() => {
            const parts = estimate?.required_parts ?? []
            const partsMin = parts.reduce((s, p) => s + (p.price_min || 0), 0)
            const partsMax = parts.reduce((s, p) => s + (p.price_max || 0), 0)
            const feeMin = estimate?.service_fee_min ?? 0
            const feeMax = estimate?.service_fee_max ?? 0
            const repairMin = estimate?.repair_fee_min ?? 0
            const repairMax = estimate?.repair_fee_max ?? 0
            const replaceMin = partsMin + feeMin
            const replaceMax = partsMax + feeMax
            const hasRepair = repairMax > 0
            const hasReplace = replaceMax > 0
            const recRepair  = photoChecked && photoVerdict?.rec === 'repair'
            const recReplace = photoChecked && photoVerdict?.rec === 'replace'
            if (!hasRepair && !hasReplace) return (
              <p style={{ fontSize: 12.5, color: 'var(--text-lo)', lineHeight: 1.5 }}>This one needs an on-site check — your provider will confirm the cost with you before any work begins.</p>
            )
            return (
              <>
                {/* When MOTOBOT made a decisive call from a clear photo, show ONLY the
                    recommended option. Show both ranges only when it's undecided (inspect)
                    or no photo was checked. */}
                {hasRepair && !recReplace && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, padding: '11px 12px', borderRadius: 12, background: 'rgba(34,197,94,0.10)', border: recRepair ? '1.5px solid #16A34A' : '1px solid rgba(34,197,94,0.3)', boxShadow: recRepair ? '0 0 0 3px rgba(34,197,94,0.15)' : 'none', marginBottom: 10 }}>
                    <div>
                      <div style={{ fontSize: 12.5, fontWeight: 800, color: '#16A34A' }}>{recRepair ? 'Repairable — no new part needed' : 'If it can be repaired'}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-lo)', marginTop: 2 }}>Minor on-site fix — no new part</div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5, flexShrink: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 900, color: '#16A34A', whiteSpace: 'nowrap' }}>{rng(repairMin, repairMax)}</div>
                      {recRepair && <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.04em', color: '#fff', background: '#16A34A', borderRadius: 999, padding: '3px 8px', whiteSpace: 'nowrap' }}>✓ MOTOBOT RECOMMENDS</span>}
                    </div>
                  </div>
                )}
                {hasReplace && !recRepair && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, padding: '11px 12px', borderRadius: 12, background: 'rgba(245,158,11,0.10)', border: recReplace ? `1.5px solid ${AMBER}` : `1px solid ${AMBER}40`, boxShadow: recReplace ? `0 0 0 3px ${AMBER}26` : 'none' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 800, color: AMBRD }}>{recReplace ? 'A new part is needed' : 'If a new part is needed'}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-lo)', marginTop: 2 }}>{(parts.length ? parts.map(p => p.name).join(', ') : 'Replacement part')} + fitting</div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5, flexShrink: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 900, color: AMBRD, whiteSpace: 'nowrap' }}>{rng(replaceMin, replaceMax)}</div>
                      {recReplace && <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.04em', color: '#fff', background: AMBRD, borderRadius: 999, padding: '3px 8px', whiteSpace: 'nowrap' }}>✓ MOTOBOT RECOMMENDS</span>}
                    </div>
                  </div>
                )}
                <p style={{ fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.55, marginTop: 11 }}>{photoChecked
                  ? 'Refined from your photo — the mechanic still confirms the final price on arrival. You only pay for a new part if a repair won’t hold. Rough Kampala estimates, not a binding quote.'
                  : 'We can’t see the exact damage from here — the mechanic inspects on arrival and confirms the price. You only pay for a new part if a repair won’t hold. Rough Kampala estimates, not a binding quote.'}</p>
              </>
            )
          })()}
          </div>
          </>
          )}
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 14, padding: '11px 0', borderRadius: 12, border: `1.5px dashed ${AMBER}66`, background: 'rgba(245,158,11,0.06)', color: AMBRD, fontSize: 12.5, fontWeight: 800, cursor: photoChecking ? 'wait' : 'pointer' }}>
            📷 {photoChecking ? 'Checking your photo…' : photoMismatch ? 'Upload a photo of the actual problem' : betterPhotoHint ? 'Add a clearer photo (different angle)' : photoChecked ? 'Add a different photo' : 'Add a photo for the most accurate estimate'}
            <input type="file" accept="image/*" disabled={photoChecking || dispatchPhase !== 'idle'} style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) handlePhoto(f); e.currentTarget.value = '' }} />
          </label>
          {photoError && (
            <p style={{ fontSize: 11.5, color: '#EF4444', fontWeight: 600, lineHeight: 1.5, marginTop: 8 }}>{photoError}</p>
          )}
          {betterPhotoHint && !photoError && (
            <p style={{ fontSize: 11.5, color: AMBRD, fontWeight: 600, lineHeight: 1.5, marginTop: 8 }}>
              📸 {betterPhotoHint}
            </p>
          )}
          {samePhoto && !photoError && !betterPhotoHint && (
            <p style={{ fontSize: 11.5, color: AMBRD, fontWeight: 600, lineHeight: 1.5, marginTop: 8 }}>
              📷 That's the same photo as before — MOTOBOT re-checked it for you. Upload a different angle if you'd like a fresh read.
            </p>
          )}
        </div>
        )}
        {!MOTOBOT_ENABLED && (
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, margin: '0 0 18px', padding: '11px 0', borderRadius: 12, border: `1.5px dashed ${AMBER}66`, background: 'rgba(245,158,11,0.06)', color: AMBRD, fontSize: 12.5, fontWeight: 800, cursor: dispatchPhase === 'idle' ? 'pointer' : 'not-allowed' }}>
            📷 {photoFile ? 'Change photo for your provider' : 'Attach a photo for your provider (optional)'}
            <input type="file" accept="image/*" disabled={dispatchPhase !== 'idle'} style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) handlePhoto(f); e.currentTarget.value = '' }} />
          </label>
        )}

        {/* Action buttons */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 24 }}>
          {submitError && (
            <p style={{ color: SOS, fontSize: 12.5, fontWeight: 600, lineHeight: 1.5, textAlign: 'center', margin: '0 0 2px' }}>{submitError}</p>
          )}
          <button
            onClick={() => handleSubmit()}
            disabled={dispatchPhase !== 'idle'}
            style={{
              width: '100%', height: 56, borderRadius: 16, border: 'none',
              background: `linear-gradient(135deg, ${AMBER}, ${AMBRD})`,
              cursor: dispatchPhase !== 'idle' ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
              boxShadow: `0 0 0 3px ${AMBER}22, 0 8px 28px ${AMBER}35`,
              opacity: dispatchPhase !== 'idle' ? 0.6 : 1,
              animation: 'card-pop 0.4s cubic-bezier(0.34,1.56,0.64,1) 0.16s both',
            }}
          >
            <Send style={{ width: 18, height: 18, color: '#000' }} />
            <span style={{ color: '#000', fontWeight: 800, fontSize: 15 }}>Request {requestedTow ? 'Tow / recovery' : 'Roadside assist'}</span>
          </button>

          <button
            onClick={() => handleSubmit('')}
            disabled={dispatchPhase !== 'idle'}
            style={{
              width: '100%', height: 50, borderRadius: 14,
              background: 'var(--surface-3)', border: '1.5px solid var(--border-3)',
              cursor: dispatchPhase !== 'idle' ? 'not-allowed' : 'pointer',
              color: 'var(--text-md)', fontWeight: 700, fontSize: 14,
              opacity: dispatchPhase !== 'idle' ? 0.5 : 1,
              animation: 'card-pop 0.4s cubic-bezier(0.34,1.56,0.64,1) 0.24s both',
            }}
          >
            {aiSummary ? 'Send AI summary as is' : "I Don't Know — Submit Anyway"}
          </button>
        </div>
      </div>

      {/* ── Dispatch overlay ── */}
      {dispatchPhase !== 'idle' && (
        <DispatchOverlay phase={dispatchPhase as Exclude<DispatchPhase, 'idle'>} issueType={issueType} />
      )}

      <style>{`
        @keyframes sos-ring {
          0%   { transform: scale(1);   opacity: 0.35; }
          70%  { transform: scale(2.6); opacity: 0; }
          100% { opacity: 0; }
        }
        /* di-spin also lives in DispatchOverlay, but that only mounts during
           dispatch — define it here too so the estimate-card ring spins while
           MOTOBOT cross-checks the photo. */
        @keyframes di-spin { to { transform: rotate(360deg); } }
        @keyframes card-pop {
          0%   { opacity: 0; transform: translateY(14px) scale(0.96); }
          60%  { opacity: 1; transform: translateY(-2px) scale(1.01); }
          100% { opacity: 1; transform: translateY(0)    scale(1); }
        }
      `}</style>
    </div>
  )
}
