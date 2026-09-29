// RequestsList.tsx — the driver's request history screen ("/history"): a list of all
// their past and current service requests (using RequestCard), newest first.

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

function splashDisabled(): boolean {
  try { return JSON.parse(localStorage.getItem('motofix_settings') ?? '{}').disableSplash === true; }
  catch { return false; }
}
import {
  ChevronLeft, RefreshCw, History,
  Clock, CheckCircle2, XCircle, ChevronRight, Inbox,
  ArrowUpDown,
} from 'lucide-react';

type StatusFilter = 'all' | 'completed' | 'cancelled';
type DateSort     = 'newest' | 'oldest';
import { RequestCard } from '@/components/RequestCard';
import { useRequests } from '@/contexts/RequestContext';

/* ── Durations ── */
const WELCOME_DURATION = 3000;
const FADE_DURATION    = 500;
const A  = '#60A5FA';
const Y  = '#F59E0B';

/* ── Welcome overlay ── */
function HistoryOverlay() {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 60,
      backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)',
      background: 'var(--overlay-bg)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: '32px 28px',
    }}>
      <div style={{ position: 'absolute', top: -60, left: '50%', transform: 'translateX(-50%)', width: 320, height: 320, borderRadius: '50%', background: `${A}0a`, filter: 'blur(70px)', pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', bottom: -40, right: -40, width: 240, height: 240, borderRadius: '50%', background: `${A}07`, filter: 'blur(60px)', pointerEvents: 'none' }} />

      <span style={{ color: A, fontSize: 12, fontWeight: 900, letterSpacing: '0.18em', textShadow: `0 0 20px ${A}55`, marginBottom: 28 }}>MOTOFIX</span>

      <div style={{ position: 'relative', width: 86, height: 86, marginBottom: 28 }}>
        {[86, 62].map((s, i) => (
          <div key={s} style={{ position: 'absolute', top: '50%', left: '50%', width: s, height: s, borderRadius: '50%', border: `1.5px solid rgba(96,165,250,${0.18 + i * 0.15})`, transform: 'translate(-50%,-50%)', animation: `hov-ring ${2 + i * 0.7}s ease-out ${i * 0.3}s infinite` }} />
        ))}
        <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: 52, height: 52, borderRadius: 16, background: `linear-gradient(135deg,${A}22,${A}10)`, border: `2px solid ${A}45`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 0 28px ${A}22` }}>
          <History style={{ width: 24, height: 24, color: A }} />
        </div>
      </div>

      <p style={{ color: 'var(--text-hi)', fontWeight: 900, fontSize: 26, textAlign: 'center', letterSpacing: '-0.02em', lineHeight: 1.15, marginBottom: 12 }}>Service History</p>
      <p style={{ color: 'var(--text-lo)', fontSize: 14, textAlign: 'center', lineHeight: 1.65, maxWidth: 290, marginBottom: 36 }}>
        A full record of your completed and cancelled roadside requests — times, mechanics, and outcomes all in one place.
      </p>

      <div style={{ display: 'flex', gap: 12, marginBottom: 36 }}>
        {[History, Clock, CheckCircle2, XCircle, Inbox].map((Icon, i) => (
          <div key={i} style={{ width: 42, height: 42, borderRadius: 12, background: 'var(--surface-3)', border: '1px solid var(--border-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: `hov-icon 0.4s cubic-bezier(0.34,1.56,0.64,1) ${i * 0.07}s both` }}>
            <Icon style={{ width: 18, height: 18, color: 'var(--text-lo)' }} />
          </div>
        ))}
      </div>

      <div style={{ width: '100%', maxWidth: 280, height: 2, borderRadius: 1, background: 'var(--surface-4)', overflow: 'hidden', marginBottom: 16 }}>
        <div style={{ height: '100%', borderRadius: 1, background: `linear-gradient(90deg,${A}aa,${A})`, animation: `hov-bar ${WELCOME_DURATION}ms linear both` }} />
      </div>
      <p style={{ color: 'var(--text-faint)', fontSize: 11 }}>Loading your history…</p>

      <style>{`
        @keyframes hov-ring  { 0%{transform:translate(-50%,-50%) scale(0.7);opacity:.8} 80%{transform:translate(-50%,-50%) scale(2.2);opacity:0} 100%{opacity:0} }
        @keyframes hov-icon  { 0%{opacity:0;transform:translateY(8px) scale(.9)} 100%{opacity:1;transform:translateY(0) scale(1)} }
        @keyframes hov-bar   { from{width:0%} to{width:100%} }
        @keyframes hov-fade-out { from{opacity:1} to{opacity:0} }
      `}</style>
    </div>
  );
}

/* ── Main page ── */
export default function RequestsList() {
  const navigate = useNavigate();
  const { requests, isLoading, error, refresh } = useRequests();

  const [overlayPhase, setOverlayPhase] = useState<'visible' | 'fading' | 'gone'>(() => splashDisabled() ? 'gone' : 'visible');
  const [refreshing,   setRefreshing]   = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [dateSort,     setDateSort]     = useState<DateSort>('newest');

  useEffect(() => {
    if (splashDisabled()) return;
    const t = setTimeout(() => {
      setOverlayPhase('fading');
      setTimeout(() => setOverlayPhase('gone'), FADE_DURATION);
    }, WELCOME_DURATION);
    return () => clearTimeout(t);
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    await refresh();
    setTimeout(() => setRefreshing(false), 600);
  };

  const reRequest = (request: (typeof requests)[number]) => {
    const type = String(request.service_type ?? '').toLowerCase();
    const isTow = /tow|recovery/.test(type);
    const issueType = isTow ? 'towing' : 'other';
    const serviceType = isTow ? 'towing_provider' : 'mechanic';
    navigate('/locating', {
      state: {
        skipTriage: true,
        issueType,
        serviceType,
        reRequestServiceType: isTow ? 'Tow / recovery' : 'Roadside assist',
        reRequestDescription: request.description || '',
        reRequestId: String(request.id),
        lastPin: (() => {
          const m = String(request.location ?? '').match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
          if (!m) return undefined;
          const lat = Number(m[1]);
          const lng = Number(m[2]);
          return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined;
        })(),
      },
    });
  };

  const historyRequests = requests.filter(r => ['completed', 'cancelled'].includes(r.status));
  const completed = historyRequests.filter(r => r.status === 'completed').length;
  const cancelled  = historyRequests.filter(r => r.status === 'cancelled').length;

  const filtered = historyRequests
    .filter(r => statusFilter === 'all' || r.status === statusFilter)
    .sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
      return dateSort === 'newest' ? tb - ta : ta - tb;
    });

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--page-bg)', paddingBottom: 100, position: 'relative' }}>

      {overlayPhase !== 'gone' && (
        <div style={{ animation: overlayPhase === 'fading' ? `hov-fade-out ${FADE_DURATION}ms ease both` : undefined }}>
          <HistoryOverlay />
        </div>
      )}

      <div style={{ maxWidth: 480, margin: '0 auto', padding: '0 16px' }}>

        {/* ── Header ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 52, paddingBottom: 24 }}>
          <button
            onClick={() => navigate(-1)}
            style={{ width: 36, height: 36, borderRadius: '50%', border: 'none', background: 'var(--surface-3)', color: 'var(--text-md)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, transition: 'background 0.18s ease' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface-5)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface-3)'; }}
          >
            <ChevronLeft style={{ width: 18, height: 18 }} />
          </button>
          <div style={{ flex: 1 }}>
            <p style={{ color: `${Y}bf`, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.22em', fontWeight: 700, marginBottom: 2 }}>
              MOTOFIX · History
            </p>
            <h1 style={{ color: 'var(--text-hi)', fontWeight: 900, fontSize: 22, letterSpacing: '-0.02em', lineHeight: 1 }}>
              Service History
            </h1>
          </div>
          <button
            onClick={handleRefresh}
            disabled={isLoading || refreshing}
            style={{ width: 36, height: 36, borderRadius: '50%', border: 'none', background: 'var(--surface-3)', color: 'var(--text-lo)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, transition: 'background 0.18s ease, color 0.18s ease', opacity: (isLoading || refreshing) ? 0.5 : 1 }}
            onMouseEnter={e => { e.currentTarget.style.background = `${A}18`; e.currentTarget.style.color = A; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface-3)'; e.currentTarget.style.color = 'var(--text-lo)'; }}
          >
            <RefreshCw style={{ width: 15, height: 15, animation: (isLoading || refreshing) ? 'rl-spin 0.8s linear infinite' : 'none' }} />
          </button>
        </div>

        {/* ── Stats row ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 24 }}>
          {[
            { label: 'Total',     value: historyRequests.length, color: A,         icon: History       },
            { label: 'Completed', value: completed,              color: '#4ADE80',  icon: CheckCircle2  },
            { label: 'Cancelled', value: cancelled,              color: '#F87171',  icon: XCircle       },
          ].map(({ label, value, color, icon: Icon }) => (
            <div key={label} style={{ borderRadius: 18, padding: '14px 0', background: 'var(--surface-1)', border: '1px solid var(--border-2)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, transition: 'background 0.18s ease, border-color 0.18s ease', cursor: 'default' }}
              onMouseEnter={e => { e.currentTarget.style.background = `${color}08`; e.currentTarget.style.borderColor = `${color}25`; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface-1)'; e.currentTarget.style.borderColor = 'var(--border-2)'; }}
            >
              <Icon style={{ width: 16, height: 16, color }} />
              <span style={{ color: 'var(--text-hi)', fontSize: 22, fontWeight: 900, lineHeight: 1 }}>{value}</span>
              <span style={{ color: 'var(--text-dim)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 700 }}>{label}</span>
            </div>
          ))}
        </div>

        {/* ── Filter bar ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
          {/* Status pills */}
          <div style={{ display: 'flex', gap: 6, flex: 1 }}>
            {([
              { key: 'all',       label: 'All',       count: historyRequests.length },
              { key: 'completed', label: 'Completed',  count: completed              },
              { key: 'cancelled', label: 'Cancelled',  count: cancelled              },
            ] as { key: StatusFilter; label: string; count: number }[]).map(({ key, label, count }) => {
              const active = statusFilter === key;
              const accent = key === 'completed' ? '#4ADE80' : key === 'cancelled' ? '#F87171' : A;
              return (
                <button
                  key={key}
                  onClick={() => setStatusFilter(key)}
                  style={{
                    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                    padding: '8px 4px', borderRadius: 12, border: 'none', cursor: 'pointer',
                    background: active ? `${accent}18` : 'var(--surface-3)',
                    outline: active ? `1.5px solid ${accent}50` : '1.5px solid var(--border-2)',
                    transition: 'all 0.2s ease',
                    boxShadow: active ? `0 0 12px ${accent}20` : 'none',
                  }}
                >
                  <span style={{ color: active ? accent : 'var(--text-dim)', fontSize: 12, fontWeight: active ? 800 : 500, transition: 'color 0.2s ease' }}>
                    {label}
                  </span>
                  <span style={{ padding: '1px 5px', borderRadius: 6, background: active ? `${accent}25` : 'var(--surface-4)', color: active ? accent : 'var(--text-faint)', fontSize: 10, fontWeight: 800, transition: 'all 0.2s ease' }}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Date sort toggle */}
          <button
            onClick={() => setDateSort(d => d === 'newest' ? 'oldest' : 'newest')}
            style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '8px 10px', borderRadius: 12, border: 'none', cursor: 'pointer', background: 'var(--surface-2)', outline: '1.5px solid var(--border-2)', flexShrink: 0, transition: 'background 0.18s ease' }}
            onMouseEnter={e => { e.currentTarget.style.background = `${A}12`; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface-2)'; }}
            title={`Sorted: ${dateSort === 'newest' ? 'Newest first' : 'Oldest first'}`}
          >
            <ArrowUpDown style={{ width: 13, height: 13, color: dateSort === 'newest' ? A : 'var(--text-dim)' }} />
            <span style={{ color: dateSort === 'newest' ? A : 'var(--text-dim)', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
              {dateSort === 'newest' ? 'Newest' : 'Oldest'}
            </span>
          </button>
        </div>


        {/* ── Loading skeleton ── */}
        {isLoading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {[1, 2, 3].map(i => (
              <div key={i} style={{ borderRadius: 20, padding: '18px', background: 'var(--surface-1)', border: '1px solid var(--border-2)', animation: 'rl-pulse 1.6s ease-in-out infinite' }}>
                <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
                  <div style={{ width: 44, height: 44, borderRadius: 14, background: 'var(--surface-4)', flexShrink: 0 }} />
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ height: 14, borderRadius: 6, background: 'var(--surface-4)', width: '55%' }} />
                    <div style={{ height: 11, borderRadius: 6, background: 'var(--surface-3)', width: '30%' }} />
                  </div>
                  <div style={{ height: 22, borderRadius: 20, background: 'var(--surface-4)', width: 72, flexShrink: 0 }} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  <div style={{ height: 11, borderRadius: 6, background: 'var(--surface-3)', width: '80%' }} />
                  <div style={{ height: 11, borderRadius: 6, background: 'var(--surface-2)', width: '55%' }} />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Empty state ── */}
        {!isLoading && historyRequests.length === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 32, paddingBottom: 20 }}>

            {/* Animated icon */}
            <div style={{ position: 'relative', width: 100, height: 100, marginBottom: 28 }}>
              {[100, 74].map((s, i) => (
                <div key={s} style={{ position: 'absolute', top: '50%', left: '50%', width: s, height: s, borderRadius: '50%', border: `1.5px solid rgba(96,165,250,${0.1 + i * 0.1})`, transform: 'translate(-50%,-50%)', animation: `hov-ring ${2.4 + i * 0.8}s ease-out ${i * 0.4}s infinite` }} />
              ))}
              <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: 60, height: 60, borderRadius: 20, background: `linear-gradient(135deg,${A}18,${A}08)`, border: `1.5px solid ${A}30`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 0 28px ${A}18` }}>
                <Inbox style={{ width: 26, height: 26, color: A }} />
              </div>
            </div>

            <p style={{ color: 'var(--text-hi)', fontWeight: 900, fontSize: 20, letterSpacing: '-0.01em', marginBottom: 10 }}>No history yet</p>
            <p style={{ color: 'var(--text-dim)', fontSize: 13, textAlign: 'center', lineHeight: 1.65, maxWidth: 260, marginBottom: 32 }}>
              Your completed and cancelled service requests will appear here once you start using MOTOFIX.
            </p>

            {/* Divider with label */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', maxWidth: 320, marginBottom: 24 }}>
              <div style={{ flex: 1, height: 1, background: 'var(--surface-4)' }} />
              <span style={{ color: 'var(--text-faint)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.15em' }}>Get started</span>
              <div style={{ flex: 1, height: 1, background: 'var(--surface-4)' }} />
            </div>

            {/* CTA */}
            <button
              onClick={() => navigate('/sos')}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '13px 28px', borderRadius: 16, border: 'none', cursor: 'pointer', background: `linear-gradient(135deg,${Y},#D97706)`, color: '#000', fontWeight: 800, fontSize: 14, boxShadow: `0 0 0 3px ${Y}22, 0 6px 24px ${Y}30`, transition: 'transform 0.18s ease, box-shadow 0.18s ease' }}
              onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.03)'; e.currentTarget.style.boxShadow = `0 0 0 4px ${Y}33, 0 8px 32px ${Y}45`; }}
              onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = `0 0 0 3px ${Y}22, 0 6px 24px ${Y}30`; }}
            >
              Request a Service
              <ChevronRight style={{ width: 16, height: 16 }} />
            </button>

            {/* Hint row */}
            <div style={{ display: 'flex', gap: 20, marginTop: 32 }}>
              {[
                { icon: CheckCircle2, label: 'Completed', color: '#4ADE80' },
                { icon: Clock,        label: 'Timestamps', color: A         },
                { icon: XCircle,      label: 'Cancelled',  color: '#F87171' },
              ].map(({ icon: Icon, label, color }) => (
                <div key={label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 11, background: `${color}12`, border: `1px solid ${color}25`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon style={{ width: 15, height: 15, color }} />
                  </div>
                  <span style={{ color: 'var(--text-dim)', fontSize: 10, fontWeight: 600 }}>{label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Request cards ── */}
        {!isLoading && historyRequests.length > 0 && (
          <>
            {filtered.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '36px 0' }}>
                <div style={{ width: 52, height: 52, borderRadius: 16, background: 'var(--surface-2)', border: '1px solid var(--border-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
                  <Inbox style={{ width: 22, height: 22, color: 'var(--text-faint)' }} />
                </div>
                <p style={{ color: 'var(--text-lo)', fontSize: 14, fontWeight: 700 }}>No {statusFilter} requests</p>
                <p style={{ color: 'var(--text-faint)', fontSize: 12, marginTop: 5 }}>Try a different filter above</p>
              </div>
            ) : (
              <>
                <p style={{ color: 'var(--text-dim)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.18em', fontWeight: 700, marginBottom: 14 }}>
                  {filtered.length} request{filtered.length !== 1 ? 's' : ''} · {dateSort === 'newest' ? 'Newest first' : 'Oldest first'}
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {filtered.map((request, index) => (
                    <RequestCard
                      key={request.id}
                      request={request}
                      index={index}
                      onReRequest={() => reRequest(request)}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}

      </div>

      <style>{`
        @keyframes rl-spin  { to { transform: rotate(360deg); } }
        @keyframes rl-pulse {
          0%,100% { opacity: 1; }
          50%     { opacity: 0.45; }
        }
      `}</style>
    </div>
  );
}
