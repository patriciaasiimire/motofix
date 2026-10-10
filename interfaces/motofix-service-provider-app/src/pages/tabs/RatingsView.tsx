// tabs/RatingsView.tsx — shows the mechanic their customer ratings and reviews (their star
// average and individual feedback), so they can see how they're doing. Opened from the Home tab.

import { useState, useEffect, useRef, useCallback } from 'react'
import type { ReactNode } from 'react'
import {
  ArrowLeft, Star, ChevronRight, Bot, User, Send, Loader2,
  Sparkles, MessageSquare, Wrench, Quote,
} from 'lucide-react'
import { reviewService, jobService, diagnosisService } from '@/config/api'
import type { ChatMsg } from '@/config/api'
import type { ServiceRequest } from '@/types'
import { useTheme } from '@/contexts/ThemeContext'
import { MOTOBOT_ENABLED } from '@/config/features'

const AMBER = '#F59E0B'

type Review = {
  id: number
  request_id: number
  rating: number
  comment?: string | null
  customer_name?: string | null
  service_type?: string | null
  created_at?: string | null
}

/* ── helpers ─────────────────────────────────────────────────── */
function fmtDate(iso?: string | null) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString('en-UG', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Kampala' })
}
function durationStr(a?: string | null, b?: string | null) {
  if (!a || !b) return ''
  const ms = new Date(b).getTime() - new Date(a).getTime()
  if (isNaN(ms) || ms <= 0) return ''
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60), m = mins % 60
  return m ? `${h}h ${m}m` : `${h}h`
}
function renderBold(line: string): ReactNode[] {
  return line.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, i) =>
    part.startsWith('**') && part.endsWith('**')
      ? <strong key={i} style={{ color: 'var(--text-hi)', fontWeight: 800 }}>{part.slice(2, -2)}</strong>
      : <span key={i}>{part}</span>)
}
function Stars({ rating, size = 15 }: { rating: number; size?: number }) {
  return (
    <span style={{ display: 'inline-flex', gap: 2 }}>
      {[1, 2, 3, 4, 5].map(i => (
        <Star key={i} style={{ width: size, height: size, color: i <= Math.round(rating) ? AMBER : 'var(--border-3)', fill: i <= Math.round(rating) ? AMBER : 'transparent' }} />
      ))}
    </span>
  )
}

/* Plain-language context for the AI — scopes the summary + chat to this one job. */
function buildContext(review: Review, job?: ServiceRequest): string {
  const parts: string[] = ['I am reviewing one of my completed MOTOFIX jobs.']
  parts.push(`Service type: ${review.service_type || job?.service_type || 'unknown'}.`)
  const customer = review.customer_name || job?.driver_name
  if (customer) parts.push(`Customer: ${customer}.`)
  if (job?.description) parts.push(`Reported issue / notes: ${job.description}.`)
  const dur = durationStr(job?.created_at, job?.completed_at)
  if (dur) parts.push(`It took about ${dur} from request to completion.`)
  parts.push(`The driver rated this job ${review.rating}/5 stars${review.comment ? ` and commented: "${review.comment}"` : ' (no written comment)'}.`)
  return parts.join(' ')
}

interface Props { onBack: () => void }

export default function RatingsView({ onBack }: Props) {
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const cardBorder = isDark ? '1.5px solid rgba(255,255,255,0.20)' : '1.5px solid rgba(0,0,0,0.65)'

  const [reviews, setReviews]   = useState<Review[]>([])
  const [avg,     setAvg]       = useState<number | null>(null)
  const [jobsById, setJobsById] = useState<Record<string, ServiceRequest>>({})
  const [loading, setLoading]   = useState(true)
  const [selected, setSelected] = useState<Review | null>(null)

  useEffect(() => {
    let alive = true
    Promise.allSettled([reviewService.getByMechanic(), jobService.getCompleted()])
      .then(([rv, jb]) => {
        if (!alive) return
        if (rv.status === 'fulfilled') {
          const b = rv.value.data as { average_rating?: number | null; reviews?: Review[] }
          setReviews(b?.reviews ?? [])
          setAvg(b?.average_rating ?? null)
        }
        if (jb.status === 'fulfilled') {
          const map: Record<string, ServiceRequest> = {}
          jb.value.data.forEach(j => { map[String(j.id)] = j })
          setJobsById(map)
        }
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  if (selected) {
    return <RatingDetail review={selected} job={jobsById[String(selected.request_id)]} cardBorder={cardBorder} onBack={() => setSelected(null)} />
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'var(--bg)', display: 'flex', flexDirection: 'column', animation: 'rv-slide-in 0.3s cubic-bezier(0.4,0,0.2,1)', maxWidth: 480, margin: '0 auto' }}>
      <style>{`
        @keyframes rv-slide-in { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @keyframes rv-blink { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }
        @keyframes spin { to { transform: rotate(360deg); } }
        .rv-row:hover { background: var(--surface-3) !important; }
        .rv-row { transition: background 0.15s ease; }
      `}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', background: 'var(--header-bg)', borderBottom: '1px solid var(--border-2)', flexShrink: 0, paddingTop: 'max(14px, env(safe-area-inset-top, 14px))' }}>
        <button onClick={onBack} style={{ width: 38, height: 38, borderRadius: 12, flexShrink: 0, background: 'var(--surface-2)', border: '1px solid var(--border-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft style={{ width: 18, height: 18, color: 'var(--text-hi)' }} />
        </button>
        <div style={{ flex: 1 }}>
          <p style={{ color: 'var(--text-hi)', fontWeight: 900, fontSize: 17, lineHeight: 1 }}>Your Ratings</p>
          <p style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 2 }}>What drivers said about your work</p>
        </div>
        <div style={{ width: 38, height: 38, borderRadius: 12, flexShrink: 0, background: `${AMBER}18`, border: `1px solid ${AMBER}40`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Star style={{ width: 18, height: 18, color: AMBER, fill: AMBER }} />
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none', padding: '16px 16px 32px' }}>
        {/* Average summary */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '18px 20px', borderRadius: 20, background: 'var(--surface-1)', border: cardBorder, marginBottom: 18 }}>
          <div style={{ textAlign: 'center' }}>
            <p style={{ color: AMBER, fontWeight: 900, fontSize: 34, lineHeight: 1 }}>{avg != null ? avg.toFixed(1) : '—'}</p>
            <div style={{ marginTop: 6 }}><Stars rating={avg ?? 0} size={13} /></div>
          </div>
          <div style={{ flex: 1, borderLeft: '1px solid var(--border-2)', paddingLeft: 16 }}>
            <p style={{ color: 'var(--text-hi)', fontWeight: 800, fontSize: 15 }}>{reviews.length} rating{reviews.length === 1 ? '' : 's'}</p>
            <p style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 4, lineHeight: 1.45 }}>Tap any rating to see how the job went and ask MOTOBOT about it.</p>
          </div>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <Loader2 style={{ width: 26, height: 26, color: AMBER, animation: 'spin 0.8s linear infinite' }} />
          </div>
        ) : reviews.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 16px', background: 'var(--surface-1)', borderRadius: 18, border: cardBorder }}>
            <Star style={{ width: 30, height: 30, color: 'var(--text-ghost)', margin: '0 auto 10px' }} />
            <p style={{ color: 'var(--text-md)', fontSize: 13, fontWeight: 700 }}>No ratings yet</p>
            <p style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 4 }}>Ratings from drivers will appear here after you complete jobs.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {reviews.map(rv => (
              <div key={rv.id} className="rv-row" onClick={() => setSelected(rv)}
                style={{ padding: '14px', borderRadius: 16, background: 'var(--surface-1)', border: cardBorder, cursor: 'pointer' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 42, height: 42, borderRadius: 12, flexShrink: 0, background: `${AMBER}15`, border: `1px solid ${AMBER}30`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Wrench style={{ width: 20, height: 20, color: AMBER }} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <p style={{ color: 'var(--text-hi)', fontWeight: 800, fontSize: 14 }}>{rv.service_type || 'Service'}</p>
                      <Stars rating={rv.rating} size={13} />
                    </div>
                    <p style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 3 }}>
                      {rv.customer_name ? `${rv.customer_name} · ` : ''}{fmtDate(rv.created_at)}
                    </p>
                  </div>
                  <ChevronRight style={{ width: 16, height: 16, color: 'var(--text-ghost)', flexShrink: 0 }} />
                </div>
                {rv.comment && (
                  <p style={{ color: 'var(--text-md)', fontSize: 12.5, lineHeight: 1.5, marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--border-2)' }}>
                    "{rv.comment}"
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ── Rating detail: job history + AI summary + scoped MOTOBOT chat ─────────── */
type ChatItem = { id: number; role: 'user' | 'ai'; text: string }

function RatingDetail({ review, job, cardBorder, onBack }: { review: Review; job?: ServiceRequest; cardBorder: string; onBack: () => void }) {
  const context = buildContext(review, job)
  const [summary, setSummary] = useState('')
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [messages, setMessages] = useState<ChatItem[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, sending])

  // Auto-generate the AI summary once on open.
  useEffect(() => {
    if (!MOTOBOT_ENABLED) return
    let alive = true
    diagnosisService.chat([{ role: 'user', content: `${context}\n\nIn 3–4 short sentences, summarise how this job went for me (the mechanic) and give one practical takeaway. Be concise and specific.` }], 'mechanic')
      .then(res => { if (alive) setSummary(res.data.reply || 'No summary available.') })
      .catch(() => { if (alive) setSummary('Could not generate a summary right now — you can still ask questions below.') })
      .finally(() => { if (alive) setSummaryLoading(false) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const ask = useCallback(async (q: string) => {
    const clean = q.trim()
    if (!clean || sending) return
    const next = [...messages, { id: Date.now(), role: 'user' as const, text: clean }]
    setMessages(next)
    setInput('')
    setSending(true)
    const history: ChatMsg[] = [
      { role: 'user', content: context },
      ...(summary ? [{ role: 'assistant', content: summary } as ChatMsg] : []),
      ...next.map(m => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.text } as ChatMsg)),
    ]
    try {
      const res = await diagnosisService.chat(history, 'mechanic')
      setMessages(p => [...p, { id: Date.now() + 1, role: 'ai', text: res.data.reply || 'Sorry, I could not reply. Try rephrasing.' }])
    } catch {
      setMessages(p => [...p, { id: Date.now() + 1, role: 'ai', text: '⚠️ Could not reach the assistant. Check your connection and try again.' }])
    } finally {
      setSending(false)
    }
  }, [messages, sending, context, summary])

  const customer = review.customer_name || job?.driver_name
  const timeline: { label: string; at?: string | null }[] = [
    { label: 'Requested', at: job?.created_at },
    { label: 'En route',  at: job?.en_route_at },
    { label: 'Arrived',   at: job?.arrived_at },
    { label: 'Started',   at: job?.service_started_at },
    { label: 'Completed', at: job?.completed_at },
  ].filter(t => t.at)
  const totalDur = durationStr(job?.created_at, job?.completed_at)

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'var(--bg)', display: 'flex', flexDirection: 'column', maxWidth: 480, margin: '0 auto' }}>
      <style>{`@keyframes rv-blink { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } } @keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', background: 'var(--header-bg)', borderBottom: '1px solid var(--border-2)', flexShrink: 0, paddingTop: 'max(14px, env(safe-area-inset-top, 14px))' }}>
        <button onClick={onBack} style={{ width: 38, height: 38, borderRadius: 12, flexShrink: 0, background: 'var(--surface-2)', border: '1px solid var(--border-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft style={{ width: 18, height: 18, color: 'var(--text-hi)' }} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ color: 'var(--text-hi)', fontWeight: 900, fontSize: 16, lineHeight: 1 }}>{review.service_type || 'Service'}</p>
          <p style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 2 }}>{customer ? `${customer} · ` : ''}{fmtDate(review.created_at)}</p>
        </div>
        <Stars rating={review.rating} size={16} />
      </div>

      <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none', padding: '16px 16px 8px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Driver comment */}
        {review.comment && (
          <div style={{ padding: '14px 16px', borderRadius: 16, background: 'var(--surface-1)', border: cardBorder }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
              <Quote style={{ width: 13, height: 13, color: AMBER }} />
              <p style={{ color: 'var(--text-dim)', fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em' }}>Driver's comment</p>
            </div>
            <p style={{ color: 'var(--text-md)', fontSize: 13.5, lineHeight: 1.6, fontStyle: 'italic' }}>"{review.comment}"</p>
          </div>
        )}

        {/* Job history / how it went */}
        <div style={{ padding: '14px 16px', borderRadius: 16, background: 'var(--surface-1)', border: cardBorder }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12 }}>
            <Wrench style={{ width: 13, height: 13, color: AMBER }} />
            <p style={{ color: 'var(--text-dim)', fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em' }}>How the job went</p>
          </div>
          {job?.description && (
            <p style={{ color: 'var(--text-md)', fontSize: 13, lineHeight: 1.55, marginBottom: 12 }}>{job.description}</p>
          )}
          {timeline.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {timeline.map((t, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 7, height: 7, borderRadius: '50%', background: AMBER, flexShrink: 0 }} />
                  <span style={{ color: 'var(--text-hi)', fontSize: 12.5, fontWeight: 700, width: 78 }}>{t.label}</span>
                  <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{fmtDate(t.at)}</span>
                </div>
              ))}
              {totalDur && (
                <p style={{ color: 'var(--text-dim)', fontSize: 11.5, marginTop: 4, paddingTop: 8, borderTop: '1px dashed var(--border-2)' }}>
                  Total time on this job: <strong style={{ color: AMBER }}>{totalDur}</strong>
                </p>
              )}
            </div>
          ) : (
            <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>Detailed timeline isn't available for this job.</p>
          )}
        </div>

        {MOTOBOT_ENABLED && <>
        {/* AI summary */}
        <div style={{ padding: '14px 16px', borderRadius: 16, background: `${AMBER}0c`, border: `1px solid ${AMBER}33` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
            <Sparkles style={{ width: 14, height: 14, color: AMBER }} />
            <p style={{ color: AMBER, fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em' }}>MOTOBOT summary</p>
          </div>
          {summaryLoading ? (
            <div style={{ display: 'flex', gap: 5 }}>
              {[0, 1, 2].map(i => <div key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: AMBER, animation: `rv-blink 1.2s ${i * 0.2}s infinite` }} />)}
            </div>
          ) : (
            <div>{summary.split('\n').map((line, i) => (
              <p key={i} style={{ color: 'var(--text-md)', fontSize: 13, lineHeight: 1.6, marginBottom: i < summary.split('\n').length - 1 ? 5 : 0 }}>{renderBold(line)}</p>
            ))}</div>
          )}
        </div>

        {/* Chat thread label */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 4 }}>
          <MessageSquare style={{ width: 13, height: 13, color: 'var(--text-dim)' }} />
          <p style={{ color: 'var(--text-dim)', fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em' }}>Ask MOTOBOT about this job</p>
        </div>

        {messages.map(msg => (
          <div key={msg.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexDirection: msg.role === 'user' ? 'row-reverse' : 'row' }}>
            <div style={{ width: 30, height: 30, borderRadius: '50%', flexShrink: 0, background: msg.role === 'ai' ? `${AMBER}26` : 'rgba(96,165,250,0.18)', border: `1.5px solid ${msg.role === 'ai' ? `${AMBER}66` : 'rgba(96,165,250,0.45)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {msg.role === 'ai' ? <Bot style={{ width: 14, height: 14, color: AMBER }} /> : <User style={{ width: 14, height: 14, color: '#60A5FA' }} />}
            </div>
            <div style={{ maxWidth: '80%', borderRadius: msg.role === 'ai' ? '4px 14px 14px 14px' : '14px 4px 14px 14px', background: msg.role === 'ai' ? 'var(--surface-2)' : 'rgba(96,165,250,0.12)', border: `1px solid ${msg.role === 'ai' ? 'var(--border-2)' : 'rgba(96,165,250,0.25)'}`, padding: '9px 13px' }}>
              {msg.text.split('\n').map((line, i) => (
                <p key={i} style={{ color: 'var(--text-md)', fontSize: 13, lineHeight: 1.6, marginBottom: i < msg.text.split('\n').length - 1 ? 5 : 0 }}>{renderBold(line)}</p>
              ))}
            </div>
          </div>
        ))}
        {sending && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <div style={{ width: 30, height: 30, borderRadius: '50%', flexShrink: 0, background: `${AMBER}26`, border: `1.5px solid ${AMBER}66`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Bot style={{ width: 14, height: 14, color: AMBER }} />
            </div>
            <div style={{ display: 'flex', gap: 4, padding: '11px 15px', background: 'var(--surface-2)', borderRadius: '4px 14px 14px 14px', border: '1px solid var(--border-2)' }}>
              {[0, 1, 2].map(i => <div key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--text-dim)', animation: `rv-blink 1.2s ${i * 0.2}s infinite` }} />)}
            </div>
          </div>
        )}
        <div ref={endRef} />
        </>}
      </div>

      {/* Input */}
      {MOTOBOT_ENABLED && <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border-2)', flexShrink: 0, paddingBottom: 'max(10px, env(safe-area-inset-bottom, 10px))', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && ask(input)}
          placeholder="Ask about this job…" disabled={sending}
          style={{ flex: 1, background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 14, padding: '11px 14px', outline: 'none', color: 'var(--text-hi)', fontSize: 14, opacity: sending ? 0.6 : 1 }} />
        <button onClick={() => ask(input)} disabled={sending || !input.trim()}
          style={{ width: 44, height: 44, borderRadius: 14, border: 'none', flexShrink: 0, background: input.trim() && !sending ? `linear-gradient(135deg, ${AMBER}, #D97706)` : 'var(--surface-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: input.trim() && !sending ? 'pointer' : 'default' }}>
          {sending ? <Loader2 style={{ width: 16, height: 16, color: 'var(--text-dim)', animation: 'spin 0.8s linear infinite' }} /> : <Send style={{ width: 16, height: 16, color: input.trim() ? '#000' : 'var(--text-ghost)' }} />}
        </button>
      </div>}
    </div>
  )
}
