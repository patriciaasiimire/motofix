// LocatingUser.tsx — the brief "finding your location" screen shown while we get a GPS
// fix (with friendly status messages), before moving the driver on to describe the issue.
// Falls back to central Kampala if GPS can't be obtained.

import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { MapPin, Navigation } from 'lucide-react';
import { authService, requestsService } from '@/config/api';
import { useAuth } from '@/hooks/useAuth';

const SOS  = '#F59E0B';
const SOSD = '#D97706';

const GPS_FALLBACK = { lat: 0.3476, lng: 32.5825 };
const LAST_PIN_KEY = 'motofix_last_pin';

type LastPin = { lat: number; lng: number };

function readStoredPin(): LastPin | null {
  try {
    const raw = localStorage.getItem(LAST_PIN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LastPin;
    if (typeof parsed?.lat !== 'number' || typeof parsed?.lng !== 'number') return null;
    if (!Number.isFinite(parsed.lat) || !Number.isFinite(parsed.lng)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function persistPin(lat: number, lng: number) {
  try { localStorage.setItem(LAST_PIN_KEY, JSON.stringify({ lat, lng, saved_at: Date.now() })); } catch { /* ignore */ }
}

const LOC_MESSAGES = [
  'Initialising GPS signal…',
  'Scanning your surroundings…',
  'Detecting nearby landmarks…',
  'Locking onto your position…',
  'Cross-referencing network towers…',
  'Pinning your exact location…',
  'Location confirmed!',
];

const SPARE_PARTS_MESSAGES = [
  'Initialising GPS signal…',
  'Scanning the radius for auto-parts dealers…',
  'Locating nearby spare-parts shops…',
  'Checking dealer stock & opening hours…',
  'Ranking dealers by distance…',
  'Pinning dealers near you…',
  'Dealers found!',
];

type Phase = 'permission' | 'locating' | 'located';

/* ── Spinning rings around the logo ─────────────────────────────────────── */
function LocatingSpinner() {
  return (
    <div style={{ position: 'relative', width: 160, height: 160 }}>
      {/* Outer dashed ring — slow */}
      <div style={{ position: 'absolute', inset: 0, animation: 'spin-cw 12s linear infinite' }}>
        <svg width="160" height="160" viewBox="0 0 160 160" fill="none">
          <circle cx="80" cy="80" r="76" stroke={`${SOS}30`} strokeWidth="1" strokeDasharray="8 6" />
        </svg>
      </div>
      {/* Main fast arc */}
      <div style={{ position: 'absolute', inset: 0, animation: 'spin-cw 1.8s linear infinite' }}>
        <svg width="160" height="160" viewBox="0 0 160 160" fill="none">
          <circle cx="80" cy="80" r="72"
            stroke={SOS} strokeWidth="2.5" strokeLinecap="round"
            strokeDasharray="90 362"
            style={{ filter: `drop-shadow(0 0 6px ${SOS}bb)` }} />
        </svg>
      </div>
      {/* Counter-rotating dashed ring */}
      <div style={{ position: 'absolute', inset: 24, animation: 'spin-ccw 3.2s linear infinite' }}>
        <svg width="112" height="112" viewBox="0 0 112 112" fill="none">
          <circle cx="56" cy="56" r="52" stroke={`${SOS}44`} strokeWidth="1.5" strokeDasharray="5 9" />
        </svg>
      </div>
      {/* Inner fast arc */}
      <div style={{ position: 'absolute', inset: 32, animation: 'spin-cw 1.1s linear infinite' }}>
        <svg width="96" height="96" viewBox="0 0 96 96" fill="none">
          <circle cx="48" cy="48" r="44"
            stroke={`${SOS}66`} strokeWidth="2" strokeLinecap="round" strokeDasharray="40 236" />
        </svg>
      </div>
      {/* Logo badge */}
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{
          width: 72, height: 72, borderRadius: 18,
          background: 'var(--page-bg)',
          border: `2px solid ${SOS}dd`,
          boxShadow: `0 0 0 1px ${SOS}22, 0 0 24px ${SOS}88, 0 0 48px ${SOS}33`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          animation: 'pulse-badge 2s ease-in-out infinite',
        }}>
          <img src="/motofix-logo.png" alt="MOTOFIX"
            style={{ width: 58, height: 58, objectFit: 'contain' }}
            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
        </div>
      </div>
    </div>
  );
}

/* ── Main page ───────────────────────────────────────────────────────────── */
export default function LocatingUser() {
  const navigate   = useNavigate();
  const { user }   = useAuth();
  const routeState = useLocation().state as {
    issueType?: string;
    serviceType?: string;
    aiSummary?: string;
    aiDiagnosis?: unknown;
    mode?: string;
    breakdownPrefs?: { fixOnSpot: boolean; allowTow: boolean };
    reRequestServiceType?: string;
    reRequestDescription?: string;
    reRequestId?: string;
    skipTriage?: boolean;
    lastPin?: LastPin;
  } | null;
  const issueType  = routeState?.issueType;
  const isSpareParts = routeState?.mode === 'spare-parts';
  const skipTriage = !!routeState?.skipTriage;
  const lastPin = useRef(routeState?.lastPin ?? readStoredPin()).current;
  const submitDone = useRef(false);

  // Mode-specific copy (same flow + animation as the mechanic/towing options).
  const badgeText  = isSpareParts ? 'Spare Parts & Self-Fix' : skipTriage ? 'Get help again' : 'SOS — Emergency Assistance';
  const subtitle   = isSpareParts
    ? 'To show spare-parts dealers near you, MOTOFIX needs your GPS location. It’s only used to find nearby shops.'
    : 'To send on-site assist or a tow to you, MOTOFIX needs your GPS location. It’s only used while you need help.';
  const secureNote = isSpareParts
    ? 'Your location is only used to find nearby dealers.'
    : 'Your location is sent securely to the matched helper only.';
  const btnText    = isSpareParts ? 'Allow Location & Find Dealers' : 'Allow Location & Get Help';
  const locatedSub = isSpareParts
    ? 'Finding dealers near you…'
    : skipTriage
      ? 'Matching a verified helper…'
      : 'Preparing your request details…';
  const MESSAGES   = isSpareParts ? SPARE_PARTS_MESSAGES : LOC_MESSAGES;

  const [phase,      setPhase]      = useState<Phase>('permission');
  const [msgIdx,     setMsgIdx]     = useState(0);
  const [address,    setAddress]    = useState('');
  const [locError,   setLocError]   = useState('');
  const [dispatchError, setDispatchError] = useState('');

  const gpsDone       = useRef(false);
  const minTimeDone   = useRef(false);
  const pendingCoords = useRef<{ lat: number; lng: number; accuracy?: number }>(GPS_FALLBACK);
  const pendingAddr   = useRef('');

  /* Reverse geocode via REST (no Maps JS SDK needed here) */
  const doGeocode = useCallback((lat: number, lng: number, cb: (addr: string) => void) => {
    const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
    if (!key) { cb(`${lat.toFixed(5)}, ${lng.toFixed(5)}`); return; }
    fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${key}`)
      .then(r => r.json())
      .then(d => {
        if (d.status !== 'OK' || !d.results?.length) {
          cb(`${lat.toFixed(5)}, ${lng.toFixed(5)}`); return;
        }
        // Skip results whose formatted_address contains long digit runs — those are business
        // listings that embed phone numbers (e.g. "256781601447") in their Google Maps address.
        const clean = d.results.find((r: any) => !/\d{8,}/.test(r.formatted_address));
        cb((clean ?? d.results[0]).formatted_address);
      })
      .catch(() => cb(`${lat.toFixed(5)}, ${lng.toFixed(5)}`));
  }, []);

  /* When both GPS and min-time are done → move to 'located' */
  const tryComplete = useCallback(() => {
    if (gpsDone.current && minTimeDone.current) {
      setPhase('located');
    }
  }, []);

  /* Start locating */
  const startLocating = useCallback(() => {
    // Reset state on every attempt so retries work cleanly
    gpsDone.current = false;
    minTimeDone.current = false;
    setLocError('');
    setPhase('locating');

    const onGot = (lat: number, lng: number, accuracy?: number) => {
      pendingCoords.current = { lat, lng, accuracy };
      persistPin(lat, lng);
      gpsDone.current = true;
      tryComplete();
      doGeocode(lat, lng, addr => {
        pendingAddr.current = addr;
        setAddress(addr);
      });
    };

    if (!navigator.geolocation) {
      setLocError(lastPin ? 'gps-unavailable' : 'GPS is not supported on this browser.');
      setPhase('permission');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => onGot(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
      (err) => {
        // PERMISSION_DENIED = 1, POSITION_UNAVAILABLE = 2, TIMEOUT = 3
        if (lastPin) {
          setLocError('gps-unavailable');
        } else if (err.code === 1) {
          setLocError('denied');
        } else {
          setLocError('Could not get your location. Make sure GPS is on and try again.');
        }
        setPhase('permission');
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }, [doGeocode, tryComplete, lastPin]);

  const useLastPin = useCallback(() => {
    if (!lastPin) return;
    setLocError('');
    setDispatchError('');
    gpsDone.current = false;
    minTimeDone.current = false;
    pendingCoords.current = { lat: lastPin.lat, lng: lastPin.lng };
    persistPin(lastPin.lat, lastPin.lng);
    setPhase('locating');
    gpsDone.current = true;
    doGeocode(lastPin.lat, lastPin.lng, addr => {
      pendingAddr.current = addr;
      setAddress(addr);
    });
    tryComplete();
  }, [lastPin, doGeocode, tryComplete]);

  /* Watch for the user granting permission after initially denying it */
  useEffect(() => {
    if (locError !== 'denied') return;
    if (!navigator.permissions) return;
    let status: PermissionStatus | null = null;
    const handler = () => {
      if (status?.state === 'granted') startLocating();
    };
    navigator.permissions.query({ name: 'geolocation' as PermissionName }).then(s => {
      status = s;
      s.addEventListener('change', handler);
    });
    return () => { status?.removeEventListener('change', handler); };
  }, [locError, startLocating]);

  /* Cycle messages + enforce minimum display time */
  useEffect(() => {
    if (phase !== 'locating') return;
    const timers = MESSAGES.map((_, i) => setTimeout(() => setMsgIdx(i), i * 900));
    const done = setTimeout(() => { minTimeDone.current = true; tryComplete(); }, MESSAGES.length * 900 + 300);
    return () => { timers.forEach(clearTimeout); clearTimeout(done); };
  }, [phase, tryComplete, MESSAGES]);

  /* Navigate after location confirmed */
  useEffect(() => {
    if (phase !== 'located' || submitDone.current) return;
    submitDone.current = true;
    const t = setTimeout(async () => {
      if (isSpareParts) {
        navigate('/spare-parts', {
          replace: true,
          state: {
            lat:     pendingCoords.current.lat,
            lng:     pendingCoords.current.lng,
            address: pendingAddr.current,
          },
        });
        return;
      }
      if (skipTriage) {
        const isTow = /tow|recovery/i.test(routeState?.reRequestServiceType ?? '') || issueType === 'towing';
        const svcType = isTow ? 'Tow / recovery' : 'Roadside assist';
        const notes = (routeState?.reRequestDescription || '').trim();
        const description = notes
          || (isTow
            ? 'Repeat request — tow / recovery to a garage or safer place.'
            : 'Repeat request — on-site assist.');
        try {
          let preferredMechanicId: number | undefined;
          try {
            const { data } = await authService.getPreferences();
            const savedId = Number(data?.preferences?.preferred_mechanic_id);
            if (Number.isSafeInteger(savedId) && savedId > 0) preferredMechanicId = savedId;
          } catch { /* matching still runs without a preferred helper */ }
          const loc = `${pendingCoords.current.lat},${pendingCoords.current.lng}`;
          const res = await requestsService.create({
            customer_name: user?.full_name || 'Driver',
            service_type: svcType,
            location: loc,
            description,
            ...(preferredMechanicId ? { preferred_mechanic_id: preferredMechanicId } : {}),
          });
          const newId = String(res.data?.id ?? '');
          navigate(newId ? `/requests/${newId}` : '/requests', { replace: true });
        } catch {
          submitDone.current = false;
          setDispatchError('Could not dispatch help. Check your connection and try again.');
          setPhase('permission');
        }
        return;
      }
      navigate('/describe-issue', {
        replace: true,
        state: {
          issueType,
          serviceType: routeState?.serviceType,
          breakdownPrefs: routeState?.breakdownPrefs,
          aiSummary:   routeState?.aiSummary,
          aiDiagnosis: routeState?.aiDiagnosis,
          reRequestServiceType: routeState?.reRequestServiceType,
          reRequestDescription: routeState?.reRequestDescription,
          reRequestId: routeState?.reRequestId,
          lat:      pendingCoords.current.lat,
          lng:      pendingCoords.current.lng,
          accuracy: pendingCoords.current.accuracy,
          address:  pendingAddr.current,
        },
      });
    }, skipTriage ? 900 : 2200);
    return () => clearTimeout(t);
  }, [phase, navigate, issueType, routeState, isSpareParts, skipTriage, user?.full_name]);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, overflow: 'hidden', background: 'var(--page-bg)' }}>

      {/* ── Subtle grid background ── */}
      <div style={{
        position: 'absolute', inset: 0, zIndex: 0,
        backgroundImage: `linear-gradient(${SOS}08 1px, transparent 1px), linear-gradient(90deg, ${SOS}08 1px, transparent 1px)`,
        backgroundSize: '48px 48px',
      }} />

      {/* ══ PHASE: PERMISSION ══ */}
      {phase === 'permission' && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 20,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          padding: '0 16px',
          animation: 'slide-up-card 0.45s cubic-bezier(0.34,1.56,0.64,1) both',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '6px 16px', borderRadius: 9999, marginBottom: 20,
            background: `${SOS}22`, border: `1px solid ${SOS}44`,
          }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: SOS, animation: 'dot-pulse 1s ease-in-out infinite' }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: SOS }}>{badgeText}</span>
          </div>

          <div style={{ marginBottom: 12 }}>
            <LocatingSpinner />
          </div>

          <div style={{
            width: '100%', maxWidth: 360, borderRadius: 24, padding: 24,
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20,
            background: 'var(--overlay-bg)',
            border: `1.5px solid ${SOS}33`,
            boxShadow: `0 0 0 1px ${SOS}11, 0 30px 80px rgba(0,0,0,0.8)`,
            backdropFilter: 'blur(24px)',
          }}>
            <div style={{ textAlign: 'center' }}>
              <h2 style={{ fontSize: 20, fontWeight: 900, color: 'var(--text-hi)', marginBottom: 8 }}>We need your location</h2>
              <p style={{ fontSize: 13, color: 'var(--text-md)', lineHeight: 1.65 }}>
                {subtitle}
              </p>
            </div>

            {/* Location error message */}
            {(locError || dispatchError) && (
              <div style={{
                width: '100%', borderRadius: 12, padding: '12px 16px',
                display: 'flex', alignItems: 'flex-start', gap: 10,
                background: `${SOS}15`, border: `1.5px solid ${SOS}55`,
              }}>
                <span style={{ fontSize: 16, flexShrink: 0 }}>⚠️</span>
                <div>
                  <p style={{ fontSize: 12, color: SOS, fontWeight: 600, lineHeight: 1.5 }}>
                    {dispatchError
                      || (locError === 'denied' ? 'Location access was denied.'
                        : locError === 'gps-unavailable' ? 'GPS is unavailable. Use your last pin to continue?'
                          : locError)}
                  </p>
                  {locError === 'denied' && !lastPin && (
                    <p style={{ fontSize: 11, color: SOS, fontWeight: 400, lineHeight: 1.6, marginTop: 4, opacity: 0.85 }}>
                      On iPhone: go to <strong>Settings → Safari → Location</strong> and set it to <strong>Ask</strong>. Then come back and tap the button — it will work automatically.
                    </p>
                  )}
                </div>
              </div>
            )}
            {locError === 'gps-unavailable' && lastPin && (
              <button
                onClick={useLastPin}
                style={{
                  width: '100%', height: 48, borderRadius: 14, border: `1.5px solid ${SOS}77`,
                  background: `${SOS}18`, color: SOS, fontWeight: 800, fontSize: 13.5, cursor: 'pointer',
                }}
              >
                Use last location
              </button>
            )}

            <div style={{
              width: '100%', borderRadius: 12, padding: '12px 16px',
              display: 'flex', alignItems: 'center', gap: 12,
              background: `${SOS}0d`, border: `1px solid ${SOS}22`,
            }}>
              <MapPin style={{ width: 16, height: 16, color: SOS, flexShrink: 0 }} />
              <p style={{ fontSize: 12, color: 'var(--text-md)' }}>
                {secureNote}
              </p>
            </div>
            <button
              onClick={startLocating}
              style={{
                width: '100%', height: 52, borderRadius: 16, border: 'none',
                background: `linear-gradient(135deg, ${SOS}, ${SOSD})`,
                boxShadow: `0 0 0 4px ${SOS}22, 0 8px 32px ${SOS}55`,
                color: '#fff', fontWeight: 700, fontSize: 14,
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              }}
            >
              <Navigation style={{ width: 16, height: 16 }} />
              {btnText}
            </button>
            <button
              onClick={() => navigate(-1)}
              style={{ fontSize: 12, color: 'var(--text-dim)', background: 'none', border: 'none', cursor: 'pointer' }}
            >
              ← Go back and choose a different option
            </button>
          </div>
        </div>
      )}

      {/* ══ PHASE: LOCATING ══ */}
      {phase === 'locating' && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 20,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 20, padding: '0 16px',
          animation: 'fade-in 0.35s ease both',
        }}>
          <LocatingSpinner />

          <div style={{
            width: '100%', maxWidth: 360, borderRadius: 24, padding: '20px 20px',
            background: 'var(--overlay-bg)',
            border: `1.5px solid ${SOS}30`,
            boxShadow: `0 0 0 1px ${SOS}11, 0 20px 60px rgba(0,0,0,0.7)`,
            backdropFilter: 'blur(24px)',
          }}>
            <p
              key={msgIdx}
              style={{
                fontSize: 13, fontWeight: 600, color: 'var(--text-hi)',
                textAlign: 'center', marginBottom: 16, minHeight: 20,
                animation: 'fade-in-up 0.3s ease both',
              }}
            >
              {MESSAGES[msgIdx]}
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {MESSAGES.map((msg, i) => {
                const done    = i < msgIdx;
                const current = i === msgIdx;
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, opacity: i > msgIdx ? 0.2 : 1, transition: 'opacity 0.4s ease' }}>
                    <div style={{
                      width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: done ? `${SOS}30` : current ? `${SOS}1a` : 'var(--surface-3)',
                      border: `1.5px solid ${done || current ? `${SOS}77` : 'var(--border-2)'}`,
                      transition: 'background 0.3s ease, border-color 0.3s ease',
                      animation: current ? 'ring-pulse 1.2s ease-in-out infinite' : undefined,
                    }}>
                      {done ? (
                        <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
                          <path d="M2 5 L4 7 L8 3" stroke={SOS} strokeWidth="2"
                            strokeLinecap="round" strokeLinejoin="round"
                            strokeDasharray="9" strokeDashoffset="9"
                            style={{ animation: 'draw-tick 0.35s cubic-bezier(0.4,0,0.2,1) forwards' }} />
                        </svg>
                      ) : current ? (
                        <div style={{ width: 4, height: 4, borderRadius: '50%', background: SOS, animation: 'dot-pulse 1s ease-in-out infinite' }} />
                      ) : null}
                    </div>
                    <span style={{
                      fontSize: 12,
                      color: done ? `${SOS}99` : current ? 'var(--text-hi)' : 'var(--text-dim)',
                      fontWeight: current ? 600 : 400,
                    }}>
                      {msg}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ══ PHASE: LOCATED ══ */}
      {phase === 'located' && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 30,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 20, padding: '0 24px',
          background: 'var(--overlay-bg)',
          backdropFilter: 'blur(16px)',
          animation: 'fade-in 0.5s ease both',
        }}>
          <div style={{ position: 'relative', width: 100, height: 100 }}>
            <svg width="100" height="100" viewBox="0 0 100 100" fill="none">
              <circle cx="50" cy="50" r="44" stroke={`${SOS}30`} strokeWidth="2" />
              <circle cx="50" cy="50" r="44"
                stroke={SOS} strokeWidth="2.5" strokeLinecap="round"
                strokeDasharray="276.5" strokeDashoffset="276.5"
                transform="rotate(-90 50 50)"
                style={{ animation: 'draw-circle 0.7s cubic-bezier(0.4,0,0.2,1) 0.1s forwards', filter: `drop-shadow(0 0 8px ${SOS}bb)` }} />
              <path d="M28 50 L44 66 L72 34"
                stroke={SOS} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"
                strokeDasharray="60" strokeDashoffset="60"
                style={{ animation: 'draw-check 0.45s ease 0.65s forwards', filter: `drop-shadow(0 0 6px ${SOS}dd)` }} />
            </svg>
          </div>
          <div style={{ textAlign: 'center', animation: 'slide-up 0.5s ease 0.8s both', opacity: 0 }}>
            <h2 style={{ fontSize: 24, fontWeight: 900, color: 'var(--text-hi)', marginBottom: 4 }}>Location Found!</h2>
            <p style={{ fontSize: 13, color: 'var(--text-md)' }}>{locatedSub}</p>
          </div>
          {address && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 10,
              borderRadius: 16, padding: '12px 16px', maxWidth: 320,
              background: `${SOS}11`, border: `1px solid ${SOS}33`,
              animation: 'slide-up 0.5s ease 0.95s both', opacity: 0,
            }}>
              <MapPin style={{ width: 16, height: 16, color: SOS, flexShrink: 0, marginTop: 2 }} />
              <p style={{ fontSize: 12, color: 'var(--text-hi)', lineHeight: 1.6 }}>{address}</p>
            </div>
          )}
          <p style={{ fontSize: 11, color: 'var(--text-dim)', animation: 'slide-up 0.5s ease 1.1s both', opacity: 0 }}>
            {skipTriage ? 'Matching help…' : 'Opening issue details…'}
          </p>
          <div style={{ width: 120, height: 2, borderRadius: 2, overflow: 'hidden', background: `${SOS}22`, animation: 'slide-up 0.5s ease 1.25s both', opacity: 0 }}>
            <div style={{ height: '100%', borderRadius: 2, background: SOS, animation: 'progress-bar 2s linear 1.3s both' }} />
          </div>
        </div>
      )}

      {/* ── Keyframes ── */}
      <style>{`
        @keyframes spin-cw    { to { transform: rotate(360deg);  } }
        @keyframes spin-ccw   { to { transform: rotate(-360deg); } }
        @keyframes fade-in    { from { opacity: 0; } to { opacity: 1; } }
        @keyframes fade-in-up {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes slide-up {
          from { opacity: 0; transform: translateY(14px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes slide-up-card {
          from { opacity: 0; transform: translateY(60px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes pulse-badge {
          0%,100% { box-shadow: 0 0 0 1px ${SOS}55, 0 0 28px ${SOS}77; }
          50%     { box-shadow: 0 0 0 1px ${SOS}88, 0 0 44px ${SOS}aa; }
        }
        @keyframes ring-pulse {
          0%,100% { box-shadow: 0 0 0 0   ${SOS}77; }
          50%     { box-shadow: 0 0 0 5px ${SOS}18; }
        }
        @keyframes dot-pulse {
          0%,100% { opacity: 1;   transform: scale(1);   }
          50%     { opacity: 0.4; transform: scale(0.6); }
        }
        @keyframes draw-tick   { to { stroke-dashoffset: 0; } }
        @keyframes draw-circle { to { stroke-dashoffset: 0; } }
        @keyframes draw-check  { to { stroke-dashoffset: 0; } }
        @keyframes progress-bar {
          from { width: 0%; }
          to   { width: 100%; }
        }
      `}</style>
    </div>
  );
}
