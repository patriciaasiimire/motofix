// Home.tsx — the main landing screen after login. Shows a time-of-day greeting, the
// big "get help" actions (mechanic, roadside assist / tow, spare parts, car wash),
// any active request, and quick links. The hub everything branches from.

import { useNavigate } from 'react-router-dom';
import { useRequests } from '@/contexts/RequestContext';
import { useAuth } from '@/hooks/useAuth';
import { useRotatingGreeting } from '@/hooks/useRotatingGreeting';
import { useTheme } from '@/contexts/ThemeContext';
import {
  Truck, Wrench, AlertTriangle,
  MapPin, ChevronRight, Phone, RefreshCw,
  Loader2,
  TrendingUp, Star, Droplets,
  User, LogOut, SlidersHorizontal,
  X,
  Sun, Moon, Bell, ShoppingBag,
} from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { requestsService } from '@/config/api';
import { useNotifications } from '@/hooks/useNotifications';
import BackLogoutGuard from '@/components/BackLogoutGuard';
import { toast } from 'sonner';

/* ── All services (editorial list) ────────────────────────── */
const ALL_SERVICES = [
  { id: 'mechanic',   label: 'Mechanic & Repair', icon: Wrench,     color: '#F59E0B', desc: 'On-site assist — engine, tyres, battery, electrical' },
  { id: 'breakdown',  label: 'Roadside assist / tow', icon: Truck, color: '#60A5FA', desc: 'First aid on the road, or tow to a garage if needed' },
  { id: 'spare_parts', label: 'Spare Parts & Self-Fix', icon: ShoppingBag, color: '#A78BFA', desc: 'Find dealers · order parts to fix it yourself' },
  { id: 'car_wash',   label: 'Car Wash', icon: Droplets, color: '#22D3EE', desc: 'Mobile wash at your location' },
];

/* ── Status config ─────────────────────────────────────────── */
const STATUS: Record<string, { label: string; color: string; lightColor: string; bg: string; border: string }> = {
  searching:   { label: 'Searching',   color: '#F59E0B', lightColor: '#92620A', bg: 'rgba(245,158,11,0.12)',  border: 'rgba(245,158,11,0.3)'  },
  assigned:    { label: 'Assigned',    color: '#60A5FA', lightColor: '#1D4ED8', bg: 'rgba(96,165,250,0.12)',  border: 'rgba(96,165,250,0.3)'  },
  pending:     { label: 'Pending',     color: '#F59E0B', lightColor: '#92620A', bg: 'rgba(245,158,11,0.12)',  border: 'rgba(245,158,11,0.3)'  },
  accepted:    { label: 'Accepted',    color: '#60A5FA', lightColor: '#1D4ED8', bg: 'rgba(96,165,250,0.12)',  border: 'rgba(96,165,250,0.3)'  },
  in_progress: { label: 'In Progress', color: '#34D399', lightColor: '#065F46', bg: 'rgba(52,211,153,0.12)',  border: 'rgba(52,211,153,0.3)'  },
  completed:   { label: 'Completed',   color: '#4ADE80', lightColor: '#15803D', bg: 'rgba(74,222,128,0.12)',  border: 'rgba(74,222,128,0.3)'  },
  cancelled:   { label: 'Cancelled',   color: '#F87171', lightColor: '#991B1B', bg: 'rgba(248,113,113,0.12)', border: 'rgba(248,113,113,0.3)' },
};

function greeting(name?: string) {
  // Always use Uganda time (EAT = UTC+3)
  const ugHour = parseInt(
    new Date().toLocaleString('en-US', { timeZone: 'Africa/Kampala', hour: 'numeric', hour12: false }),
    10
  );
  const period = ugHour < 12 ? 'morning' : ugHour < 17 ? 'afternoon' : 'evening';
  const question = ugHour < 12 ? 'Having a rough morning?' : ugHour < 17 ? 'Having a rough afternoon?' : 'Having a rough evening?';
  const firstName = name?.split(' ')[0] ?? 'Driver';
  const initials = name
    ? name.split(' ').slice(0, 3).map(w => w[0]).join('').toUpperCase()
    : 'DR';
  return { period, question, firstName, initials };
}

export default function Home() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { theme, toggleTheme, isDark } = useTheme();
  const { requests, isLoading, error, isWsConnected, refresh } = useRequests();
  const { unread: unreadNotifs } = useNotifications();
  const [callingId, setCallingId] = useState<string | null>(null);
  const [hoveredService, setHoveredService] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [breakdownPrompt, setBreakdownPrompt] = useState(false);
  const [bdFix, setBdFix] = useState(true);
  const [bdTow, setBdTow] = useState(true);
  const [sosBlocked,    setSosBlocked]    = useState(false);
  const [pendingReview, setPendingReview] = useState<{
    requestId: string;
    mechanicName: string;
    mechanicId?: string | number;
    serviceType?: string;
    description?: string;
  } | null>(null);
  const sosSheetRef  = useRef<HTMLDivElement>(null);
  const sosDragRef   = useRef({ startY: 0, dragging: false, delta: 0 });

  const sosDragStart = (clientY: number) => {
    sosDragRef.current = { startY: clientY, dragging: true, delta: 0 };
    if (sosSheetRef.current) sosSheetRef.current.style.transition = 'none';
  };
  const sosDragMove = (clientY: number) => {
    if (!sosDragRef.current.dragging || !sosSheetRef.current) return;
    const delta = Math.max(0, clientY - sosDragRef.current.startY);
    sosDragRef.current.delta = delta;
    sosSheetRef.current.style.transform = `translateY(${delta}px)`;
    sosSheetRef.current.style.opacity   = String(Math.max(0, 1 - delta / 250));
  };
  const sosDragEnd = () => {
    if (!sosDragRef.current.dragging || !sosSheetRef.current) return;
    sosDragRef.current.dragging = false;
    const el = sosSheetRef.current;
    if (sosDragRef.current.delta > 90) {
      el.style.transition = 'transform 0.22s ease, opacity 0.22s ease';
      el.style.transform  = 'translateY(100%)';
      el.style.opacity    = '0';
      setTimeout(() => setSosBlocked(false), 220);
    } else {
      el.style.transition = 'transform 0.32s cubic-bezier(0.34,1.56,0.64,1), opacity 0.22s ease';
      el.style.transform  = 'translateY(0)';
      el.style.opacity    = '1';
      setTimeout(() => { if (sosSheetRef.current) sosSheetRef.current.style.transition = ''; }, 320);
    }
  };


  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('motofix_pending_review');
      if (raw) setPendingReview(JSON.parse(raw));
    } catch {
      // Ignore malformed saved review data so it cannot block the home screen.
    }
  }, []);

  const dismissReview = () => {
    sessionStorage.removeItem('motofix_pending_review');
    setPendingReview(null);
  };

  const active    = requests.filter(r => ['searching', 'assigned'].includes(r.status));
  const activeReq = active[0] ?? null;          // drivers may have at most 1 active request
  const hasActive = !!activeReq;
  const history   = requests.filter(r =>  ['completed', 'cancelled'].includes(r.status));
  const completedJobs = history.filter(r => r.status === 'completed');
  const completed = completedJobs.length;
  const { firstName, initials } = greeting(user?.full_name);
  const question = useRotatingGreeting();

  const goHelpAgain = () => {
    if (hasActive) {
      navigate(`/requests/${activeReq.id}`);
      return;
    }
    navigate('/get-help');
  };

  const goRequest = (issueType?: string, breakdownPrefs?: { fixOnSpot: boolean; allowTow: boolean }) => {
    if (hasActive) {
      navigate(`/requests/${activeReq.id}`);
      return;
    }
    // All roadside/tow requests use the v1 area-based flow; car wash remains separate.
    if (issueType !== 'car_wash') {
      navigate('/get-help');
      return;
    }
    const serviceType = issueType === 'towing' ? 'towing_provider' : issueType === 'breakdown' ? 'both' : 'mechanic';
    navigate('/locating', { state: { issueType, serviceType, breakdownPrefs } });
  };

  const callMechanic = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setCallingId(id);
    try {
      const res = await requestsService.getCallPartner(id);
      if (res.data.phone) window.location.href = `tel:${res.data.phone}`;
    } catch { toast.error('Unable to call mechanic right now'); }
    finally { setCallingId(null); }
  };


  if (isLoading) return (
    <div className="min-h-screen bg-background pb-24">
      <div className="px-4 pt-12 max-w-md mx-auto space-y-5 animate-pulse">
        <div className="h-12 bg-white/6 rounded-xl w-56" />
        <div className="h-28 bg-white/4 rounded-3xl" />
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => <div key={i} className="h-14 bg-white/4 rounded-2xl" />)}
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background pb-28 overflow-x-hidden">
      <BackLogoutGuard onLogout={() => { logout(); navigate('/login'); }} />
      <div className="px-4 max-w-md mx-auto">

        {/* ── Breakdown Rescue pre-flight (asked before location) ── */}
        {breakdownPrompt && (
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }} onClick={() => setBreakdownPrompt(false)} />
            <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 70, width: 'min(92vw, 360px)', borderRadius: 24, background: 'var(--overlay-bg)', border: '1px solid var(--border-3)', boxShadow: '0 24px 70px rgba(0,0,0,0.7)', overflow: 'hidden' }}>
              {/* header */}
              <div style={{ padding: '24px 22px 6px', textAlign: 'center' }}>
                <div style={{ width: 56, height: 56, borderRadius: 17, margin: '0 auto 14px', background: 'rgba(245,158,11,0.14)', border: '1.5px solid rgba(245,158,11,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 24px rgba(245,158,11,0.18)' }}>
                  <Truck style={{ width: 27, height: 27, color: '#F59E0B' }} />
                </div>
                <p style={{ color: 'var(--text-hi)', fontWeight: 900, fontSize: 19, marginBottom: 6 }}>Roadside assist or tow</p>
                <p style={{ color: 'var(--text-lo)', fontSize: 12.5, lineHeight: 1.55, padding: '0 4px' }}>Two quick questions so we send the right help and agree the plan with you.</p>
              </div>
              {/* questions */}
              <div style={{ padding: '16px 18px 4px' }}>
                {[
                  { key: 'fix', q: '🔧 Try on-site assist first?', val: bdFix, set: setBdFix, yes: 'Yes, assist on site', no: 'No, just tow' },
                  { key: 'tow', q: '🚛 OK to tow it to a garage if on-site assist isn’t enough?', val: bdTow, set: setBdTow, yes: 'Yes, tow it', no: 'No' },
                ].map(({ key, q, val, set, yes, no }) => (
                  <div key={key} style={{ background: 'var(--surface-1)', border: '1px solid var(--border-2)', borderRadius: 16, padding: '13px 13px 14px', marginBottom: 12 }}>
                    <p style={{ color: 'var(--text-md)', fontSize: 13, fontWeight: 700, marginBottom: 11, lineHeight: 1.4 }}>{q}</p>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button onClick={() => set(true)} style={{ flex: 1, padding: '11px 0', borderRadius: 12, cursor: 'pointer', fontSize: 13, fontWeight: 800, border: val ? '2px solid #F59E0B' : '1.5px solid var(--border-3)', background: val ? 'rgba(245,158,11,0.16)' : 'transparent', color: val ? '#F59E0B' : 'var(--text-faint)', transition: 'all 0.15s' }}>{yes}</button>
                      <button onClick={() => set(false)} style={{ flex: 1, padding: '11px 0', borderRadius: 12, cursor: 'pointer', fontSize: 13, fontWeight: 800, border: !val ? '2px solid #EF4444' : '1.5px solid var(--border-3)', background: !val ? 'rgba(239,68,68,0.14)' : 'transparent', color: !val ? '#EF4444' : 'var(--text-faint)', transition: 'all 0.15s' }}>{no}</button>
                    </div>
                  </div>
                ))}
              </div>
              {/* actions */}
              <div style={{ display: 'flex', gap: 10, padding: '6px 18px 20px' }}>
                <button onClick={() => setBreakdownPrompt(false)} style={{ flexShrink: 0, padding: '13px 18px', borderRadius: 14, border: '1px solid var(--border-3)', background: 'var(--surface-3)', color: 'var(--text-lo)', fontWeight: 700, fontSize: 13.5, cursor: 'pointer' }}>Cancel</button>
                <button onClick={() => { setBreakdownPrompt(false); goRequest('breakdown', { fixOnSpot: bdFix, allowTow: bdTow }); }} style={{ flex: 1, padding: '13px 0', borderRadius: 14, border: 'none', background: 'linear-gradient(135deg, #F59E0B, #D97706)', color: '#fff', fontWeight: 800, fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, boxShadow: '0 8px 22px rgba(245,158,11,0.35)' }}>Find help <ChevronRight style={{ width: 17, height: 17 }} /></button>
              </div>
            </div>
          </>
        )}

        {/* ── SOS blocked — active request warning ── */}
        {sosBlocked && activeReq && (() => {
          const Y = '#F59E0B', YD = '#D97706';
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
            <>
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(8px)' }}
                onClick={() => setSosBlocked(false)}
              />
              <div
                ref={sosSheetRef}
                onTouchStart={e => sosDragStart(e.touches[0].clientY)}
                onTouchMove={e  => sosDragMove(e.touches[0].clientY)}
                onTouchEnd={sosDragEnd}
                onMouseDown={e  => sosDragStart(e.clientY)}
                onMouseMove={e  => { if (sosDragRef.current.dragging) sosDragMove(e.clientY); }}
                onMouseUp={sosDragEnd}
                onMouseLeave={sosDragEnd}
                style={{
                  position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 80,
                  maxWidth: 480, margin: '0 auto',
                  borderRadius: '24px 24px 0 0',
                  background: 'var(--overlay-bg)',
                  border: `1px solid ${Y}28`,
                  boxShadow: `0 -12px 60px rgba(0,0,0,0.7), 0 0 0 1px ${Y}14`,
                  padding: '28px 24px',
                  paddingBottom: 'max(calc(env(safe-area-inset-bottom, 0px) + 24px), 32px)',
                  animation: 'sos-blk-slide-up 0.36s cubic-bezier(0.34,1.56,0.64,1)',
                  touchAction: 'none',
                  userSelect: 'none',
                  willChange: 'transform',
                }}>
                {/* Drag handle */}
                <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border-4)', margin: '0 auto 24px', cursor: 'grab' }} />

                {/* Icon */}
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
                  <div style={{ position: 'relative' }}>
                    {[80, 56].map((size, i) => (
                      <div key={size} style={{
                        position: 'absolute', top: '50%', left: '50%',
                        width: size, height: size, borderRadius: '50%',
                        border: `1.5px solid ${Y}${i === 0 ? '18' : '30'}`,
                        transform: 'translate(-50%,-50%)',
                        animation: `sos-blk-ring ${1.8 + i * 0.5}s ease-out ${i * 0.3}s infinite`,
                      }} />
                    ))}
                    <div style={{
                      width: 72, height: 72, borderRadius: '50%',
                      background: `${Y}18`, border: `2px solid ${Y}55`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      boxShadow: `0 0 32px ${Y}28`, position: 'relative',
                    }}>
                      <AlertTriangle style={{ width: 34, height: 34, color: Y }} />
                    </div>
                  </div>
                </div>

                {/* Text */}
                <p style={{ color: Y, fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.2em', textAlign: 'center', marginBottom: 10 }}>
                  Request Active
                </p>
                <h2 style={{ color: 'var(--text-hi)', fontWeight: 900, fontSize: 20, textAlign: 'center', letterSpacing: '-0.02em', lineHeight: 1.2, marginBottom: 10 }}>
                  You already have a request in progress
                </h2>
                <p style={{ color: 'var(--text-lo)', fontSize: 13, textAlign: 'center', lineHeight: 1.65, marginBottom: 14 }}>
                  You cannot place another service request. Please complete or cancel the current one first.
                </p>

                {/* Status pill */}
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 28 }}>
                  <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: 8,
                    padding: '7px 16px', borderRadius: 9999,
                    background: `${Y}14`, border: `1.5px solid ${Y}40`,
                  }}>
                    <div style={{ width: 7, height: 7, borderRadius: '50%', background: Y, animation: 'sos-blk-dot 1.4s ease-in-out infinite' }} />
                    <span style={{ fontSize: 12, fontWeight: 700, color: Y }}>{label}</span>
                  </div>
                </div>

                {/* Buttons */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <button
                    onClick={() => { setSosBlocked(false); navigate(`/requests/${activeReq.id}`); }}
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
                    onClick={() => setSosBlocked(false)}
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
                  @keyframes sos-blk-slide-up {
                    from { transform: translateY(100%); }
                    to   { transform: translateY(0); }
                  }
                  @keyframes sos-blk-ring {
                    0%   { transform: translate(-50%,-50%) scale(0.8); opacity: 0.8; }
                    80%  { transform: translate(-50%,-50%) scale(2.2); opacity: 0; }
                    100% { opacity: 0; }
                  }
                  @keyframes sos-blk-dot {
                    0%,100% { opacity: 1; transform: scale(1); }
                    50%     { opacity: 0.4; transform: scale(0.6); }
                  }
                `}</style>
              </div>
            </>
          );
        })()}

        {/* ── Top bar ── */}
        <div className="flex items-center justify-between pt-8 pb-2">
          {/* Left — plate + status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {user?.number_plate && (
              <div
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold"
                style={{
                  background: '#F59E0B', color: '#000', letterSpacing: '0.05em', cursor: 'default',
                  transition: 'background 0.2s ease, box-shadow 0.2s ease, transform 0.15s ease',
                }}
                onMouseEnter={e => {
                  const el = e.currentTarget;
                  el.style.background = '#FBBF24';
                  el.style.boxShadow = '0 0 14px rgba(251,191,36,0.45)';
                  el.style.transform = 'scale(1.06)';
                }}
                onMouseLeave={e => {
                  const el = e.currentTarget;
                  el.style.background = '#F59E0B';
                  el.style.boxShadow = 'none';
                  el.style.transform = 'scale(1)';
                }}
              >
                {user.number_plate}
              </div>
            )}
          </div>

          {/* Right — theme capsule + profile avatar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>

          {/* Theme capsule toggle */}
          <button
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            style={{
              position: 'relative',
              width: 56, height: 28,
              borderRadius: 999,
              background: theme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)',
              border: '1px solid var(--border-3)',
              cursor: 'pointer',
              padding: 0,
              flexShrink: 0,
              transition: 'background 0.25s ease, border-color 0.25s ease',
            }}
          >
            {/* Sun icon — left side */}
            <Sun style={{
              position: 'absolute', left: 7, top: '50%', transform: 'translateY(-50%)',
              width: 12, height: 12,
              color: theme === 'light' ? '#F59E0B' : 'var(--text-md)',
              transition: 'color 0.25s ease',
            }} />
            {/* Moon icon — right side */}
            <Moon style={{
              position: 'absolute', right: 7, top: '50%', transform: 'translateY(-50%)',
              width: 12, height: 12,
              color: theme === 'dark' ? '#818cf8' : 'var(--text-md)',
              transition: 'color 0.25s ease',
            }} />
            {/* Sliding knob */}
            <span style={{
              position: 'absolute',
              top: 3, bottom: 3,
              width: 22,
              borderRadius: 999,
              background: theme === 'dark' ? '#818cf8' : '#F59E0B',
              left: theme === 'dark' ? 'calc(100% - 25px)' : '3px',
              transition: 'left 0.25s cubic-bezier(0.34,1.56,0.64,1), background 0.25s ease',
              boxShadow: theme === 'dark' ? '0 0 8px rgba(129,140,248,0.5)' : '0 0 8px rgba(245,158,11,0.5)',
            }} />
          </button>

          {/* Notifications bell */}
          <button
            onClick={() => navigate('/notifications')}
            title="Notifications"
            style={{
              position: 'relative', width: 38, height: 38, borderRadius: '50%',
              border: '1px solid var(--border-3)', background: 'var(--surface-2)',
              color: 'var(--text-md)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', cursor: 'pointer', flexShrink: 0,
              transition: 'background 0.18s ease',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface-4)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface-2)'; }}
          >
            <Bell style={{ width: 17, height: 17 }} />
            {unreadNotifs > 0 && (
              <span style={{
                position: 'absolute', top: -3, right: -3, minWidth: 17, height: 17,
                padding: '0 4px', borderRadius: 999, background: '#EF4444', color: '#fff',
                fontSize: 10, fontWeight: 800, display: 'flex', alignItems: 'center',
                justifyContent: 'center', border: '2px solid var(--page-bg)',
              }}>{unreadNotifs > 9 ? '9+' : unreadNotifs}</span>
            )}
          </button>

          {/* Profile avatar */}
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setDropdownOpen(o => !o)}
              style={{
                width: 38, height: 38, borderRadius: '50%', cursor: 'pointer',
                background: 'linear-gradient(135deg, #F59E0B, #D97706)',
                border: '2px solid rgba(245,158,11,0.4)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 0 0 3px rgba(245,158,11,0.12)',
                fontSize: 13, fontWeight: 900, color: '#000', letterSpacing: '0.04em',
                transition: 'background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease, transform 0.15s ease',
              }}
              onMouseEnter={e => {
                const b = e.currentTarget;
                b.style.background = 'linear-gradient(135deg, #FBBF24, #F59E0B)';
                b.style.borderColor = 'rgba(251,191,36,0.8)';
                b.style.boxShadow = '0 0 0 4px rgba(251,191,36,0.25), 0 0 18px rgba(245,158,11,0.4)';
                b.style.transform = 'scale(1.08)';
              }}
              onMouseLeave={e => {
                const b = e.currentTarget;
                b.style.background = 'linear-gradient(135deg, #F59E0B, #D97706)';
                b.style.borderColor = 'rgba(245,158,11,0.4)';
                b.style.boxShadow = '0 0 0 3px rgba(245,158,11,0.12)';
                b.style.transform = 'scale(1)';
              }}
            >
              {initials}
            </button>

            {/* Dropdown */}
            {dropdownOpen && (
              <>
                {/* Backdrop to close */}
                <div
                  style={{ position: 'fixed', inset: 0, zIndex: 40 }}
                  onClick={() => setDropdownOpen(false)}
                />
                <div style={{
                  position: 'absolute', top: 46, right: 0, zIndex: 50,
                  width: 200,
                  background: 'var(--overlay-bg)',
                  border: '1px solid var(--border-3)',
                  borderRadius: 16,
                  boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
                  overflow: 'hidden',
                }}>
                  {/* Driver info header */}
                  <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--border-2)' }}>
                    <p style={{ color: 'var(--text-hi)', fontWeight: 800, fontSize: 14, lineHeight: 1 }}>{user?.full_name ?? 'Driver'}</p>
                    <p style={{ color: 'rgba(245,158,11,0.7)', fontSize: 11, marginTop: 3 }}>{user?.phone}</p>
                  </div>
                  {/* Menu items */}
                  {[
                    { label: 'My Profile',  icon: User,             action: () => { setDropdownOpen(false); navigate('/profile'); } },
                    { label: 'Settings',    icon: SlidersHorizontal, action: () => { setDropdownOpen(false); navigate('/settings'); } },
                    { label: 'Refresh',     icon: RefreshCw,         action: () => { setDropdownOpen(false); window.location.reload(); } },
                  ].map(({ label, icon: Icon, action }) => (
                    <button
                      key={label}
                      onClick={action}
                      className="w-full flex items-center gap-3 transition-colors"
                      style={{
                        padding: '11px 16px', cursor: 'pointer', border: 'none',
                        background: 'transparent', textAlign: 'left',
                        borderBottom: '1px solid var(--border-1)',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-3)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <Icon style={{ width: 15, height: 15, color: 'var(--text-lo)', flexShrink: 0 }} />
                      <span style={{ color: 'var(--text-md)', fontSize: 13, fontWeight: 600 }}>{label}</span>
                    </button>
                  ))}
                  {/* Logout — red tint */}
                  <button
                    onClick={() => { setDropdownOpen(false); logout(); navigate('/login'); }}
                    className="w-full flex items-center gap-3 transition-colors"
                    style={{ padding: '11px 16px', cursor: 'pointer', border: 'none', background: 'transparent', textAlign: 'left' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(239,68,68,0.08)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <LogOut style={{ width: 15, height: 15, color: '#f87171', flexShrink: 0 }} />
                    <span style={{ color: '#f87171', fontSize: 13, fontWeight: 600 }}>Logout</span>
                  </button>
                </div>
              </>
            )}
          </div>
          </div>{/* end theme capsule + avatar flex */}
        </div>

        {/* ── Editorial headline ── */}
        <div style={{ paddingTop: 20, paddingBottom: 22 }}>
          <p className="mf-brand-label" style={{ color: 'rgba(245,158,11,0.75)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.22em', fontWeight: 700, marginBottom: 6 }}>
            MOTOFIX · Roadside Assistance
          </p>
          <h1 style={{
            color: 'var(--text-hi)',
            fontWeight: 900,
            fontSize: 38,
            letterSpacing: '-0.03em',
            lineHeight: 1.0,
            marginBottom: 10,
          }}>
            <span className="mf-headline-question" style={{ color: '#ff2d2d', textShadow: '0 0 40px rgba(255,45,45,0.3)' }}>{question}</span>
            <br /><span className="mf-headline-name" style={{ display: 'inline-block', marginTop: 6, color: 'var(--text-hi)' }}>{firstName.toUpperCase()}.</span>
          </h1>
        </div>

        {/* ── Rate mechanic nudge banner ── */}
        {pendingReview && (
          <div style={{
            borderRadius: 18,
            background: 'rgba(245,158,11,0.09)',
            border: '1.5px solid rgba(245,158,11,0.35)',
            padding: '14px 16px',
            marginBottom: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}>
            <div style={{ width: 38, height: 38, borderRadius: 12, background: 'rgba(245,158,11,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Star style={{ width: 18, height: 18, color: '#F59E0B', fill: '#F59E0B' }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-hi)', marginBottom: 2 }}>
                How was {pendingReview.mechanicName}?
              </p>
              <p style={{ fontSize: 11, color: 'var(--text-lo)', lineHeight: 1.4 }}>
                A quick rating helps us match you with the best mechanics.
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              <button
                onClick={() => {
                  dismissReview();
                  navigate('/rate-motofix', { state: pendingReview });
                }}
                style={{ height: 34, padding: '0 12px', borderRadius: 10, border: 'none', background: '#F59E0B', color: '#111', fontSize: 12, fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap' }}
              >
                Rate now
              </button>
              <button
                onClick={dismissReview}
                style={{ width: 34, height: 34, borderRadius: 10, border: '1px solid var(--border-3)', background: 'var(--surface-3)', color: 'var(--text-faint)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}
                aria-label="Dismiss"
              >
                <X style={{ width: 14, height: 14 }} />
              </button>
            </div>
          </div>
        )}

        {/* ── Active request — only shown when there's a live job ── */}
        {(() => {
          if (!activeReq) return null;
          const st = STATUS[activeReq.status] ?? STATUS.pending;
          return (
            <div className="mb-5" style={{ position: 'relative' }}>
              <div
                onClick={() => navigate(`/requests/${activeReq.id}`)}
                style={{
                  position: 'relative',
                  borderRadius: 22,
                  background: isDark ? st.bg : 'var(--surface-1)',
                  border: `1.5px solid ${isDark ? st.border : '#000'}`,
                  boxShadow: isDark ? `0 0 28px ${st.bg}` : 'none',
                  padding: '18px 20px',
                  display: 'flex', alignItems: 'center', gap: 16,
                  cursor: 'pointer',
                  transition: 'background 0.2s ease, border-color 0.2s ease, transform 0.15s ease',
                }}
                onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.012)'; }}
                onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
              >
                <div style={{
                  position: 'absolute', top: -9, right: -9,
                  width: 22, height: 22, borderRadius: '50%',
                  background: '#dc2626',
                  border: '2.5px solid var(--page-bg)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, fontWeight: 900, color: '#fff',
                  boxShadow: '0 0 8px rgba(220,38,38,0.5)',
                }}>
                  1
                </div>
                <div style={{
                  width: 52, height: 52, borderRadius: 16, flexShrink: 0,
                  background: `${isDark ? st.color : st.lightColor}18`,
                  border: `1.5px solid ${isDark ? st.color + '40' : st.lightColor + '60'}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Wrench style={{ width: 24, height: 24, color: isDark ? st.color : st.lightColor }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ color: 'var(--text-hi)', fontWeight: 800, fontSize: 15, lineHeight: 1 }}>Active Request</p>
                  <p style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 5, lineHeight: 1.4 }}>
                    <span style={{ color: isDark ? st.color : st.lightColor, fontWeight: 700 }}>{st.label}</span> — {activeReq.service_type} · tap to view
                  </p>
                </div>
                <ChevronRight style={{ width: 20, height: 20, color: st.color + '80', flexShrink: 0 }} />
              </div>
            </div>
          );
        })()}

        {/* ── Returning driver: Get help again (skips FaultChat / DescribeIssue) ── */}
        {completed >= 1 && (
          <div
            onClick={goHelpAgain}
            className="relative rounded-3xl overflow-hidden mb-3"
            style={{
              background: 'linear-gradient(135deg, #F59E0B, #D97706)',
              boxShadow: '0 10px 32px rgba(245,158,11,0.35)',
              border: isDark ? '1.5px solid rgba(251,191,36,0.45)' : '1.5px solid #000',
              cursor: 'pointer',
            }}
          >
            <div className="relative flex items-center justify-between px-6 py-5">
              <div>
                <p style={{ color: 'rgba(17,24,39,0.72)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.22em', fontWeight: 700, marginBottom: 6 }}>
                  Faster than WhatsApp
                </p>
                <p style={{ color: '#111827', fontWeight: 900, fontSize: 26, letterSpacing: '-0.02em', lineHeight: 1 }}>Get help again</p>
                <p style={{ color: 'rgba(17,24,39,0.78)', fontSize: 11, marginTop: 6, lineHeight: 1.45, maxWidth: 240 }}>
                  Request a mechanic or tow · choose your area
                </p>
              </div>
              <ChevronRight style={{ width: 22, height: 22, color: '#111827', flexShrink: 0 }} />
            </div>
          </div>
        )}

        {completed >= 1 && (
          <button
            onClick={() => goRequest()}
            style={{
              width: '100%', marginBottom: 16, padding: '12px 16px', borderRadius: 16,
              border: isDark ? '1px solid var(--border-3)' : '1.5px solid #000',
              background: 'var(--surface-1)', color: 'var(--text-md)',
              fontSize: 13, fontWeight: 700, cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            New request — choose a mechanic or tow
          </button>
        )}

        {/* ── SOS hero block — first-time / no completed jobs ── */}
        {completed < 1 && (
        <div
          onClick={() => goRequest()}
          className="relative rounded-3xl overflow-hidden mb-5"
          style={{
            background: 'var(--sos-bg)',
            boxShadow: 'var(--sos-shadow)',
            border: isDark ? '1.5px solid var(--sos-border-color)' : '1.5px solid #000',
            cursor: 'pointer',
            transition: 'background 0.2s ease, box-shadow 0.2s ease, transform 0.15s ease',
          }}
          onMouseEnter={e => {
            const el = e.currentTarget;
            el.style.background = 'var(--sos-hover-bg)';
            el.style.boxShadow = 'var(--sos-hover-shadow)';
            el.style.transform = 'scale(1.015)';
          }}
          onMouseLeave={e => {
            const el = e.currentTarget;
            el.style.background = 'var(--sos-bg)';
            el.style.boxShadow = 'var(--sos-shadow)';
            el.style.transform = 'scale(1)';
          }}
        >
          {/* Top sheen — dark mode only */}
          {isDark && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1, background: 'var(--border-4)' }} />}

          <div className="relative flex items-center justify-between px-6 py-5">
            <div>
              <p style={{ color: 'var(--sos-label)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.22em', fontWeight: 700, marginBottom: 6, textShadow: 'var(--sos-text-shadow)' }}>
                Request roadside help
              </p>
              <p style={{ color: 'var(--sos-title)', fontWeight: 900, fontSize: 32, letterSpacing: '0.06em', lineHeight: 1, textShadow: 'var(--sos-text-shadow)' }}>GET HELP</p>
              <p style={{ color: 'var(--sos-sub)', fontSize: 11, marginTop: 6, textShadow: 'var(--sos-text-shadow)' }}>
                {hasActive ? '1 request active' : 'Choose a mechanic or tow'}
              </p>
            </div>
            {/* Target rings */}
            <div style={{ position: 'relative', width: 64, height: 64, flexShrink: 0 }}>
              {[64, 48].map((s, i) => (
                <div key={i} style={{
                  position: 'absolute', top: '50%', left: '50%',
                  width: s, height: s, borderRadius: '50%',
                  border: `1.5px solid var(${i === 0 ? '--sos-ring-1' : '--sos-ring-2'})`,
                  transform: 'translate(-50%,-50%)',
                  animation: `sosRing ${1.6 + i * 0.5}s ease-out ${i * 0.4}s infinite`,
                }} />
              ))}
              <div style={{
                position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
                width: 36, height: 36, borderRadius: '50%',
                background: 'var(--sos-dot-bg)',
                border: '2px solid var(--sos-dot-border)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <ChevronRight style={{ width: 16, height: 16, color: 'var(--sos-title)' }} />
              </div>
            </div>
          </div>
        </div>
        )}

        {/* ── All services — 4-tile grid ── */}
        <div className="mb-5">
          <p className="mf-label" style={{ color: 'var(--text-md)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.22em', fontWeight: 700, marginBottom: 12 }}>
            Available Services
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {ALL_SERVICES.map(({ id, label, icon: Icon, color, desc }) => {
              const isHovered = hoveredService === id;
              return (
                <div
                  key={id}
                  onClick={() => {
                    if (id === 'spare_parts') navigate('/spare-parts');
                    else if (id === 'breakdown') goRequest('breakdown');
                    else if (id === 'car_wash') goRequest('car_wash');
                    else if (id === 'mechanic' || id === 'towing') goRequest(id);
                  }}
                  onMouseEnter={() => setHoveredService(id)}
                  onMouseLeave={() => setHoveredService(null)}
                  style={{
                    position: 'relative',
                    background: isHovered ? `${color}0D` : 'var(--surface-1)',
                    border: isDark ? (isHovered ? `1.5px solid ${color}55` : '1px solid var(--border-2)') : '1px solid #000',
                    borderRadius: 18,
                    padding: '16px 14px',
                    display: 'flex', flexDirection: 'column', gap: 10,
                    cursor: 'pointer',
                    transform: isHovered ? 'scale(1.02)' : 'scale(1)',
                    transition: 'background 0.18s ease, border-color 0.18s ease, transform 0.15s ease',
                  }}
                >
                  <div style={{
                    width: 44, height: 44, borderRadius: 13, flexShrink: 0,
                    background: `${color}18`,
                    border: `1.5px solid ${color}35`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Icon style={{ width: 22, height: 22, color }} />
                  </div>
                  <div>
                    <p style={{ color: 'var(--text-hi)', fontWeight: 800, fontSize: 14, lineHeight: 1.2 }}>{label}</p>
                    <p style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 4, lineHeight: 1.35 }}>{desc}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

      </div>

      <style>{`
        @keyframes sosRing {
          0%   { transform: translate(-50%,-50%) scale(1);   opacity: 0.8; }
          80%  { transform: translate(-50%,-50%) scale(2.1); opacity: 0; }
          100% { opacity: 0; }
        }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.3} }

        /* ── Global hover-brighten rules ── */
        .mf-label {
          transition: color 0.18s ease;
        }
        .mf-label:hover {
          color: var(--text-hi) !important;
        }
        .mf-subtitle {
          transition: color 0.18s ease;
          cursor: default;
        }
        .mf-subtitle:hover {
          color: var(--text-md) !important;
        }
        .mf-stat-card {
          transition: background 0.18s ease, border-color 0.18s ease;
          cursor: default;
        }
        .mf-stat-card:hover {
          background: var(--surface-4) !important;
          border-color: var(--border-3) !important;
        }
        .mf-stat-card:hover span {
          color: var(--text-hi) !important;
        }
        .mf-history-row {
          transition: background 0.15s ease;
        }
        .mf-history-row:hover {
          background: var(--surface-3) !important;
        }
        .mf-history-row:hover p {
          color: var(--text-hi) !important;
        }
        .mf-headline-name {
          transition: color 0.18s ease, text-shadow 0.18s ease;
          cursor: default;
        }
        .mf-headline-name:hover {
          color: var(--text-hi) !important;
        }
        .mf-brand-label {
          transition: color 0.18s ease, text-shadow 0.18s ease;
          cursor: default;
        }
        .mf-brand-label:hover {
          color: #F59E0B !important;
          text-shadow: 0 0 16px rgba(245,158,11,0.55), 0 0 32px rgba(245,158,11,0.25);
        }
        .mf-headline-question {
          transition: color 0.18s ease, text-shadow 0.18s ease;
          cursor: default;
        }
        .mf-headline-question:hover {
          color: #cc1515 !important;
          text-shadow: 0 0 24px rgba(204,21,21,0.65), 0 0 48px rgba(204,21,21,0.35);
        }
      `}</style>

    </div>
  );
}
