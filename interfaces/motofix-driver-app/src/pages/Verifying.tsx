// Verifying.tsx — the short "verifying your account" transition shown right after login/
// signup while we confirm the session and decide where to send the user next (onboarding
// if their profile isn't complete, otherwise straight to Home).

import { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { authService, getAuthErrorMessage } from '@/config/api';
import { toast } from 'sonner';
import { PROFILE_COMPLETE_KEY } from './Onboarding';

const MESSAGES = [
  'Checking your code…',
  'Confirming your identity…',
  'Setting up your account…',
  'All good — welcome!',
];

type Phase = 'verifying' | 'success';
type AuthUser = Awaited<ReturnType<ReturnType<typeof useAuth>['login']>>;

export default function Verifying() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useAuth();

  const state = (location.state as {
    phone: string;
    otp: string;
    fullName?: string;
    numberPlate?: string;
  }) || {};
  const { phone, otp, fullName, numberPlate } = state;

  const [msgIdx,  setMsgIdx]  = useState(0);
  const [phase,   setPhase]   = useState<Phase>('verifying');
  const [userData, setUserData] = useState<AuthUser | null>(null);

  /* refs so closures in effects always see latest values */
  const apiDone     = useRef(false);
  const minTimeDone = useRef(false);
  const pending     = useRef<AuthUser | null>(null);
  const errored     = useRef(false);

  const tryComplete = () => {
    if (apiDone.current && minTimeDone.current && !errored.current) {
      setUserData(pending.current);
      setPhase('success');
    }
  };

  /* run API call immediately */
  useEffect(() => {
    if (!phone || !otp) { navigate('/welcome', { replace: true }); return; }

    login(phone, otp, fullName)
      .then(async (loginUser) => {
        let ud = loginUser;
        // Save name / plate if provided (new signup)
        if (numberPlate || fullName) {
          try {
            const profileRes = await authService.updateProfile({
              ...(fullName    ? { full_name:    fullName.trim()                  } : {}),
              ...(numberPlate ? { number_plate: numberPlate.trim().toUpperCase() } : {}),
            });
            // Merge updated fields so every page immediately sees the name
            ud = { ...ud, ...profileRes.data };
            localStorage.setItem('motofix_user', JSON.stringify(ud));
          } catch {
            // Non-blocking — profile can be updated later
          }
        }
        pending.current  = ud;
        apiDone.current  = true;
        tryComplete();
      })
      .catch((err: unknown) => {
        errored.current = true;
        toast.error(getAuthErrorMessage(err));
        navigate('/login', { replace: true });
      });
  // This verification should run once for the OTP payload received in route state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* cycle messages, then signal min-time done */
  useEffect(() => {
    const timers = MESSAGES.map((_, i) =>
      setTimeout(() => setMsgIdx(i), i * 950)
    );
    const done = setTimeout(() => {
      minTimeDone.current = true;
      tryComplete();
    }, MESSAGES.length * 950);

    return () => { timers.forEach(clearTimeout); clearTimeout(done); };
  }, []);

  /* navigate after success is shown */
  useEffect(() => {
    if (phase !== 'success') return;
    const t = setTimeout(() => {
      // Signup flow (fullName in state) → onboarding unless already complete
      // Login flow (no fullName) → requests directly
      const isNewSignup = !!fullName;
      const profileComplete = localStorage.getItem(PROFILE_COMPLETE_KEY) === 'true';
      navigate(isNewSignup && !profileComplete ? '/onboarding' : '/requests', { replace: true });
    }, 3800);
    return () => clearTimeout(t);
  }, [phase, userData, navigate, fullName]);

  /* ─────────────────────────────────────────── */

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col items-center justify-center overflow-hidden">

      {/* Ambient glow */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2
                        w-96 h-96 rounded-full bg-primary/10 blur-3xl" />
      </div>

      {/* ══════════════════════════════════
          SUCCESS OVERLAY
      ══════════════════════════════════ */}
      {phase === 'success' && (
        <div
          className="absolute inset-0 z-20 flex flex-col items-center justify-center"
          style={{
            background: 'var(--overlay-bg)',
            backdropFilter: 'blur(12px)',
            animation: 'fade-in 0.5s ease both',
          }}
        >
          {/* Animated checkmark circle */}
          <div className="relative mb-6" style={{ width: 100, height: 100 }}>
            <svg width="100" height="100" viewBox="0 0 100 100" fill="none">
              {/* Outer ring draws itself */}
              <circle cx="50" cy="50" r="44"
                stroke="hsl(var(--primary)/0.25)" strokeWidth="2" />
              <circle cx="50" cy="50" r="44"
                stroke="hsl(var(--primary))"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeDasharray="276.5"
                transform="rotate(-90 50 50)"
                style={{
                  strokeDashoffset: 276.5,
                  animation: 'draw-circle 0.55s cubic-bezier(0.4,0,0.2,1) 0.05s forwards',
                  filter: 'drop-shadow(0 0 8px hsl(var(--primary)/0.6))',
                }}
              />
              {/* Checkmark */}
              <path d="M28 50 L44 66 L72 34"
                stroke="hsl(var(--primary))"
                strokeWidth="3.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray="60"
                style={{
                  strokeDashoffset: 60,
                  animation: 'draw-check 0.38s cubic-bezier(0.4,0,0.2,1) 0.48s forwards',
                  filter: 'drop-shadow(0 0 6px hsl(var(--primary)/0.8))',
                }}
              />
            </svg>
          </div>

          <h2
            className="text-2xl font-black text-foreground mb-2"
            style={{ animation: 'slide-up 0.5s ease 0.8s both' }}
          >
            {fullName ? "You're All Set!" : 'Identity Verified!'}
          </h2>
          <p
            className="text-muted-foreground text-sm mb-1"
            style={{ animation: 'slide-up 0.5s ease 0.95s both' }}
          >
            {fullName
              ? <>Core details captured for <span className="text-primary font-semibold">{fullName.trim().split(' ')[0]}</span>. Your account is ready.</>
              : userData?.full_name
                ? <>Welcome back, <span className="text-primary font-semibold">{userData.full_name}</span>.</>
                : 'Phone verified successfully.'}
          </p>
          <p
            className="text-muted-foreground/60 text-xs mt-3"
            style={{ animation: 'slide-up 0.5s ease 1.1s both' }}
          >
            {fullName ? 'Taking you to complete your profile…' : 'Taking you to your dashboard…'}
          </p>

          {/* Progress bar */}
          <div
            className="mt-5 h-0.5 rounded-full bg-primary/20 overflow-hidden"
            style={{ width: 120, animation: 'slide-up 0.5s ease 1.4s both' }}
          >
            <div
              className="h-full bg-primary rounded-full"
              style={{ animation: 'progress-bar 2s linear 1.5s both' }}
            />
          </div>
        </div>
      )}

      {/* ══════════════════════════════════
          VERIFYING SPINNER
      ══════════════════════════════════ */}
      <div className="relative z-10 flex flex-col items-center gap-10">

        {/* Concentric spinning rings + logo */}
        <div className="relative" style={{ width: 200, height: 200 }}>

          {/* Outermost slow dashed ring */}
          <div className="absolute inset-0" style={{ animation: 'spin-cw 10s linear infinite' }}>
            <svg width="200" height="200" viewBox="0 0 200 200" fill="none">
              <circle cx="100" cy="100" r="96"
                stroke="hsl(var(--primary)/0.2)"
                strokeWidth="1"
                strokeDasharray="8 6" />
            </svg>
          </div>

          {/* Outer spinning arc */}
          <div className="absolute inset-0" style={{ animation: 'spin-cw 1.8s linear infinite' }}>
            <svg width="200" height="200" viewBox="0 0 200 200" fill="none">
              <circle cx="100" cy="100" r="90"
                stroke="hsl(var(--primary))"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeDasharray="120 446"
                style={{ filter: 'drop-shadow(0 0 6px hsl(var(--primary)/0.6))' }}
              />
            </svg>
          </div>

          {/* Middle counter-rotating dashed ring */}
          <div className="absolute inset-7" style={{ animation: 'spin-ccw 3s linear infinite' }}>
            <svg width="144" height="144" viewBox="0 0 144 144" fill="none">
              <circle cx="72" cy="72" r="68"
                stroke="hsl(var(--primary)/0.35)"
                strokeWidth="1.5"
                strokeDasharray="5 9" />
            </svg>
          </div>

          {/* Inner fast spinning arc */}
          <div className="absolute inset-12" style={{ animation: 'spin-cw 1.1s linear infinite' }}>
            <svg width="104" height="104" viewBox="0 0 104 104" fill="none">
              <circle cx="52" cy="52" r="48"
                stroke="hsl(var(--primary)/0.45)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray="48 254"
              />
            </svg>
          </div>

          {/* Logo badge — dead centre */}
          <div className="absolute inset-0 flex items-center justify-center">
            {/* Blurred halo behind badge */}
            <div className="absolute rounded-3xl"
              style={{
                width: 100, height: 100,
                background: 'hsl(var(--primary)/0.18)',
                filter: 'blur(16px)',
                animation: 'pulse-badge 2s ease-in-out infinite',
              }} />
            <div
              className="relative rounded-2xl flex items-center justify-center"
              style={{
                width: 88, height: 88,
                background: 'var(--page-bg)',
                border: '2.5px solid hsl(var(--primary)/0.9)',
                boxShadow: '0 0 0 1px hsl(var(--primary)/0.15), 0 0 24px hsl(var(--primary)/0.6), 0 0 52px hsl(var(--primary)/0.2)',
                animation: 'pulse-badge 2s ease-in-out infinite',
              }}
            >
              <img src="/motofix-logo.png" alt="MOTOFIX"
                style={{ width: 72, height: 72 }}
                className="object-contain"
                onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            </div>
          </div>
        </div>

        {/* Step list */}
        <div className="flex flex-col gap-2.5 w-64">
          {MESSAGES.map((msg, i) => {
            const done    = i < msgIdx;
            const current = i === msgIdx;

            return (
              <div
                key={i}
                className="flex items-center gap-3"
                style={{
                  opacity: i > msgIdx ? 0.25 : 1,
                  transition: 'opacity 0.4s ease',
                }}
              >
                {/* Status dot */}
                <div
                  className="w-5 h-5 rounded-full flex items-center justify-center shrink-0"
                  style={{
                    background: done ? 'hsl(var(--primary)/0.2)' : current ? 'hsl(var(--primary)/0.15)' : 'var(--surface-3)',
                    border: `1.5px solid ${done || current ? 'hsl(var(--primary)/0.6)' : 'var(--border-3)'}`,
                    transition: 'background 0.3s ease, border-color 0.3s ease',
                    animation: current ? 'ring-pulse 1.2s ease-in-out infinite' : undefined,
                  }}
                >
                  {done ? (
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <path d="M2 5 L4 7 L8 3" stroke="hsl(var(--primary))"
                        strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                        strokeDasharray="9" strokeDashoffset="9"
                        style={{ animation: 'draw-tick 0.35s cubic-bezier(0.4,0,0.2,1) forwards' }} />
                    </svg>
                  ) : current ? (
                    <div className="w-1.5 h-1.5 rounded-full bg-primary"
                      style={{ animation: 'dot-pulse 1s ease-in-out infinite' }} />
                  ) : null}
                </div>

                {/* Message */}
                <span
                  className="text-sm"
                  style={{
                    color: done ? 'hsl(var(--primary)/0.7)' : current ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
                    fontWeight: current ? 600 : 400,
                    animation: current ? 'fade-in-up 0.35s ease' : undefined,
                  }}
                >
                  {msg}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Keyframes ── */}
      <style>{`
        @keyframes spin-cw  { to { transform: rotate(360deg);  } }
        @keyframes spin-ccw { to { transform: rotate(-360deg); } }
        @keyframes pulse-badge {
          0%,100% { box-shadow: 0 0 0 1px hsl(var(--primary)/0.3), 0 0 28px hsl(var(--primary)/0.45); }
          50%     { box-shadow: 0 0 0 1px hsl(var(--primary)/0.5), 0 0 42px hsl(var(--primary)/0.65); }
        }
        @keyframes ring-pulse {
          0%,100% { box-shadow: 0 0 0 0 hsl(var(--primary)/0.4); }
          50%     { box-shadow: 0 0 0 4px hsl(var(--primary)/0.1); }
        }
        @keyframes dot-pulse {
          0%,100% { opacity: 1; transform: scale(1); }
          50%     { opacity: 0.4; transform: scale(0.6); }
        }
        @keyframes fade-in-up {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes fade-in {
          from { opacity: 0; } to { opacity: 1; }
        }
        @keyframes slide-up {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes draw-tick {
          to { stroke-dashoffset: 0; }
        }
        @keyframes tick-pop {
          0%   { opacity: 0; transform: scale(0.4); }
          70%  { transform: scale(1.2); }
          100% { opacity: 1; transform: scale(1); }
        }
        @keyframes draw-circle {
          to { stroke-dashoffset: 0; }
        }
        @keyframes draw-check {
          to { stroke-dashoffset: 0; }
        }
        @keyframes progress-bar {
          from { width: 0%; }
          to   { width: 100%; }
        }
      `}</style>
    </div>
  );
}
