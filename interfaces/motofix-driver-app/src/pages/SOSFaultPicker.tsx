// SOSFaultPicker.tsx — the quick "what kind of help do you need?" picker reached from the
// SOS button: pick the fault type (tyre, battery, fuel, etc.), which routes into the right
// flow (e.g. the out-of-fuel flow, or describing the issue to dispatch a mechanic).

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import OutOfFuelFlow from './OutOfFuelFlow';

function splashDisabled(): boolean {
  try { return JSON.parse(localStorage.getItem('motofix_settings') ?? '{}').disableSplash === true; }
  catch { return false; }
}
import {
  ArrowLeft, Disc3, Zap, Battery, Droplets,
  Truck, HelpCircle, Sparkles, Wrench, AlertTriangle,
} from 'lucide-react';
import { useRequests } from '@/contexts/RequestContext';

const R  = '#ff2d2d';
const Y  = '#F59E0B';
const YD = '#D97706';

const FAULTS = [
  { id: 'flat_tire',  serviceType: 'mechanic',        label: 'Flat Tyre',     desc: 'Puncture or blowout',      Icon: Disc3      },
  { id: 'engine',     serviceType: 'mechanic',        label: 'Engine Fault',  desc: 'Stalled or warning light', Icon: Zap        },
  { id: 'battery',    serviceType: 'mechanic',        label: 'Dead Battery',  desc: "Won't start or weak",      Icon: Battery    },
  { id: 'fuel',       serviceType: 'mechanic',        label: 'Out of Fuel',   desc: 'Ran dry or fuel leak',     Icon: Droplets   },
  { id: 'towing',     serviceType: 'towing_provider', label: 'Tow / recovery', desc: "Vehicle can't be driven safely", Icon: Truck },
  { id: 'other',      serviceType: 'mechanic',        label: 'Other Issue',   desc: 'Something else entirely',  Icon: HelpCircle },
];

/* ── Duration config ── */
const WELCOME_DURATION = 3200; // ms before auto-dismiss starts
const FADE_DURATION    = 500;  // ms for fade-out animation

/* ─────────────────────────────────────────────────────────────
   Welcome overlay
───────────────────────────────────────────────────────────── */
function WelcomeOverlay() {
  return (
    <div className="welcome-overlay" style={{
      position: 'fixed', inset: 0, zIndex: 60,
      background: 'var(--page-bg)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: '32px 28px',
    }}>

      {/* Ambient glows */}
      <div style={{ position: 'absolute', top: -60, left: '50%', transform: 'translateX(-50%)', width: 320, height: 320, borderRadius: '50%', background: `${R}0a`, filter: 'blur(70px)', pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', bottom: -40, right: -40, width: 240, height: 240, borderRadius: '50%', background: `${Y}07`, filter: 'blur(60px)', pointerEvents: 'none' }} />

      {/* MOTOFIX wordmark */}
      <span style={{
        color: Y, fontSize: 12, fontWeight: 900,
        letterSpacing: '0.18em',
        textShadow: `0 0 20px ${Y}55`,
        marginBottom: 28,
      }}>
        MOTOFIX
      </span>

      {/* Icon ring */}
      <div style={{ position: 'relative', width: 86, height: 86, marginBottom: 28 }}>
        {[86, 62].map((s, i) => (
          <div key={s} style={{
            position: 'absolute', top: '50%', left: '50%',
            width: s, height: s, borderRadius: '50%',
            border: `1.5px solid rgba(245,158,11,${0.18 + i * 0.15})`,
            transform: 'translate(-50%,-50%)',
            animation: `wlc-ring ${2 + i * 0.7}s ease-out ${i * 0.3}s infinite`,
          }} />
        ))}
        <div style={{
          position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
          width: 52, height: 52, borderRadius: 16,
          background: `linear-gradient(135deg, ${Y}22, ${Y}10)`,
          border: `2px solid ${Y}45`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: `0 0 28px ${Y}22`,
        }}>
          <Wrench style={{ width: 24, height: 24, color: Y }} />
        </div>
      </div>

      {/* Headline */}
      <p style={{
        color: 'var(--text-hi)', fontWeight: 900, fontSize: 26,
        textAlign: 'center', letterSpacing: '-0.02em',
        lineHeight: 1.15, marginBottom: 12,
      }}>
        Request Assistance
      </p>

      {/* Description */}
      <p style={{
        color: 'var(--text-lo)', fontSize: 14,
        textAlign: 'center', lineHeight: 1.65,
        maxWidth: 290, marginBottom: 36,
      }}>
        Select what you need help with below. Our verified network of mechanics,
        towing services, and roadside providers are standing by.
      </p>

      {/* Preview icons row */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 36 }}>
        {FAULTS.slice(0, 5).map(({ Icon, id }, i) => (
          <div key={id} style={{
            width: 42, height: 42, borderRadius: 12,
            background: 'var(--surface-3)',
            border: '1px solid var(--border-3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            animation: `wlc-icon 0.4s cubic-bezier(0.34,1.56,0.64,1) ${i * 0.07}s both`,
          }}>
            <Icon style={{ width: 18, height: 18, color: 'var(--text-lo)' }} />
          </div>
        ))}
      </div>

      {/* Progress bar */}
      <div style={{ width: '100%', maxWidth: 280, height: 2, borderRadius: 1, background: 'var(--surface-4)', overflow: 'hidden', marginBottom: 20 }}>
        <div style={{
          height: '100%', borderRadius: 1,
          background: `linear-gradient(90deg, ${R}, ${Y})`,
          animation: `wlc-bar ${WELCOME_DURATION}ms linear both`,
        }} />
      </div>

      <p style={{ color: 'var(--text-faint)', fontSize: 11 }}>
        Loading your options…
      </p>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Main page
───────────────────────────────────────────────────────────── */
const ACTIVE_STATUSES = new Set(['pending', 'accepted', 'en_route', 'arrived', 'in_progress', 'service_started']);

export default function SOSFaultPicker() {
  const navigate = useNavigate();
  const { requests } = useRequests();
  const [showFuelFlow, setShowFuelFlow] = useState(false);

  const activeReq = requests.find(r => ACTIVE_STATUSES.has(r.status)) ?? null;

  // 'visible' → 'fading' → 'gone'
  const [overlayPhase, setOverlayPhase] = useState<'visible' | 'fading' | 'gone'>(() => splashDisabled() ? 'gone' : 'visible');

  const dismiss = () => {
    if (overlayPhase !== 'visible') return;
    setOverlayPhase('fading');
    setTimeout(() => setOverlayPhase('gone'), FADE_DURATION);
  };

  // Auto-dismiss after WELCOME_DURATION
  useEffect(() => {
    const t = setTimeout(dismiss, WELCOME_DURATION);
    return () => clearTimeout(t);
  }, []);

  const showContent = overlayPhase !== 'visible'; // cards animate in as overlay starts fading

  /* ── Block new requests while one is active ─────────────────── */
  if (activeReq) {
    const statusLabel: Record<string, string> = {
      pending:         'Waiting for a mechanic',
      accepted:        'Mechanic accepted',
      en_route:        'Mechanic on the way',
      arrived:         'Mechanic has arrived',
      in_progress:     'Service in progress',
      service_started: 'Service in progress',
    };
    const label = statusLabel[activeReq.status] ?? 'Request in progress';

    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 60,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        background: 'var(--page-bg)', padding: '32px 24px',
      }}>
        {/* Ambient glow */}
        <div style={{ position: 'absolute', top: -60, left: '50%', transform: 'translateX(-50%)', width: 320, height: 320, borderRadius: '50%', background: `${Y}0a`, filter: 'blur(80px)', pointerEvents: 'none' }} />

        {/* Warning icon */}
        <div style={{ position: 'relative', marginBottom: 28 }}>
          {[80, 56].map((size, i) => (
            <div key={size} style={{
              position: 'absolute', top: '50%', left: '50%',
              width: size, height: size, borderRadius: '50%',
              border: `1.5px solid ${Y}${i === 0 ? '18' : '30'}`,
              transform: 'translate(-50%,-50%)',
              animation: `wlc-ring ${1.8 + i * 0.5}s ease-out ${i * 0.3}s infinite`,
            }} />
          ))}
          <div style={{
            width: 72, height: 72, borderRadius: '50%',
            background: `${Y}18`, border: `2px solid ${Y}55`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: `0 0 32px ${Y}28`,
            position: 'relative',
          }}>
            <AlertTriangle style={{ width: 34, height: 34, color: Y }} />
          </div>
        </div>

        {/* Copy */}
        <p style={{ color: Y, fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: 10 }}>
          Request Active
        </p>
        <h2 style={{ color: 'var(--text-hi)', fontWeight: 900, fontSize: 22, textAlign: 'center', letterSpacing: '-0.02em', lineHeight: 1.2, marginBottom: 10 }}>
          You already have a request in progress
        </h2>
        <p style={{ color: 'var(--text-lo)', fontSize: 13, textAlign: 'center', lineHeight: 1.65, maxWidth: 290, marginBottom: 8 }}>
          You cannot place another service request while one is active.
        </p>

        {/* Status pill */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '7px 16px', borderRadius: 9999, marginBottom: 32,
          background: `${Y}14`, border: `1.5px solid ${Y}40`,
        }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: Y, animation: 'sos-ring-dot 1.4s ease-in-out infinite' }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: Y }}>{label}</span>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', maxWidth: 320 }}>
          <button
            onClick={() => navigate(`/requests/${activeReq.id}`, { replace: true })}
            style={{
              width: '100%', height: 54, borderRadius: 16, border: 'none',
              background: `linear-gradient(135deg, ${Y}, ${YD})`,
              color: '#000', fontWeight: 800, fontSize: 15, cursor: 'pointer',
              boxShadow: `0 0 0 3px ${Y}22, 0 6px 24px ${Y}35`,
            }}
          >
            View Current Request
          </button>
          <button
            onClick={() => navigate(-1)}
            style={{
              width: '100%', height: 48, borderRadius: 14,
              background: 'var(--surface-3)', border: '1.5px solid var(--border-3)',
              color: 'var(--text-md)', fontWeight: 700, fontSize: 14, cursor: 'pointer',
            }}
          >
            Go Back
          </button>
        </div>

        <style>{`
          @keyframes wlc-ring {
            0%   { transform: translate(-50%,-50%) scale(0.8); opacity: 0.8; }
            80%  { transform: translate(-50%,-50%) scale(2.2); opacity: 0; }
            100% { opacity: 0; }
          }
          @keyframes sos-ring-dot {
            0%,100% { opacity: 1; transform: scale(1); }
            50%     { opacity: 0.4; transform: scale(0.6); }
          }
        `}</style>
      </div>
    );
  }

  const pick = (fault: typeof FAULTS[0]) => {
    if (fault.id === 'fuel') {
      setShowFuelFlow(true);
    } else if (fault.id === 'other') {
      navigate('/fault-chat', { state: { issueType: 'other' } });
    } else {
      navigate('/locating', { state: { issueType: fault.id, serviceType: fault.serviceType } });
    }
  };

  return (
    <>
    <div style={{
      position: 'fixed', inset: 0, zIndex: 50,
      display: 'flex', flexDirection: 'column',
      background: 'var(--page-bg)',
      overflow: 'hidden',
    }}>

      {/* Ambient glows */}
      <div style={{ pointerEvents: 'none', position: 'absolute', inset: 0, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', top: -80, left: -60, width: 320, height: 320, borderRadius: '50%', background: `${R}0c`, filter: 'blur(80px)' }} />
        <div style={{ position: 'absolute', bottom: -60, right: -40, width: 280, height: 280, borderRadius: '50%', background: `${Y}08`, filter: 'blur(80px)' }} />
      </div>

      {/* ── Top bar ── */}
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
        <span style={{ color: Y, fontSize: 13, fontWeight: 900, letterSpacing: '0.12em', textShadow: `0 0 20px ${Y}55` }}>
          MOTOFIX
        </span>
        {/* Placeholder to keep wordmark centred */}
        <div style={{ width: 38 }} />
      </div>

      {/* ── SOS status banner ── */}
      <div style={{
        marginLeft: 14, marginRight: 14, marginBottom: 14,
        borderRadius: 14,
        background: `linear-gradient(135deg, ${R}1a 0%, rgba(10,10,18,0.9) 100%)`,
        border: `1.5px solid ${R}40`,
        padding: '14px 18px',
        display: 'flex', alignItems: 'center', gap: 14,
        flexShrink: 0, position: 'relative', zIndex: 1,
        boxShadow: `0 0 28px ${R}18`,
      }}>
        {/* Pulsing dot */}
        <div style={{ position: 'relative', width: 14, height: 14, flexShrink: 0 }}>
          <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: R, opacity: 0.35, animation: 'sos-ring 1.4s ease-out infinite' }} />
          <div style={{ position: 'absolute', inset: '3px', borderRadius: '50%', background: R, boxShadow: `0 0 8px ${R}` }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ color: R, fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.22em', marginBottom: 3 }}>
            Emergency Dispatch Active
          </p>
          <p style={{ color: 'var(--text-hi)', fontWeight: 700, fontSize: 16, lineHeight: 1 }}>
            What happened to your vehicle?
          </p>
        </div>
      </div>

      {/* ── Fault grid ── */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '0 14px 10px', position: 'relative', zIndex: 1 }}>
        <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr 1fr', gap: 10 }}>
          {FAULTS.map((fault, idx) => (
            <button
              key={fault.id}
              onClick={() => pick(fault)}
              className="sos-card"
              style={{
                background: 'var(--surface-2)',
                border: '1.5px solid var(--border-2)',
                borderRadius: 18, padding: '0 16px',
                display: 'flex', flexDirection: 'column',
                alignItems: 'flex-start', justifyContent: 'center',
                gap: 10, cursor: 'pointer', textAlign: 'left', minHeight: 0,
                // Only animate once overlay starts fading
                animation: showContent
                  ? `card-pop 0.4s cubic-bezier(0.34,1.56,0.64,1) ${idx * 0.07}s both`
                  : 'none',
                opacity: showContent ? undefined : 0,
              }}
              onMouseEnter={e => {
                const el = e.currentTarget;
                el.style.background = `${R}12`;
                el.style.borderColor = `${R}55`;
                el.style.transform = 'scale(1.03)';
                el.style.boxShadow = `0 6px 24px ${R}18`;
              }}
              onMouseLeave={e => {
                const el = e.currentTarget;
                el.style.background = 'var(--surface-2)';
                el.style.borderColor = 'var(--border-2)';
                el.style.transform = 'scale(1)';
                el.style.boxShadow = 'none';
              }}
            >
              <div style={{ width: 44, height: 44, borderRadius: 12, flexShrink: 0, background: `${Y}14`, border: `1.5px solid ${Y}38`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <fault.Icon style={{ width: 22, height: 22, color: Y }} />
              </div>
              <div>
                <p style={{ color: 'var(--text-hi)', fontWeight: 800, fontSize: 13, lineHeight: 1.2, marginBottom: 3 }}>{fault.label}</p>
                <p style={{ color: 'var(--text-dim)', fontSize: 10.5, lineHeight: 1.35 }}>{fault.desc}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ── AI footer ── */}
      <div style={{
        flexShrink: 0, padding: '10px 14px',
        paddingBottom: 'max(calc(env(safe-area-inset-bottom, 0px) + 76px), 84px)',
        borderTop: '1px solid var(--border-1)',
        background: 'var(--overlay-bg)', backdropFilter: 'blur(20px)',
        position: 'relative', zIndex: 1,
      }}>
        <button
          onClick={() => navigate('/fault-chat', { state: { issueType: 'other' } })}
          className="sos-ai-btn"
          style={{
            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            padding: '13px 20px', borderRadius: 14,
            background: `linear-gradient(135deg, ${Y}, ${YD})`,
            border: 'none', cursor: 'pointer',
            boxShadow: `0 0 0 3px ${Y}22, 0 6px 24px ${Y}30`,
          }}
          onMouseEnter={e => {
            const el = e.currentTarget;
            el.style.background = `linear-gradient(135deg, #FBBF24, ${Y})`;
            el.style.boxShadow = `0 0 0 4px ${Y}33, 0 8px 32px ${Y}45`;
            el.style.transform = 'scale(1.015)';
          }}
          onMouseLeave={e => {
            const el = e.currentTarget;
            el.style.background = `linear-gradient(135deg, ${Y}, ${YD})`;
            el.style.boxShadow = `0 0 0 3px ${Y}22, 0 6px 24px ${Y}30`;
            el.style.transform = 'scale(1)';
          }}
        >
          <Sparkles style={{ width: 18, height: 18, color: '#000' }} />
          <div style={{ textAlign: 'left' }}>
            <p style={{ color: '#000', fontWeight: 800, fontSize: 13, lineHeight: 1 }}>Not sure? Let AI diagnose first</p>
            <p style={{ color: 'var(--text-lo)', fontSize: 10.5, marginTop: 2 }}>MOTOFIX AI will ask a few questions</p>
          </div>
        </button>
      </div>

      <style>{`
        @keyframes sos-ring {
          0%   { transform: scale(1);   opacity: 0.35; }
          70%  { transform: scale(2.6); opacity: 0; }
          100% { opacity: 0; }
        }
        @keyframes card-pop {
          0%   { opacity: 0; transform: translateY(14px) scale(0.96); }
          60%  { opacity: 1; transform: translateY(-3px) scale(1.01); }
          100% { opacity: 1; transform: translateY(0)    scale(1); }
        }
        @keyframes wlc-ring {
          0%   { transform: translate(-50%,-50%) scale(0.7); opacity: 0.8; }
          80%  { transform: translate(-50%,-50%) scale(2.2); opacity: 0; }
          100% { opacity: 0; }
        }
        @keyframes wlc-icon {
          0%   { opacity: 0; transform: translateY(8px) scale(0.9); }
          100% { opacity: 1; transform: translateY(0)   scale(1);   }
        }
        @keyframes wlc-bar {
          from { width: 0%; }
          to   { width: 100%; }
        }
        @keyframes wlc-fade-in  { from { opacity: 0; } to { opacity: 1; } }
        @keyframes wlc-fade-out { from { opacity: 1; } to { opacity: 0; } }
        .sos-card {
          transition: background 0.2s ease, border-color 0.2s ease,
                      transform 0.2s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.2s ease;
        }
        .sos-ai-btn {
          transition: background 0.2s ease, box-shadow 0.2s ease,
                      transform 0.2s cubic-bezier(0.34,1.56,0.64,1);
        }
      `}</style>
    </div>

    {/* ── Welcome overlay — sibling to main div so zIndex: 60 is global, above BottomNav (50) ── */}
    {overlayPhase !== 'gone' && (
      <div style={{
        animation: overlayPhase === 'fading' ? `wlc-fade-out ${FADE_DURATION}ms ease both` : 'wlc-fade-in 0.4s ease both',
        position: 'fixed', inset: 0, zIndex: 60,
      }}>
        <WelcomeOverlay />
      </div>
    )}

    {showFuelFlow && <OutOfFuelFlow onClose={() => setShowFuelFlow(false)} />}
    </>
  );
}
