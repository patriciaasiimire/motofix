// tabs/Jobs.tsx — the Jobs tab: lists the mechanic's jobs (available nearby, active, and
// completed history) using JobCard, and opens job details. One of the dashboard's bottom-nav tabs.

import { useState, useEffect, useRef } from 'react'
import {
  PowerOff, CheckCircle, Navigation2, ChevronRight,
  RefreshCw, Wrench, Truck, Zap, Star, Ban,
} from 'lucide-react'
import { C } from '@/styles/tokens'
import { useTheme } from '@/contexts/ThemeContext'
import { jobService, mechanicService, reviewService } from '@/config/api'
import { useAuth } from '@/contexts/AuthContext'
import JobCard from '@/components/JobCard'
import JobDetailModal from '@/components/JobDetailModal'
import SkeletonCard from '@/components/SkeletonCard'
import ActiveJob from './ActiveJob'
import { formatRelativeTime, formatUGX, haversineDistance } from '@/utils/formatters'
import type { ServiceRequest, MechanicProfile, Review } from '@/types'

const Y = '#F59E0B'

function Stars({ count, total = 5 }: { count: number; total?: number }) {
  return (
    <div style={{ display: 'flex', gap: 2 }}>
      {Array.from({ length: total }, (_, i) => (
        <Star key={i} style={{ width: 13, height: 13, fill: i < count ? Y : 'transparent', color: i < count ? Y : C.textFaint }} />
      ))}
    </div>
  )
}

interface JobsProps {
  isAvailable: boolean
  pendingAlert: ServiceRequest | null
  onAlertAccept: (request: ServiceRequest) => void
  onAlertDecline: (request: ServiceRequest) => void
  lastMessage: unknown
  activeRequest: ServiceRequest | null
  sendMessage: (data: object) => void
  onJobCompleted: () => void
}

function parseLocation(loc?: string): [number, number] | null {
  if (!loc) return null
  const parts = loc.split(',').map(Number)
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) return [parts[0], parts[1]]
  return null
}

const STATUS_COLOR: Record<string, string> = {
  completed:       '#4ADE80',
  cancelled:       '#F87171',
  en_route:        '#60A5FA',
  arrived:         '#A78BFA',
  service_started: '#F59E0B',
  accepted:        '#34D399',
}

const STATUS_LABEL: Record<string, string> = {
  en_route:        'On the Way',
  service_started: 'Service Started',
  accepted:        'Accepted',
  arrived:         'Arrived',
  completed:       'Completed',
  cancelled:       'Cancelled',
}

const HISTORY_LIMIT = 5

export default function Jobs({
  isAvailable, pendingAlert, onAlertAccept, onAlertDecline,
  lastMessage, activeRequest, sendMessage, onJobCompleted,
}: JobsProps) {
  const { user } = useAuth()
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const cardBorder = isDark ? '1.5px solid rgba(255,255,255,0.18)' : '1.5px solid rgba(0,0,0,0.65)'
  const softBorder = isDark ? '1px solid rgba(255,255,255,0.10)' : '1px solid rgba(0,0,0,0.15)'

  const [showActiveJob, setShowActiveJob] = useState(false)
  const [pendingJobs,   setPendingJobs]   = useState<ServiceRequest[]>([])
  const [recentJobs,    setRecentJobs]    = useState<ServiceRequest[]>([])
  const [profile,       setProfile]       = useState<MechanicProfile | null>(null)
  const [loading,       setLoading]       = useState(true)
  const [refreshing,    setRefreshing]    = useState(false)
  const [expandedId,    setExpandedId]    = useState<string | null>(null)
  const [typeFilter,    setTypeFilter]    = useState<'all' | 'repair' | 'towing'>('all')
  const [sortBy,        setSortBy]        = useState<'distance' | 'time'>('distance')
  const [showAllHistory, setShowAllHistory] = useState(false)
  const [reviews,        setReviews]        = useState<Review[]>([])
  const [detailJob,      setDetailJob]      = useState<ServiceRequest | null>(null)
  const refreshRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastOnline = localStorage.getItem('sp_last_online')

  /* ── Derived stats ─────────────────────────────────────── */
  const displayedHistory = showAllHistory ? recentJobs : recentJobs.slice(0, HISTORY_LIMIT)

  /* ── Fetch ─────────────────────────────────────────────── */
  const fetchData = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    try {
      // Profile first — it gives us the mechanic id used for history + reviews
      const profileRes = await mechanicService.getProfile().catch(() => null)
      const prof = profileRes?.data ?? null
      if (prof) setProfile(prof)
      const mechId = (prof?.id ?? user?.id ?? '') as string | number

      const [pendingRes, historyRes, reviewsRes] = await Promise.allSettled([
        jobService.getPending(),
        jobService.getHistory(),
        reviewService.getByMechanic(),
      ])
      if (pendingRes.status === 'fulfilled') setPendingJobs(pendingRes.value.data ?? [])
      if (historyRes.status === 'fulfilled') setRecentJobs(historyRes.value.data ?? [])
      if (reviewsRes.status   === 'fulfilled') {
        const body = reviewsRes.value.data as { reviews?: Array<Record<string, unknown>>; average_rating?: number }
        const mapped: Review[] = (body?.reviews ?? []).map(r => ({
          id: String(r.id ?? ''),
          service_request_id: String(r.request_id ?? ''),
          mechanic_id: String(mechId),
          driver_id: '',
          driver_name: (r.customer_name as string) ?? 'Driver',
          stars: Number(r.rating ?? 0),
          comment: (r.comment as string) ?? undefined,
          is_approved: true,
          created_at: String(r.created_at ?? ''),
        }))
        setReviews(mapped)
        if (body?.average_rating != null) {
          setProfile(prev => prev ? { ...prev, average_rating: body.average_rating!, rating: body.average_rating! } : prev)
        }
      }
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    fetchData()
    refreshRef.current = setInterval(fetchData, 30000)
    return () => { if (refreshRef.current) clearInterval(refreshRef.current) }
  }, [])

  useEffect(() => {
    if ((lastMessage as { type?: string })?.type === 'new_job') fetchData()
  }, [lastMessage])

  /* ── Filter + sort pending jobs ────────────────────────── */
  const providerCoords = parseLocation(profile?.current_location)
  const jobsWithDistance = pendingJobs
    .map(j => ({
      job: j,
      distance: (providerCoords && j.location_lat != null && j.location_lng != null)
        ? haversineDistance(providerCoords[0], providerCoords[1], j.location_lat, j.location_lng)
        : undefined,
    }))
    .filter(({ job }) => {
      const isTowJob = /tow|recovery/i.test(job.service_type ?? '')
      if (typeFilter === 'repair') return !isTowJob
      if (typeFilter === 'towing') return isTowJob
      return true
    })
    .sort((a, b) =>
      sortBy === 'distance'
        ? (a.distance ?? 999) - (b.distance ?? 999)
        : new Date(b.job.created_at).getTime() - new Date(a.job.created_at).getTime()
    )

  /* ── Full ActiveJob view ───────────────────────────────── */
  if (showActiveJob && activeRequest) {
    return (
      <ActiveJob
        activeRequest={activeRequest}
        sendMessage={sendMessage}
        lastMessage={lastMessage}
        onJobCompleted={() => { setShowActiveJob(false); onJobCompleted() }}
        onBack={() => setShowActiveJob(false)}
      />
    )
  }

  return (
    <>
      <style>{`
        @keyframes livePulse  { 0%,100%{transform:scale(1)} 50%{transform:scale(1.4)} }
        @keyframes offRing1   { 0%,100%{transform:scale(1);opacity:0.5} 50%{transform:scale(1.18);opacity:0} }
        @keyframes offRing2   { 0%,100%{transform:scale(1);opacity:0.3} 50%{transform:scale(1.28);opacity:0} }
        @keyframes spin       { to { transform: rotate(360deg); } }
        @keyframes fadeSlideUp{ from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        .jobs-filter-pill { transition: all 0.15s ease; }
        .jobs-filter-pill:hover { opacity: 0.82; }
        .jobs-history-row { transition: background 0.15s ease; }
        .jobs-history-row:hover { background: var(--surface-2) !important; }
        .jobs-see-all:hover { opacity: 0.75; }
      `}</style>

      <div style={{ padding: '16px 16px 100px', animation: 'fadeSlideUp 0.2s ease' }}>

        {/* ════════════════════════════════════════════════════
            2. ACTIVE JOB BANNER — only when job is active
        ════════════════════════════════════════════════════ */}
        {activeRequest && (
          <div style={{ marginBottom: 20 }}>
            <p style={{
              fontSize: 10, fontWeight: 800, color: C.textFaint,
              textTransform: 'uppercase', letterSpacing: '0.20em', marginBottom: 10,
            }}>
              Active Job
            </p>
            <button
              onClick={() => setShowActiveJob(true)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                borderRadius: 16, border: cardBorder, background: 'var(--surface-1)',
                boxShadow: isDark ? `0 4px 24px ${C.amber}18` : '0 2px 10px rgba(0,0,0,0.10)',
                cursor: 'pointer', padding: '14px 16px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 46, height: 46, borderRadius: 14, flexShrink: 0,
                  background: `${C.amber}14`, border: `1.5px solid ${C.amber}35`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Navigation2 style={{ width: 20, height: 20, color: C.amber }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 14, fontWeight: 900, color: C.textHi }}>
                      {activeRequest.issue_type ?? activeRequest.service_type ?? 'Service'}
                    </span>
                    <span style={{
                      fontSize: 10, fontWeight: 800, color: C.amber,
                      padding: '2px 9px', borderRadius: 20,
                      background: `${C.amber}14`, border: `1px solid ${C.amber}28`,
                      textTransform: 'capitalize', flexShrink: 0,
                    }}>
                      {STATUS_LABEL[activeRequest.status] ?? activeRequest.status.replace(/_/g, ' ')}
                    </span>
                  </div>
                  {activeRequest.driver_name && (
                    <p style={{ fontSize: 12, color: C.textMuted }}>
                      {activeRequest.driver_name}
                    </p>
                  )}
                </div>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0,
                  padding: '7px 13px', borderRadius: 20,
                  background: `${C.amber}12`, border: `1px solid ${C.amber}28`,
                }}>
                  <span style={{ fontSize: 12, fontWeight: 800, color: C.amber }}>Open</span>
                  <ChevronRight style={{ width: 13, height: 13, color: C.amber }} />
                </div>
              </div>
            </button>
          </div>
        )}

        {/* ════════════════════════════════════════════════════
            3A. AVAILABLE REQUESTS — online, no active job
        ════════════════════════════════════════════════════ */}
        {isAvailable && !activeRequest && (
          <div style={{ marginBottom: 24 }}>
            {/* Section header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div>
                <p style={{
                  fontSize: 10, fontWeight: 800, color: C.textFaint,
                  textTransform: 'uppercase', letterSpacing: '0.20em', marginBottom: 4,
                }}>
                  Available Requests
                </p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 20, fontWeight: 900, color: C.textHi, letterSpacing: '-0.02em' }}>
                    Jobs Near You
                  </span>
                  {!loading && (
                    <span style={{
                      fontSize: 11, fontWeight: 800, color: C.amber,
                      background: `${C.amber}12`, border: `1px solid ${C.amber}28`,
                      borderRadius: 20, padding: '2px 9px',
                    }}>
                      {jobsWithDistance.length}
                    </span>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  onClick={() => fetchData(true)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 6, color: C.textFaint }}
                >
                  <RefreshCw style={{ width: 15, height: 15, animation: refreshing ? 'spin 0.8s linear infinite' : 'none' }} />
                </button>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  background: isDark ? `${C.green}12` : `${C.green}14`,
                  border: `1px solid ${C.green}28`, borderRadius: 20, padding: '5px 11px',
                }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: C.green, animation: 'livePulse 2s ease-in-out infinite' }} />
                  <span style={{ fontSize: 11, color: C.green, fontWeight: 800 }}>Live</span>
                </div>
              </div>
            </div>

            {/* Type filter + sort */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, gap: 8 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                {([['all', 'All'], ['repair', 'Roadside assist'], ['towing', 'Tow / recovery']] as const).map(([val, label]) => (
                  <button
                    key={val}
                    className="jobs-filter-pill"
                    onClick={() => setTypeFilter(val)}
                    style={{
                      padding: '6px 13px', borderRadius: 20, cursor: 'pointer',
                      border: typeFilter === val ? `1.5px solid ${C.amber}` : softBorder,
                      background: typeFilter === val ? C.amber : 'var(--surface-1)',
                      color: typeFilter === val ? '#000' : C.textMuted,
                      fontSize: 12, fontWeight: typeFilter === val ? 800 : 600,
                    }}
                  >
                    {val === 'repair' ? <><Wrench style={{ width: 10, height: 10, display: 'inline', marginRight: 4 }} />{label}</> :
                     val === 'towing' ? <><Truck  style={{ width: 10, height: 10, display: 'inline', marginRight: 4 }} />{label}</> :
                     label}
                  </button>
                ))}
              </div>
              <button
                className="jobs-filter-pill"
                onClick={() => setSortBy(s => s === 'distance' ? 'time' : 'distance')}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  padding: '6px 12px', borderRadius: 20, cursor: 'pointer',
                  background: 'var(--surface-1)', border: softBorder,
                  color: C.textMuted, fontSize: 11, fontWeight: 700,
                }}
              >
                <Zap style={{ width: 11, height: 11 }} />
                {sortBy === 'distance' ? 'Nearest' : 'Latest'}
              </button>
            </div>

            {/* Job cards */}
            {loading ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {[0, 1, 2].map(i => <SkeletonCard key={i} lines={4} />)}
              </div>
            ) : jobsWithDistance.length === 0 ? (
              <div style={{
                borderRadius: 16, border: cardBorder, background: 'var(--surface-1)',
                padding: '32px 20px', textAlign: 'center',
                boxShadow: isDark ? 'none' : '0 1px 6px rgba(0,0,0,0.07)',
              }}>
                <div style={{
                  width: 52, height: 52, borderRadius: 16, margin: '0 auto 14px',
                  background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.05)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Wrench style={{ width: 22, height: 22, color: C.textFaint }} />
                </div>
                <p style={{ fontWeight: 900, fontSize: 15, color: C.textHi, marginBottom: 6 }}>No jobs nearby</p>
                <p style={{ fontSize: 12, color: C.textMuted, lineHeight: 1.65, maxWidth: 240, margin: '0 auto 18px' }}>
                  Stay online — new requests appear automatically as drivers call for help.
                </p>
                <button
                  onClick={() => fetchData(true)}
                  style={{
                    padding: '9px 22px', borderRadius: 20, cursor: 'pointer',
                    background: 'transparent', border: softBorder,
                    color: C.textMuted, fontWeight: 700, fontSize: 13,
                  }}
                >
                  Refresh
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {jobsWithDistance.map(({ job, distance }) => (
                  <JobCard
                    key={job.id} request={job} distance={distance}
                    expanded={expandedId === job.id}
                    onViewDetails={() => setExpandedId(expandedId === job.id ? null : job.id)}
                    onAccept={() => onAlertAccept(job)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* ════════════════════════════════════════════════════
            3B. OFFLINE STATE
        ════════════════════════════════════════════════════ */}
        {!isAvailable && (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            padding: '20px 16px 28px', textAlign: 'center', marginBottom: 8,
          }}>
            <div style={{ position: 'relative', marginBottom: 28 }}>
              <div style={{ position: 'absolute', inset: -18, borderRadius: '50%', border: `2px solid ${C.amber}18`, animation: 'offRing1 2.6s ease-in-out infinite' }} />
              <div style={{ position: 'absolute', inset: -32, borderRadius: '50%', border: `1.5px solid ${C.amber}0E`, animation: 'offRing2 2.6s ease-in-out 0.5s infinite' }} />
              <div style={{
                width: 76, height: 76, borderRadius: 24,
                background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)',
                border: softBorder,
                display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative',
              }}>
                <PowerOff style={{ width: 30, height: 30, color: C.textFaint }} />
              </div>
            </div>
            <h2 style={{ fontSize: 24, fontWeight: 900, color: C.textHi, marginBottom: 8, letterSpacing: '-0.03em' }}>You're Offline</h2>
            <p style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.75, maxWidth: 260, marginBottom: 20 }}>
              Toggle <strong style={{ color: C.textHi }}>Online</strong> to start receiving breakdown requests near you.
            </p>
            {lastOnline && (
              <span style={{
                fontSize: 11, color: C.textFaint, background: 'var(--surface-1)',
                borderRadius: 20, padding: '5px 14px', border: softBorder,
              }}>
                Last active: {formatRelativeTime(new Date(parseInt(lastOnline)).toISOString())}
              </span>
            )}
          </div>
        )}

        {/* ════════════════════════════════════════════════════
            4. JOB HISTORY — always visible, 5 shown by default
        ════════════════════════════════════════════════════ */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div>
              <p style={{
                fontSize: 10, fontWeight: 800, color: C.textFaint,
                textTransform: 'uppercase', letterSpacing: '0.20em', marginBottom: 4,
              }}>
                Job History
              </p>
              <span style={{ fontSize: 20, fontWeight: 900, color: C.textHi, letterSpacing: '-0.02em' }}>
                Recent Jobs
              </span>
            </div>
            {recentJobs.length > 0 && (
              <span style={{
                fontSize: 11, fontWeight: 700, color: C.textFaint,
                background: 'var(--surface-1)', border: softBorder,
                borderRadius: 20, padding: '3px 11px',
              }}>
                {recentJobs.length} total
              </span>
            )}
          </div>

          {recentJobs.length === 0 ? (
            <div style={{
              borderRadius: 16, border: cardBorder, background: 'var(--surface-1)',
              padding: '24px 20px', textAlign: 'center',
            }}>
              <p style={{ fontSize: 13, color: C.textFaint }}>
                No finished jobs yet — completed and cancelled jobs will appear here.
              </p>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {displayedHistory.map(job => {
                  const statusColor = STATUS_COLOR[job.status] ?? C.textFaint
                  const isCancelled = job.status === 'cancelled'
                  return (
                    <div
                      key={job.id}
                      className="jobs-history-row"
                      role="button"
                      tabIndex={0}
                      onClick={() => setDetailJob(job)}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetailJob(job) } }}
                      style={{
                        display: 'flex', alignItems: 'center',
                        borderRadius: 14, overflow: 'hidden',
                        border: cardBorder, background: 'var(--surface-1)',
                        cursor: 'pointer',
                      }}
                    >
                      {/* Status accent strip — green for completed, red for cancelled */}
                      <div style={{ width: 4, alignSelf: 'stretch', background: statusColor, flexShrink: 0 }} />
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px 12px 10px', flex: 1 }}>
                        <div style={{
                          width: 38, height: 38, borderRadius: 12, flexShrink: 0,
                          background: `${statusColor}12`, border: `1.5px solid ${statusColor}28`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                          {isCancelled
                            ? <Ban style={{ width: 16, height: 16, color: statusColor }} />
                            : <CheckCircle style={{ width: 16, height: 16, color: statusColor }} />}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ fontSize: 13, fontWeight: 700, color: C.textHi }}>
                            {job.issue_type ?? job.service_type ?? 'Service'}
                          </p>
                          <p style={{ fontSize: 11, color: C.textFaint, marginTop: 2 }}>
                            {formatRelativeTime(job.completed_time ?? job.created_at)}
                            {job.driver_name ? ` · ${job.driver_name}` : ''}
                          </p>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                          {job.actual_fee != null && (
                            <span style={{ fontSize: 13, fontWeight: 800, color: C.amber }}>
                              {formatUGX(job.actual_fee)}
                            </span>
                          )}
                          <span style={{
                            fontSize: 10, fontWeight: 700, color: statusColor,
                            background: `${statusColor}12`, padding: '2px 8px',
                            borderRadius: 20, textTransform: 'capitalize',
                          }}>
                            {STATUS_LABEL[job.status] ?? job.status.replace(/_/g, ' ')}
                          </span>
                        </div>
                        <ChevronRight style={{ width: 14, height: 14, color: C.textFaint, flexShrink: 0, marginLeft: 6 }} />
                      </div>
                    </div>
                  )
                })}
              </div>

              {recentJobs.length > HISTORY_LIMIT && (
                <button
                  className="jobs-see-all"
                  onClick={() => setShowAllHistory(s => !s)}
                  style={{
                    width: '100%', marginTop: 10, padding: '10px',
                    borderRadius: 12, cursor: 'pointer',
                    background: 'none', border: softBorder,
                    color: C.textMuted, fontSize: 12, fontWeight: 700,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    transition: 'opacity 0.15s',
                  }}
                >
                  <ChevronRight style={{
                    width: 14, height: 14,
                    transform: showAllHistory ? 'rotate(-90deg)' : 'rotate(90deg)',
                    transition: 'transform 0.2s',
                  }} />
                  {showAllHistory ? 'Show less' : `See all ${recentJobs.length} jobs`}
                </button>
              )}
            </>
          )}
        </div>

        {/* ── Reviews ─────────────────────────────────────── */}
        {(() => {
          const approvedRevs = reviews.filter(r => r.is_approved)
          const rating = profile?.average_rating ?? profile?.rating ?? 0
          return (
            <div style={{ marginBottom: 24 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div>
                  <p style={{ fontSize: 10, fontWeight: 800, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.20em', marginBottom: 4 }}>
                    Driver Feedback
                  </p>
                  <span style={{ fontSize: 20, fontWeight: 900, color: C.textHi, letterSpacing: '-0.02em' }}>Reviews</span>
                </div>
                {approvedRevs.length > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 22, fontWeight: 900, color: Y, lineHeight: 1 }}>{rating.toFixed(1)}</span>
                    <Stars count={Math.round(rating)} />
                  </div>
                )}
              </div>

              <div style={{ borderRadius: 20, overflow: 'hidden', background: 'var(--surface-1)', border: cardBorder }}>
                {approvedRevs.length === 0 ? (
                  <div style={{ padding: '28px 20px', textAlign: 'center' }}>
                    <Star style={{ width: 32, height: 32, color: Y, marginBottom: 10 }} />
                    <p style={{ fontSize: 13, fontWeight: 700, color: C.textHi, marginBottom: 4 }}>No reviews yet</p>
                    <p style={{ fontSize: 12, color: C.textFaint, lineHeight: 1.6 }}>Complete jobs to receive ratings from drivers.</p>
                  </div>
                ) : (
                  approvedRevs.map((r, i) => (
                    <div key={r.id} style={{ padding: '14px 18px', borderBottom: i < approvedRevs.length - 1 ? '1px solid var(--border-1)' : 'none' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                        <Stars count={r.stars} />
                        <span style={{ fontSize: 10, color: C.textFaint }}>{formatRelativeTime(r.created_at)}</span>
                      </div>
                      {r.comment && (
                        <p style={{ fontSize: 13, color: 'var(--text-md)', lineHeight: 1.55, marginBottom: 4 }}>"{r.comment}"</p>
                      )}
                      <p style={{ fontSize: 11, color: C.textFaint }}>— {r.driver_name ?? 'Driver'}</p>
                    </div>
                  ))
                )}
              </div>
            </div>
          )
        })()}

      </div>

      {detailJob && <JobDetailModal request={detailJob} onClose={() => setDetailJob(null)} />}
    </>
  )
}
