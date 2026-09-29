// IncomingRequestModal.tsx — the pop-up that appears when a new job is offered to the
// mechanic: shows the fault, customer location and any photo, with a countdown, so they can
// accept or decline. This is the key "you've got a job!" prompt.

import { useState, useEffect, useRef } from 'react'
import { Wrench, Truck, MapPin, X, Clock } from 'lucide-react'
import { C } from '@/styles/tokens'
import { useReadableLocation } from '@/utils/geocode'
import type { ServiceRequest } from '@/types'

const SOS_RED    = '#ff2d2d'
const WINDOW_MS  = 5 * 60 * 1000  // 5-minute acceptance window — must match driver app

function getRemainingSeconds(req: ServiceRequest): number {
  const rawTs = (req as any).dispatched_at || req.created_at
  if (!rawTs) return 300
  // Append 'Z' to naive UTC timestamps so all browsers treat them as UTC
  const ts = /[Z+]/.test(String(rawTs)) ? String(rawTs) : String(rawTs) + 'Z'
  const startMs = new Date(ts).getTime()
  if (isNaN(startMs)) return 300
  const elapsed = Date.now() - startMs
  return Math.max(0, Math.round((WINDOW_MS - elapsed) / 1000))
}

interface Props {
  request:   ServiceRequest
  onAccept:  () => void
  onDecline: () => void
}

export default function IncomingRequestModal({ request, onAccept, onDecline }: Props) {
  const [seconds,        setSeconds]        = useState(() => getRemainingSeconds(request))
  const [confirmDecline, setConfirmDecline] = useState(false)
  const locationText = useReadableLocation(request)
  const [accepting,      setAccepting]      = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    // Re-sync countdown from request timestamp each time a new request appears
    setSeconds(getRemainingSeconds(request))

    intervalRef.current = setInterval(() => {
      setSeconds(s => {
        if (s <= 1) { onDecline(); return 0; }
        return s - 1
      })
    }, 1000)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [request.id])

  const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
  const ss = String(seconds % 60).padStart(2, '0')
  const progress = (seconds / 300) * 100
  const isTowing = /tow|recovery/i.test(request.service_type ?? '')
  const ServiceIcon = isTowing ? Truck : Wrench
  const jobTypeLabel = isTowing ? 'Tow / recovery' : 'Roadside assist'
  const jobExpectation = isTowing
    ? 'Take the vehicle to the garage or safer place described in the request.'
    : 'First aid and triage on site; major repairs may need a garage.'

  const timerColor = seconds > 120 ? C.amber : seconds > 60 ? '#fb923c' : '#f87171'

  // When the driver sent the request — shown so the mechanic knows how fresh it is.
  const requestedAt = (() => {
    const raw = (request as any).created_at
    if (!raw) return null
    const ts = /[Z+]/.test(String(raw)) ? String(raw) : String(raw) + 'Z'
    const d = new Date(ts)
    return isNaN(d.getTime()) ? null : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  })()

  return (
    <>
      <style>{`
        @keyframes irm-pop-in {
          from { transform: translate(-50%, -50%) scale(0.88); opacity: 0; }
          to   { transform: translate(-50%, -50%) scale(1);    opacity: 1; }
        }
        @keyframes irm-ring {
          0%   { transform: translate(-50%,-50%) scale(0.85); opacity: 0.8; }
          80%  { transform: translate(-50%,-50%) scale(2.2);  opacity: 0;   }
          100% { opacity: 0; }
        }
        @keyframes irm-dot {
          0%,100% { transform: scale(1);   opacity: 1;   }
          50%     { transform: scale(0.5); opacity: 0.4; }
        }
        .irm-btn-accept:hover:not(:disabled) {
          filter: brightness(1.15);
          box-shadow: 0 0 0 4px rgba(251,191,36,0.35), 0 8px 32px rgba(251,191,36,0.55) !important;
          transform: translateY(-1px);
        }
        .irm-btn-accept:active:not(:disabled) { transform: translateY(0); }
        .irm-btn-decline:hover {
          filter: brightness(1.12);
          box-shadow: 0 4px 20px rgba(255,45,45,0.4);
        }
        .irm-btn-decline-confirm:hover {
          filter: brightness(1.12);
        }
        .irm-btn-back:hover {
          background: rgba(255,255,255,0.06) !important;
        }
        .irm-btn-accept, .irm-btn-decline, .irm-btn-decline-confirm, .irm-btn-back {
          transition: filter 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease,
                      background 0.15s ease, border-color 0.15s ease;
        }
      `}</style>

      {/* Backdrop */}
      <div style={{
        position: 'fixed', inset: 0, zIndex: 999,
        background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }} />

      {/* Centered card */}
      <div style={{
        position: 'fixed', top: '50%', left: '50%', zIndex: 1000,
        transform: 'translate(-50%, -50%)',
        width: 'calc(100% - 32px)', maxWidth: 420,
        borderRadius: 24,
        background: C.surface1,
        boxShadow: '0 24px 80px rgba(0,0,0,0.75), 0 0 0 1px rgba(255,255,255,0.06)',
        padding: '0 20px 20px',
        animation: 'irm-pop-in 0.32s cubic-bezier(0.34,1.56,0.64,1)',
        overflow: 'hidden',
      }}>

        {/* Drag handle */}
        <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border-3)', margin: '14px auto 14px' }} />

        {/* Icon ring */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
          <div style={{ position: 'relative', width: 56, height: 56 }}>
            {[66, 46].map((size, i) => (
              <div key={size} style={{
                position: 'absolute', top: '50%', left: '50%',
                width: size, height: size, borderRadius: '50%',
                border: `1.5px solid ${C.amber}${i === 0 ? '20' : '38'}`,
                transform: 'translate(-50%,-50%)',
                animation: `irm-ring ${1.8 + i * 0.5}s ease-out ${i * 0.35}s infinite`,
              }} />
            ))}
            <div style={{
              width: 56, height: 56, borderRadius: '50%',
              background: `${C.amber}14`, border: `2px solid ${C.amber}55`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: `0 0 22px ${C.amber}28`,
            }}>
              <ServiceIcon style={{ width: 24, height: 24, color: C.amber }} />
            </div>
          </div>
        </div>

        {/* Title */}
        <h2 style={{ fontSize: 18, fontWeight: 900, color: C.textHi, textAlign: 'center', marginBottom: 2 }}>
          New {jobTypeLabel} Request
        </h2>
        <p style={{ fontSize: 11, color: C.textFaint, textAlign: 'center', marginBottom: 12, letterSpacing: '0.03em' }}>
          {jobExpectation}
        </p>

        {/* Countdown */}
        <div style={{ textAlign: 'center', marginBottom: 14 }}>
          <div style={{ fontSize: 34, fontWeight: 900, color: timerColor, fontFamily: 'monospace', letterSpacing: '0.06em', lineHeight: 1 }}>
            {mm}:{ss}
          </div>
          <div style={{ height: 4, borderRadius: 2, background: C.surface3, marginTop: 6, overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: 2,
              background: `linear-gradient(90deg, ${timerColor}, ${timerColor}bb)`,
              width: `${progress}%`,
              transition: 'width 1s linear, background 0.5s ease',
              boxShadow: `0 0 8px ${timerColor}66`,
            }} />
          </div>
        </div>

        {/* Job details card */}
        <div style={{
          background: C.surface2, borderRadius: 16, padding: '12px 14px',
          marginBottom: 14, border: `1px solid var(--border-2)`,
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>

          {/* Issue Name */}
          <div>
            <p style={{ fontSize: 10, fontWeight: 800, color: C.textFaint, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 3 }}>
              Issue
            </p>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <p style={{ fontSize: 15, fontWeight: 900, color: C.textHi }}>
                {jobTypeLabel}{request.issue_type ? ` · ${request.issue_type}` : ''}
              </p>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '3px 10px', borderRadius: 9999,
                background: `${C.amber}14`, border: `1px solid ${C.amber}35`,
              }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: C.amber, animation: 'irm-dot 1.4s ease-in-out infinite' }} />
                <span style={{ fontSize: 10, fontWeight: 800, color: C.amber, letterSpacing: '0.08em' }}>LIVE</span>
              </div>
            </div>
          </div>

          {/* Divider */}
          <div style={{ height: 1, background: 'var(--border-2)' }} />

          {/* Description */}
          {request.description && (
            <div>
              <p style={{ fontSize: 13, fontWeight: 700, color: C.amber, marginBottom: 3 }}>
                Description
              </p>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <Wrench style={{ width: 13, height: 13, color: C.amber, flexShrink: 0, marginTop: 2 }} />
                <p style={{
                  fontSize: 12, color: C.textMuted, lineHeight: 1.5,
                  whiteSpace: 'pre-wrap', maxHeight: 180, overflowY: 'auto',
                  flex: 1,
                }}>
                  {request.description}
                </p>
              </div>
            </div>
          )}

          {/* Driver's photo of the problem */}
          {(request.media_files ?? []).some(m => m.file_type === 'photo' || m.file_type === 'image') && (
            <div>
              <p style={{ fontSize: 13, fontWeight: 700, color: C.amber, marginBottom: 3 }}>Photo from the driver</p>
              <div style={{ display: 'flex', gap: 8, overflowX: 'auto' }}>
                {(request.media_files ?? []).filter(m => m.file_type === 'photo' || m.file_type === 'image').map((m, i) => (
                  <a key={i} href={m.url} target="_blank" rel="noreferrer" style={{ flexShrink: 0 }}>
                    <img src={m.url} alt="Reported damage" style={{ height: 96, borderRadius: 10, border: `1px solid ${C.border}`, objectFit: 'cover', display: 'block' }} />
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Location */}
          <div>
            <p style={{ fontSize: 13, fontWeight: 700, color: C.amber, marginBottom: 3 }}>
              Location
            </p>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <MapPin style={{ width: 13, height: 13, color: C.amber, flexShrink: 0, marginTop: 2 }} />
              <p style={{ fontSize: 12, color: C.textHi, lineHeight: 1.4 }}>{locationText}</p>
            </div>
          </div>

          {/* Requested at — how fresh the request is */}
          {requestedAt && (
            <div>
              <p style={{ fontSize: 13, fontWeight: 700, color: C.amber, marginBottom: 3 }}>
                Requested At
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Clock style={{ width: 13, height: 13, color: C.amber, flexShrink: 0 }} />
                <p style={{ fontSize: 12, color: C.textHi, lineHeight: 1.4 }}>{requestedAt}</p>
              </div>
            </div>
          )}

        </div>

        {/* Buttons */}
        {confirmDecline ? (
          <div style={{ marginBottom: 4 }}>
            <p style={{ fontSize: 13, fontWeight: 700, color: C.textHi, textAlign: 'center', marginBottom: 10 }}>
              Are you sure you want to decline?
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                className="irm-btn-decline-confirm"
                onClick={onDecline}
                style={{
                  flex: 1, height: 48, borderRadius: 14,
                  border: 'none', background: SOS_RED,
                  color: '#fff', fontWeight: 800, fontSize: 14, cursor: 'pointer',
                }}
              >
                Yes, Decline
              </button>
              <button
                className="irm-btn-back"
                onClick={() => setConfirmDecline(false)}
                style={{
                  flex: 1, height: 48, borderRadius: 14,
                  border: `1.5px solid var(--border-3)`, background: C.surface3,
                  color: C.textMuted, fontWeight: 700, fontSize: 14, cursor: 'pointer',
                }}
              >
                Go Back
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 4 }}>
            <button
              className="irm-btn-accept"
              onClick={() => { setAccepting(true); onAccept() }}
              disabled={accepting}
              style={{
                width: '100%', height: 50, borderRadius: 14, border: 'none',
                background: accepting ? `${C.amber}70` : `linear-gradient(135deg, ${C.amber}, ${C.amberDark})`,
                color: '#000', fontWeight: 900, fontSize: 16,
                cursor: accepting ? 'not-allowed' : 'pointer',
                boxShadow: accepting ? 'none' : `0 0 0 3px ${C.amber}22, 0 6px 24px ${C.amber}44`,
                opacity: accepting ? 0.8 : 1,
                letterSpacing: '0.01em',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              }}
            >
              {accepting ? 'Accepting…' : <><ServiceIcon style={{ width: 17, height: 17 }} /> Accept Job</>}
            </button>
            <button
              className="irm-btn-decline"
              onClick={() => setConfirmDecline(true)}
              style={{
                width: '100%', height: 50, borderRadius: 14,
                border: 'none', background: SOS_RED,
                color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              }}
            >
              <X style={{ width: 17, height: 17 }} /> Decline
            </button>
          </div>
        )}
      </div>
    </>
  )
}
