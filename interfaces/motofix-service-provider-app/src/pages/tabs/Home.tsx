// tabs/Home.tsx — the Home tab of the dashboard: the mechanic's landing view with a greeting,
// their online status, key stats, and entry points to other areas (repairs guide, ratings).
// One of the four bottom-nav tabs rendered inside Dashboard.

import { useMemo, useState, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useRotatingGreeting } from '@/hooks/useRotatingGreeting'
import MechanicalRepairsView from './MechanicalRepairsView'
import RatingsView from './RatingsView'
import {
  Briefcase, Wallet, Star, ChevronRight, Award,
  Wrench, Truck, TrendingUp, CheckCircle,
  Navigation2, BookOpen, X,
  Zap, AlertTriangle, MessageSquare, Camera, Package,
} from 'lucide-react'
import { useTheme } from '@/contexts/ThemeContext'
import StatExplainerModal, { type StatMetric } from '@/components/StatExplainerModal'
import type { MechanicProfile, ServiceRequest } from '@/types'

/* ── Pick the local (non-English) name from a full name ─────── */
const ENGLISH_NAMES = new Set([
  'john','james','peter','paul','joseph','david','moses','michael','robert',
  'william','richard','charles','henry','george','edward','albert','alfred',
  'thomas','samuel','emmanuel','daniel','isaac','joshua','stephen','simon',
  'andrew','philip','mark','matthew','luke','francis','allan','alan','ronald',
  'gerald','ivan','julius','patrick','christopher','anthony','kevin','brian',
  'eric','frank','fred','ian','jack','jacob','jason','joel','jonathan',
  'kenneth','leonard','lewis','martin','nathan','nicholas','oliver','oscar',
  'raymond','roger','scott','sean','steven','timothy','victor','walter',
  'mary','grace','faith','hope','rose','sarah','ruth','esther','rachel',
  'rebecca','elizabeth','catherine','margaret','susan','jane','joan','alice',
  'anne','betty','carol','diana','doris','edith','eva','florence','gloria',
  'helen','irene','joyce','karen','laura','linda','lisa','louise','martha',
  'nancy','patricia','pauline','sharon','shirley','stella','sylvia','teresa',
  'vera','violet','virginia','wendy','mercy','lydia','deborah','priscilla',
])

function getLocalName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/)
  const local = parts.find(p => !ENGLISH_NAMES.has(p.toLowerCase()))
  const chosen = local ?? parts[parts.length - 1]
  return chosen.charAt(0).toUpperCase() + chosen.slice(1).toLowerCase()
}

/* ── Provider tips ───────────────────────────────────────────── */
const TIPS = [
  {
    id: 'customer',
    title: 'Handle Difficult Customers',
    icon: MessageSquare,
    color: '#60A5FA',
    steps: [
      'Stay calm and listen without interrupting. Let the driver fully explain the problem before responding.',
      'Acknowledge their frustration: "I understand this is stressful." Simple empathy goes a long way.',
      'Explain what you are going to do and give a realistic time estimate. Uncertainty makes people more anxious.',
      'Avoid technical jargon. Explain the problem in simple terms the driver can understand.',
      'If the driver is unhappy with a price quote, explain what the cost covers. Never just say "that is the price."',
      'If a situation escalates, stay professional. You can always contact Motofix support for backup.',
      'After the job, ask if everything is okay and encourage them to leave a review if they are satisfied.',
    ],
  },
  {
    id: 'documentation',
    title: 'Document Every Job Properly',
    icon: Camera,
    color: '#A78BFA',
    steps: [
      'Before starting work, take photos of the vehicle from multiple angles to document its existing condition.',
      'Ask the driver to confirm the fault description in the app chat before you begin on-site assist.',
      'Log every part you replace in the job notes — part name, reason for replacement, and cost.',
      'If you find additional faults not in the original request, show the driver and get their approval in writing (app chat) before proceeding.',
      'Take a photo of the completed work and the vehicle in its repaired condition.',
      'Have the driver confirm job completion in the app before you mark it done. This protects both parties.',
      'Keep all receipts for parts purchased. Motofix may request these for reimbursement or dispute resolution.',
    ],
  },
  {
    id: 'safety',
    title: 'Roadside Safety Essentials',
    icon: AlertTriangle,
    color: '#F59E0B',
    steps: [
      'Always park your own vehicle well off the road, at least 10 metres behind the broken-down vehicle.',
      'Turn on your hazard lights immediately when you arrive — before getting out of the vehicle.',
      'Wear a reflective vest whenever you are working on the roadside. Keep one in your kit at all times.',
      'Place warning triangles at least 45 metres behind the broken-down vehicle on both sides.',
      'Never work between two vehicles on a busy road. Position yourself on the safe side (away from traffic).',
      'If the vehicle is in a dangerous position (blind corner, fast road), advise the driver to call traffic police before you begin work.',
      'Keep your toolkit organised so you are not searching through it on the roadside, which distracts you from traffic.',
    ],
  },
  {
    id: 'earnings',
    title: 'Maximise Your Earnings',
    icon: Zap,
    color: '#4ADE80',
    steps: [
      'Stay online during 7–9 AM and 5–8 PM peak hours — these windows generate 3× more requests.',
      'Maintain a rating above 4.5 stars. Drivers see your rating before accepting your quote, so quality is directly tied to income.',
      'Accept or decline each offer in MOTOFIX so the driver sees an accurate status and declined jobs can be reassigned.',
      'Keep your service area and location updated so nearby requests reach you first.',
      'Offer a brief diagnostic for free on simple faults — drivers will trust you and accept your quote faster.',
      'Use the in-app accept and completion steps to keep each job record and driver update accurate.',
      'Keep commonly needed parts (spark plugs, fuses, jump cables, tyre patch kits) in stock to handle jobs on the spot without delays.',
    ],
  },
]

function TipModal({ tip, onClose }: { tip: typeof TIPS[0]; onClose: () => void }) {
  const Icon = tip.icon
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)' }} onClick={onClose} />
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 70,
        background: 'var(--overlay-bg)',
        border: '1px solid var(--border-3)',
        borderRadius: '24px 24px 0 0',
        boxShadow: '0 -24px 64px rgba(0,0,0,0.6)',
        maxHeight: '88vh',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 12, paddingBottom: 6, flexShrink: 0 }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border-4)' }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 20px 16px', flexShrink: 0, borderBottom: '1px solid var(--border-2)' }}>
          <div style={{ width: 44, height: 44, borderRadius: 13, background: `${tip.color}18`, border: `1.5px solid ${tip.color}40`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon style={{ width: 20, height: 20, color: tip.color }} />
          </div>
          <div style={{ flex: 1 }}>
            <p style={{ color: 'var(--text-hi)', fontWeight: 900, fontSize: 16, lineHeight: 1 }}>{tip.title}</p>
            <p style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 3 }}>{tip.steps.length} steps · Provider best practices</p>
          </div>
          <button onClick={onClose} style={{ width: 34, height: 34, borderRadius: 10, background: 'var(--surface-4)', border: '1px solid var(--border-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
            <X style={{ width: 15, height: 15, color: 'var(--text-lo)' }} />
          </button>
        </div>
        <div style={{ overflowY: 'auto', padding: '20px 20px 40px', scrollbarWidth: 'none' }}>
          {tip.steps.map((step, i) => (
            <div key={i} style={{ display: 'flex', gap: 14, marginBottom: i < tip.steps.length - 1 ? 20 : 0 }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                <div style={{ width: 28, height: 28, borderRadius: '50%', background: `${tip.color}20`, border: `1.5px solid ${tip.color}55`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ color: tip.color, fontSize: 11, fontWeight: 900 }}>{i + 1}</span>
                </div>
                {i < tip.steps.length - 1 && (
                  <div style={{ width: 1.5, flex: 1, marginTop: 6, background: `${tip.color}20`, minHeight: 16 }} />
                )}
              </div>
              <p style={{ color: 'var(--text-md)', fontSize: 13.5, lineHeight: 1.65, paddingTop: 4 }}>{step}</p>
            </div>
          ))}
          <div style={{ marginTop: 28, padding: '12px 14px', borderRadius: 14, background: 'var(--surface-1)', border: '1px solid var(--border-2)', display: 'flex', gap: 10 }}>
            <BookOpen style={{ width: 15, height: 15, color: 'var(--text-dim)', flexShrink: 0, marginTop: 1 }} />
            <p style={{ color: 'var(--text-dim)', fontSize: 11.5, lineHeight: 1.55 }}>
              Apply these practices consistently to maintain a high rating and increase your earnings on Motofix.
            </p>
          </div>
        </div>
      </div>
    </>
  )
}

interface HomeProps {
  isAvailable: boolean
  profile: MechanicProfile | null
  pendingCount: number
  activeRequest: ServiceRequest | null
  todayCount: number
  weekCount: number
  handledJobs?: ServiceRequest[]
  ratingRows?: { rating: number; customer_name?: string }[]
  onGoToJobs: () => void
  onGoToEarnings: () => void
}

export default function Home({
  isAvailable, profile, pendingCount, activeRequest,
  todayCount, weekCount, handledJobs = [], ratingRows = [],
  onGoToJobs, onGoToEarnings,
}: HomeProps) {
  const navigate = useNavigate()
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const cardBorder = isDark ? '1.5px solid rgba(255,255,255,0.20)' : '1.5px solid rgba(0,0,0,0.65)'
  const lastName  = profile?.full_name ? getLocalName(profile.full_name) : null
  const isTowing  = profile?.provider_type === 'towing_provider'
  const greeting = useRotatingGreeting(isTowing ? 'towing' : 'mechanic')
  const [hoveredAction, setHoveredAction] = useState<string | null>(null)
  const [selectedTip, setSelectedTip]     = useState<typeof TIPS[0] | null>(null)
  const [showReadyModal,   setShowReadyModal]   = useState(false)
  const [showRepairsView,  setShowRepairsView]  = useState(false)
  const [showRatingsView,  setShowRatingsView]  = useState(false)
  const [statModal,        setStatModal]        = useState<StatMetric | null>(null)
  const readySheetRef  = useRef<HTMLDivElement>(null)
  const dragStartY     = useRef(0)
  const dragCurrent    = useRef(0)

  const onHandleDragStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragStartY.current  = e.clientY
    dragCurrent.current = 0
    if (readySheetRef.current) readySheetRef.current.style.transition = 'none'

    const onMove = (ev: PointerEvent) => {
      const delta = Math.max(0, ev.clientY - dragStartY.current)
      dragCurrent.current = delta
      if (readySheetRef.current) readySheetRef.current.style.transform = `translateY(${delta}px)`
    }
    const onEnd = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup',   onEnd)
      if (!readySheetRef.current) return
      readySheetRef.current.style.transition = 'transform 0.28s cubic-bezier(0.4,0,0.2,1)'
      if (dragCurrent.current > 100) {
        readySheetRef.current.style.transform = 'translateY(110%)'
        setTimeout(() => setShowReadyModal(false), 280)
      } else {
        readySheetRef.current.style.transform = 'translateY(0)'
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup',   onEnd)
  }, [])

  const ACTIONS = isTowing ? [
    { id: 'towing',   label: 'Towing & Recovery',    icon: Truck,    color: '#60A5FA', desc: 'Vehicle recovery · Roadside towing',             onClick: onGoToJobs     },
    { id: 'jobs',     label: 'Job Requests',          icon: Briefcase,color: '#F59E0B', desc: 'Browse and accept available requests nearby',    onClick: onGoToJobs     },
    { id: 'earnings', label: 'Earnings & Payments',   icon: Wallet,   color: '#4ADE80', desc: 'Track your income and payment history',          onClick: onGoToEarnings },
    { id: 'spareparts', label: 'Spare Parts & Tools', icon: Package,  color: '#A78BFA', desc: 'Browse & order genuine car parts',                   onClick: () => navigate('/spare-parts') },
  ] : [
    { id: 'repairs',  label: 'Mechanical Repairs',    icon: Wrench,   color: '#F59E0B', desc: 'Engine · Tyres · Battery · On-site assist',    onClick: () => setShowRepairsView(true) },
    { id: 'jobs',     label: 'Job Requests',          icon: Briefcase,color: '#60A5FA', desc: 'Browse and accept available requests nearby',    onClick: onGoToJobs     },
    { id: 'earnings', label: 'Earnings & Payments',   icon: Wallet,   color: '#4ADE80', desc: 'Track your income and payment history',          onClick: onGoToEarnings },
    { id: 'spareparts', label: 'Spare Parts & Tools', icon: Package,  color: '#A78BFA', desc: 'Browse & order genuine car parts',                   onClick: () => navigate('/spare-parts') },
  ]

  return (
    <div style={{ minHeight: '100vh', paddingBottom: 28, overflowX: 'hidden' }}>
      <div style={{ padding: '0 16px', maxWidth: 480, margin: '0 auto' }}>

        {/* ── Editorial headline ───────────────────────────────── */}
        <div style={{ paddingTop: 28, paddingBottom: 22 }}>
          <p style={{ color: 'var(--text-hi)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.22em', fontWeight: 700, marginBottom: 6 }}>
            MOTOFIX · {isTowing ? 'Towing Network' : 'Service Provider Network'}
          </p>
          <h1 style={{ fontWeight: 900, fontSize: 38, letterSpacing: '-0.03em', lineHeight: 1.0, marginBottom: 10 }}>
            <span style={{ color: '#F59E0B', display: 'block', textShadow: '0 0 40px rgba(245,158,11,0.25)' }}>
              {greeting}
            </span>
            {lastName && (
              <span style={{ display: 'inline-block', marginTop: 6, color: 'var(--text-hi)' }}>
                {lastName.toUpperCase()}.
              </span>
            )}
          </h1>
          <p style={{ color: 'var(--text-md)', fontSize: 12, lineHeight: 1.5 }}>
            {activeRequest
              ? '1 active job in progress'
              : pendingCount > 0
                ? `${pendingCount} request${pendingCount > 1 ? 's' : ''} available near you`
                : 'On-site assist · Tow to garage — try preferred helper first, else next available'}
          </p>
        </div>

        {/* ── Stats row ────────────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 20 }}>
          {([
            { label: 'Today',     metric: 'today'  as const, value: todayCount,  icon: TrendingUp, color: '#60A5FA' },
            { label: 'This Week', metric: 'week'   as const, value: weekCount,   icon: CheckCircle,color: '#F59E0B' },
            { label: 'Rating',    metric: 'rating' as const, value: (profile?.rating ?? profile?.average_rating ?? 0).toFixed(1), icon: Star, color: '#4ADE80' },
          ]).map(({ label, metric, value, icon: Icon, color }) => {
            return (
            <div
              key={label}
              role="button"
              tabIndex={0}
              onClick={() => setStatModal(metric)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setStatModal(metric) } }}
              style={{
                position: 'relative',
                background: 'var(--surface-1)',
                border: cardBorder,
                boxShadow: isDark ? '0 1px 4px rgba(0,0,0,0.09), 0 4px 16px rgba(0,0,0,0.08)' : '0 2px 8px rgba(0,0,0,0.12)',
                borderRadius: 16,
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                padding: '14px 8px', cursor: 'pointer',
                transition: 'background 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLDivElement).style.background = 'var(--surface-4)'
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLDivElement).style.background = 'var(--surface-1)'
              }}
            >
              <Icon style={{ width: 16, height: 16, color, marginBottom: 6 }} />
              <span style={{ fontSize: 22, fontWeight: 900, color: 'var(--text-hi)', lineHeight: 1, letterSpacing: '-0.02em' }}>{value}</span>
              <span style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.09em', fontWeight: 700 }}>{label}</span>
            </div>
          )})}
        </div>

        {/* ── Offline banner ───────────────────────────────────── */}
        {!isAvailable && (
          <div style={{
            marginBottom: 20, borderRadius: 16, padding: '12px 16px',
            display: 'flex', alignItems: 'center', gap: 10,
            background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.18)',
          }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#F59E0B', flexShrink: 0 }} />
            <p style={{ color: 'rgba(245,158,11,0.85)', fontSize: 12, lineHeight: 1.4 }}>
              You are <strong style={{ color: '#F59E0B' }}>offline</strong>. Tap the Online button in the header to start receiving job requests.
            </p>
          </div>
        )}

        {/* ── "Go Live" hero block (like SOS) ──────────────────── */}
        <div
          onClick={() => isAvailable && setShowReadyModal(true)}
          style={{
            borderRadius: 24, overflow: 'hidden', marginBottom: 20,
            background: isAvailable ? 'var(--live-bg)' : 'var(--surface-1)',
            boxShadow: isAvailable ? 'var(--live-shadow)' : 'none',
            border: isAvailable ? '1.5px solid var(--live-border)' : cardBorder,
            cursor: isAvailable ? 'pointer' : 'default',
            transition: 'background 0.3s ease, box-shadow 0.3s ease, border-color 0.3s ease, transform 0.15s ease',
          }}
          onMouseEnter={e => { if (isAvailable) (e.currentTarget as HTMLDivElement).style.transform = 'scale(1.01)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.transform = 'scale(1)' }}
        >
          {/* Top sheen — dark mode only */}
          {isDark && (
            <div style={{ position: 'relative' }}>
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1, background: 'var(--border-4)' }} />
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px' }}>
            <div>
              <p style={{ color: isAvailable ? 'var(--live-label)' : 'var(--text-dim)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.22em', fontWeight: 700, marginBottom: 6 }}>
                {isAvailable ? 'Live Status' : 'Currently Offline'}
              </p>
              <p style={{ color: isAvailable ? 'var(--live-title)' : 'var(--text-hi)', fontWeight: 900, fontSize: 30, letterSpacing: '0.04em', lineHeight: 1 }}>
                {isAvailable ? "You're Live" : 'Go Online'}
              </p>
              <p style={{ color: isAvailable ? 'var(--live-sub)' : 'var(--text-dim)', fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>
                {isAvailable
                  ? (pendingCount > 0 ? `${pendingCount} request${pendingCount > 1 ? 's' : ''} nearby · Watching for jobs` : 'Watching for job requests')
                  : 'Toggle Online in the header to start'}
              </p>
            </div>

            {/* Pulsing target rings */}
            <div style={{ position: 'relative', width: 64, height: 64, flexShrink: 0 }}>
              {isAvailable && [64, 48].map((s, i) => (
                <div key={i} style={{
                  position: 'absolute', top: '50%', left: '50%',
                  width: s, height: s, borderRadius: '50%',
                  border: `1.5px solid var(${i === 0 ? '--live-ring-1' : '--live-ring-2'})`,
                  transform: 'translate(-50%,-50%)',
                  animation: `liveRing ${1.6 + i * 0.5}s ease-out ${i * 0.4}s infinite`,
                }} />
              ))}
              <div style={{
                position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
                width: 36, height: 36, borderRadius: '50%',
                background: isAvailable ? 'var(--live-dot-bg)' : 'var(--surface-3)',
                border: `2px solid ${isAvailable ? 'var(--live-dot-border)' : 'var(--border-3)'}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {isTowing
                  ? <Truck  style={{ width: 16, height: 16, color: isAvailable ? 'var(--live-title)' : 'var(--text-dim)' }} />
                  : <Wrench style={{ width: 16, height: 16, color: isAvailable ? 'var(--live-title)' : 'var(--text-dim)' }} />
                }
              </div>
            </div>
          </div>
        </div>

        {/* ── Active job card ───────────────────────────────────── */}
        {activeRequest && (
          <>
            <p style={{ color: 'var(--text-md)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.22em', fontWeight: 700, marginBottom: 12 }}>
              Active Job
            </p>
            <div
              onClick={onGoToJobs}
              style={{
                borderRadius: 20, padding: '16px 18px', marginBottom: 20,
                background: 'var(--surface-1)',
                border: cardBorder,
                boxShadow: isDark ? '0 0 24px rgba(96,165,250,0.10), 0 1px 3px rgba(0,0,0,0.06)' : '0 2px 8px rgba(0,0,0,0.12)',
                cursor: 'pointer',
                transition: 'background 0.2s ease, transform 0.15s ease',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLDivElement).style.background = 'rgba(96,165,250,0.06)'
                ;(e.currentTarget as HTMLDivElement).style.transform = 'scale(1.01)'
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLDivElement).style.background = 'var(--surface-1)'
                ;(e.currentTarget as HTMLDivElement).style.transform = 'scale(1)'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 42, height: 42, borderRadius: 13, background: 'rgba(96,165,250,0.12)', border: '1px solid rgba(96,165,250,0.30)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <Navigation2 style={{ width: 18, height: 18, color: '#60A5FA' }} />
                  </div>
                  <div>
                    <p style={{ color: 'var(--text-hi)', fontWeight: 800, fontSize: 14, lineHeight: 1 }}>
                      Job in Progress
                    </p>
                    <p style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 4 }}>
                      Click to view job details
                    </p>
                  </div>
                </div>
                <ChevronRight style={{ width: 16, height: 16, color: 'rgba(96,165,250,0.7)', flexShrink: 0 }} />
              </div>
            </div>
          </>
        )}

        {/* ── My Services — editorial ruled list ───────────────── */}
        <p style={{ color: 'var(--text-md)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.22em', fontWeight: 700, marginBottom: 12 }}>
          {isTowing ? 'My Services' : 'Quick Actions'}
        </p>
        <div style={{ background: 'var(--surface-1)', border: cardBorder, borderRadius: 20, overflow: 'hidden', marginBottom: 20, boxShadow: isDark ? '0 1px 4px rgba(0,0,0,0.09), 0 4px 16px rgba(0,0,0,0.08)' : '0 2px 8px rgba(0,0,0,0.12)' }}>
          {ACTIONS.map(({ id, label, icon: Icon, color, desc, onClick }, i) => {
            const hovered  = hoveredAction === id
            const isLocked = !isAvailable && id !== 'earnings'
            const effectiveColor = isLocked ? 'var(--text-ghost)' : color
            return (
              <div
                key={id}
                onClick={() => !isLocked && onClick()}
                onMouseEnter={() => !isLocked && setHoveredAction(id)}
                onMouseLeave={() => setHoveredAction(null)}
                style={{
                  padding: '16px 16px',
                  display: 'flex', alignItems: 'center', gap: 12,
                  borderBottom: i < ACTIONS.length - 1 ? '1px solid var(--border-2)' : 'none',
                  background: isLocked ? 'transparent' : hovered ? `${color}12` : 'transparent',
                  cursor: isLocked ? 'not-allowed' : 'pointer',
                  opacity: isLocked ? 0.38 : 1,
                  transition: 'background 0.2s ease, opacity 0.2s ease',
                }}
              >
                {/* Colored rule */}
                <div style={{
                  width: hovered ? 4 : 3, height: 46, borderRadius: 2, flexShrink: 0,
                  background: effectiveColor,
                  boxShadow: hovered ? `0 0 14px ${color}80` : `0 0 6px ${isLocked ? 'transparent' : color + '30'}`,
                  transition: 'all 0.2s ease',
                }} />
                {/* Icon */}
                <div style={{
                  width: 42, height: 42, borderRadius: 12, flexShrink: 0,
                  background: hovered ? `${color}25` : isLocked ? 'var(--surface-2)' : `${color}12`,
                  border: `1.5px solid ${hovered ? color + '60' : isLocked ? 'var(--border-2)' : color + '25'}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'all 0.2s ease',
                }}>
                  <Icon style={{ width: 20, height: 20, color: isLocked ? 'var(--text-ghost)' : color }} />
                </div>
                {/* Text */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ color: 'var(--text-hi)', fontWeight: 800, fontSize: 15, lineHeight: 1 }}>{label}</p>
                  <p style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 4, lineHeight: 1.3 }}>{desc}</p>
                </div>
                {isLocked
                  ? <span style={{ fontSize: 13, flexShrink: 0 }}>🔒</span>
                  : <ChevronRight style={{ width: 16, height: 16, color: hovered ? `${color}90` : 'var(--text-ghost)', flexShrink: 0, transition: 'color 0.2s' }} />
                }
              </div>
            )
          })}
        </div>

        {/* ── Performance card ──────────────────────────────────── */}
        <p style={{ color: 'var(--text-md)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.22em', fontWeight: 700, marginBottom: 12 }}>
          Performance
        </p>
        <div
          style={{
            borderRadius: 22, background: 'var(--surface-1)', border: cardBorder,
            boxShadow: isDark ? '0 1px 4px rgba(0,0,0,0.09), 0 4px 16px rgba(0,0,0,0.08)' : '0 2px 8px rgba(0,0,0,0.12)',
            padding: '18px 20px', marginBottom: 20, cursor: 'pointer',
            transition: 'background 0.2s ease, border-color 0.2s ease, transform 0.15s ease',
          }}
          onClick={() => setShowRatingsView(true)}
          onMouseEnter={e => {
            (e.currentTarget as HTMLDivElement).style.background = 'rgba(96,165,250,0.06)'
            ;(e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(96,165,250,0.55)'
            ;(e.currentTarget as HTMLDivElement).style.transform = 'scale(1.012)'
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLDivElement).style.background = 'var(--surface-1)'
            ;(e.currentTarget as HTMLDivElement).style.border = cardBorder
            ;(e.currentTarget as HTMLDivElement).style.transform = 'scale(1)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ width: 52, height: 52, borderRadius: 16, flexShrink: 0, background: 'rgba(96,165,250,0.10)', border: '1.5px solid rgba(96,165,250,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Award style={{ width: 22, height: 22, color: '#60A5FA' }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ color: 'var(--text-hi)', fontWeight: 800, fontSize: 15, lineHeight: 1 }}>
                {profile?.jobs_completed ?? 0} Jobs Completed
              </p>
              <p style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 5, lineHeight: 1.4 }}>
                {(profile?.rating ?? profile?.average_rating ?? 0).toFixed(1)}★ average rating · Tap to view your ratings
              </p>
            </div>
            <ChevronRight style={{ width: 20, height: 20, color: 'rgba(96,165,250,0.5)', flexShrink: 0 }} />
          </div>
        </div>

        {/* ── Provider's Handbook ───────────────────────────────── */}
        <p style={{ color: 'var(--text-md)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.22em', fontWeight: 700, marginBottom: 12 }}>
          Provider's Handbook
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 8 }}>
          {TIPS.map(tip => {
            const TIcon = tip.icon
            return (
              <button
                key={tip.id}
                onClick={() => setSelectedTip(tip)}
                style={{
                  background: 'var(--surface-1)', border: cardBorder,
                  boxShadow: isDark ? '0 1px 4px rgba(0,0,0,0.09), 0 4px 16px rgba(0,0,0,0.08)' : '0 2px 8px rgba(0,0,0,0.12)',
                  borderRadius: 18, padding: '16px 14px',
                  textAlign: 'left', cursor: 'pointer',
                  transition: 'background 0.2s ease, border-color 0.2s ease, transform 0.15s ease',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.background = `${tip.color}10`
                  e.currentTarget.style.borderColor = `${tip.color}70`
                  e.currentTarget.style.transform   = 'scale(1.02)'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = 'var(--surface-1)'
                  e.currentTarget.style.border = cardBorder
                  e.currentTarget.style.transform   = 'scale(1)'
                }}
              >
                <div style={{ width: 38, height: 38, borderRadius: 11, background: `${tip.color}18`, border: `1.5px solid ${tip.color}35`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 10 }}>
                  <TIcon style={{ width: 18, height: 18, color: tip.color }} />
                </div>
                <p style={{ color: 'var(--text-hi)', fontWeight: 800, fontSize: 13, lineHeight: 1.3, marginBottom: 6 }}>{tip.title}</p>
                <p style={{ color: tip.color, fontSize: 10.5, fontWeight: 700 }}>{tip.steps.length} steps →</p>
              </button>
            )
          })}
        </div>

      </div>

      {/* Tip detail modal */}
      {selectedTip && <TipModal tip={selectedTip} onClose={() => setSelectedTip(null)} />}

      {/* Stat explainer modal — Today / This Week / Rating */}
      {statModal && (
        <StatExplainerModal
          metric={statModal}
          jobs={handledJobs}
          ratings={ratingRows}
          onClose={() => setStatModal(null)}
        />
      )}

      {/* Mechanical Repairs full-screen view */}
      {showRepairsView && <MechanicalRepairsView onBack={() => setShowRepairsView(false)} />}
      {showRatingsView && <RatingsView onBack={() => setShowRatingsView(false)} />}

      {/* Ready to work modal */}
      {showReadyModal && (
        <>
          <div
            onClick={() => setShowReadyModal(false)}
            style={{
              position: 'fixed', inset: 0, zIndex: 60,
              background: 'rgba(0,0,0,0.55)',
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
            }}
          />
          <div
            ref={readySheetRef}
            style={{
              position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 70,
              maxWidth: 480, margin: '0 auto',
              borderRadius: '28px 28px 0 0',
              background: 'var(--overlay-bg)',
              border: '1px solid var(--border-3)',
              boxShadow: '0 -16px 60px rgba(0,0,0,0.55)',
              padding: '0 24px',
              paddingBottom: 'max(calc(env(safe-area-inset-bottom, 0px) + 24px), 32px)',
              maxHeight: '90vh',
              overflowY: 'auto',
              animation: 'ready-slide-up 0.32s cubic-bezier(0.34,1.56,0.64,1)',
            }}
          >
            {/* Drag handle */}
            <div
              onPointerDown={onHandleDragStart}
              style={{
                width: 36, height: 4, borderRadius: 2, background: 'var(--border-4)',
                margin: '18px auto 28px', cursor: 'grab', touchAction: 'none',
              }}
            />

            {/* Icon */}
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
              <div style={{
                width: 72, height: 72, borderRadius: 22,
                background: '#F59E0B',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 8px 32px rgba(245,158,11,0.35)',
              }}>
                {isTowing
                  ? <Truck  style={{ width: 32, height: 32, color: '#000' }} />
                  : <Wrench style={{ width: 32, height: 32, color: '#000' }} />}
              </div>
            </div>

            <h2 style={{ color: 'var(--text-hi)', fontWeight: 900, fontSize: 22, textAlign: 'center', letterSpacing: '-0.02em', marginBottom: 8 }}>
              You're Live
            </h2>
            <p style={{ color: 'var(--text-md)', fontSize: 13, textAlign: 'center', lineHeight: 1.7, marginBottom: 32, padding: '0 8px' }}>
              Drivers nearby can see you and send requests.
              Head to the Jobs tab to browse and accept incoming jobs.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button
                className="ready-btn-yes"
                onClick={() => { setShowReadyModal(false); onGoToJobs() }}
                style={{
                  width: '100%', height: 56, borderRadius: 18, border: 'none',
                  background: '#F59E0B',
                  color: '#000', fontWeight: 900, fontSize: 15, cursor: 'pointer',
                  boxShadow: '0 4px 20px rgba(245,158,11,0.30)',
                  letterSpacing: '0.02em',
                  transition: 'filter 0.15s ease, transform 0.15s ease',
                }}
              >
                Show Me Jobs
              </button>
              <button
                className="ready-btn-no"
                onClick={() => setShowReadyModal(false)}
                style={{
                  width: '100%', height: 48, borderRadius: 14,
                  background: 'transparent', border: '1.5px solid var(--border-3)',
                  color: 'var(--text-md)', fontWeight: 700, fontSize: 14, cursor: 'pointer',
                  transition: 'background 0.15s ease',
                }}
              >
                Not Right Now
              </button>
            </div>
          </div>
        </>
      )}

      <style>{`
        @keyframes liveRing {
          0%   { transform: translate(-50%,-50%) scale(1);   opacity: 0.8; }
          80%  { transform: translate(-50%,-50%) scale(2.1); opacity: 0; }
          100% { opacity: 0; }
        }
        @keyframes ready-slide-up {
          from { transform: translateY(100%); opacity: 0; }
          to   { transform: translateY(0);    opacity: 1; }
        }
        .ready-btn-yes:hover { filter: brightness(1.12); transform: translateY(-1px); box-shadow: 0 0 0 4px rgba(245,158,11,0.28), 0 8px 28px rgba(245,158,11,0.45) !important; }
        .ready-btn-yes:active { transform: translateY(0); }
        .ready-btn-no:hover  { background: var(--surface-3) !important; border-color: var(--border-4) !important; }
      `}</style>
    </div>
  )
}
