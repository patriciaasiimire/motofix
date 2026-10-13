// Login.tsx — driver sign-in by phone number + OTP. Enter the phone, receive a one-time
// code by SMS, type it in, and you're logged in. New numbers are routed to Signup.

import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Phone, KeyRound, ArrowRight, Loader2, ArrowLeft, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authService, getAuthErrorMessage } from '@/config/api';
import { toast } from 'sonner';
import axios from 'axios';

type Step = 'phone' | 'otp';

export default function Login() {
  const [step, setStep]         = useState<Step>('phone');
  const [otp, setOtp]           = useState('');
  const [loading, setLoading]   = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown]   = useState(0);
  const cooldownRef               = useRef<ReturnType<typeof setInterval> | null>(null);
  const navigate    = useNavigate();
  const location    = useLocation();
  // Back-button landed here while already signed in → go Home, don't force re-login.
  useEffect(() => { if (localStorage.getItem('motofix_token')) navigate('/requests', { replace: true }); }, [navigate]);

  // When arriving from Onboarding after signup, the registered phone is locked
  const lockedPhone: string | null =
    (location.state as { lockedPhone?: string } | null)?.lockedPhone ?? null;
  const [phone, setPhone] = useState(lockedPhone ?? '');

  const formatPhone = (v: string) => {
    const d = v.replace(/\D/g, '');
    if (d.startsWith('256')) return '+' + d;
    if (d.startsWith('0'))   return '+256' + d.slice(1);
    if (d.length > 0)        return '+256' + d;
    return '';
  };

  const startCooldown = () => {
    setCooldown(30);
    if (cooldownRef.current) clearInterval(cooldownRef.current);
    cooldownRef.current = setInterval(() => {
      setCooldown(s => {
        if (s <= 1) { clearInterval(cooldownRef.current!); return 0; }
        return s - 1;
      });
    }, 1000);
  };

  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    const fmt = formatPhone(phone);
    if (fmt.length < 13) { toast.error('Enter a valid Ugandan phone number'); return; }
    if (lockedPhone && fmt !== lockedPhone) {
      toast.error('Please use the same number you registered with: ' + lockedPhone);
      return;
    }
    setLoading(true);
    try {
      const res = await authService.sendOtp(fmt);
      setPhone(fmt);
      setStep('otp');
      startCooldown();
      const msg: string = res.data?.message ?? '';
      toast.success(msg || 'OTP sent to your phone', { duration: 5000 });
    } catch (err: unknown) {
      toast.error(getAuthErrorMessage(err));
    } finally { setLoading(false); }
  };

  const handleResend = async () => {
    if (cooldown > 0 || resending) return;
    setResending(true);
    try {
      let res;
      try {
        res = await authService.resendOtp(phone);
      } catch (resendErr: unknown) {
        // If user not found (e.g. service restarted), re-register to get a fresh OTP
        if (axios.isAxiosError(resendErr) && resendErr.response?.status === 404) {
          res = await authService.sendOtp(phone);
        } else {
          throw resendErr;
        }
      }
      const msg: string = res.data?.message ?? '';
      startCooldown();
      toast.success(msg || 'New code sent to your phone', { duration: 5000 });
    } catch (err: unknown) {
      toast.error(getAuthErrorMessage(err));
    } finally { setResending(false); }
  };

  useEffect(() => () => { if (cooldownRef.current) clearInterval(cooldownRef.current); }, []);

  return (
    <div className="min-h-screen bg-background flex flex-col overflow-hidden relative">

      {/* ── Ambient glow ── */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-96 h-96 rounded-full bg-blue-500/8 blur-3xl" />
      </div>

      {/* ── Back button ── */}
      <button
        onClick={() => step === 'otp' ? (setStep('phone'), setOtp('')) : navigate('/driver-entry')}
        className="relative z-10 flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors mt-6 ml-5 w-fit"
        style={{ animation: 'fade-in 0.4s ease both' }}
      >
        <ArrowLeft className="w-4 h-4" />
        <span className="text-sm">{step === 'otp' ? 'Change number' : 'Back'}</span>
      </button>

      {/* ── Main content ── */}
      <div
        className="relative z-10 flex flex-col flex-1 justify-center px-5 pb-10 max-w-md mx-auto w-full"
        style={{ animation: 'fade-up 0.5s ease 0.1s both' }}
      >
        {/* Logo + heading */}
        <div className="flex flex-col items-center mb-8">
          <div
            className="w-14 h-14 rounded-2xl bg-primary flex items-center justify-center mb-5"
            style={{ boxShadow: '0 0 28px hsl(var(--primary)/0.4)' }}
          >
            <img src="/motofix-logo.png" alt="MOTOFIX" className="w-10 h-10 object-contain"
              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          </div>
          <h1 className="text-2xl font-black text-foreground text-center">
            {step === 'phone' ? 'Welcome back.' : 'Check your phone.'}
          </h1>
          <p className="text-muted-foreground text-sm mt-2 text-center leading-relaxed max-w-xs">
            {step === 'phone'
              ? "Enter your phone number and we'll send you a one-time login code."
              : <>Code sent to <span className="text-foreground font-semibold">{phone}</span>. Enter it below.</>}
          </p>
        </div>

        {/* Form panel */}
        <div
          className="rounded-2xl p-6"
          style={{
            background: 'var(--surface-1)',
            border: '1.5px solid rgba(59,130,246,0.2)',
            boxShadow: '0 0 40px rgba(59,130,246,0.07)',
          }}
        >
          {step === 'phone' ? (
            <form onSubmit={handleSendOtp} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-blue-400 uppercase tracking-widest mb-2 block">
                  Phone Number
                </label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-blue-400" />
                  <Input type="tel" placeholder="0700 123 456" value={phone}
                    onChange={e => setPhone(e.target.value)}
                    className="pl-10 h-12 focus-visible:ring-blue-500/50 focus-visible:border-blue-400"
                    style={{ background: 'var(--input-bg)', border: '1px solid var(--border-3)', color: 'var(--text-hi)' }}
                    autoFocus />
                  {lockedPhone && (
                    <Lock className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-blue-400/50" />
                  )}
                </div>
                {lockedPhone && (
                  <p className="text-[11px] text-blue-400/60 mt-1.5 pl-1 flex items-center gap-1">
                    <Lock className="w-2.5 h-2.5" />
                    Use the number you registered with
                  </p>
                )}
              </div>
              <Button type="submit"
                className="w-full h-12 bg-blue-600 hover:bg-blue-500 text-white font-semibold border-0"
                disabled={loading || !phone}>
                {loading
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Sending code…</>
                  : <>Send login code <ArrowRight className="w-4 h-4" /></>}
              </Button>
            </form>
          ) : (
            <form onSubmit={e => e.preventDefault()} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-blue-400 uppercase tracking-widest mb-2 block">
                  Verification Code
                </label>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-blue-400" />
                  <Input type="text" inputMode="numeric" placeholder="· · · · · ·"
                    value={otp}
                    onChange={e => {
                      const val = e.target.value.replace(/\D/g, '').slice(0, 6);
                      setOtp(val);
                      if (val.length === 6) navigate('/verifying', { state: { phone, otp: val } });
                    }}
                    className="pl-10 tracking-[0.6em] text-center font-mono text-lg h-12 focus-visible:ring-blue-500/50 focus-visible:border-blue-400"
                    style={{ background: 'var(--input-bg)', border: '1px solid var(--border-3)', color: 'var(--text-hi)' }}
                    maxLength={6} autoFocus />
                </div>
                <p className="flex items-center gap-1.5 mt-2.5 text-xs text-blue-400/70">
                  <span style={{
                    display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
                    background: '#60A5FA',
                    animation: 'dot-blink 1.4s ease-in-out infinite',
                  }} />
                  Verifies automatically once all 6 digits are entered
                </p>
                <div className="mt-4 text-center">
                  <button
                    type="button"
                    onClick={handleResend}
                    disabled={cooldown > 0 || resending}
                    className="text-xs transition-colors"
                    style={{ color: cooldown > 0 ? 'var(--muted-foreground)' : '#60A5FA' }}
                  >
                    {resending ? 'Sending…' : cooldown > 0 ? `Resend code in ${cooldown}s` : 'Didn\'t receive a code? Resend'}
                  </button>
                </div>
              </div>
            </form>
          )}
        </div>

        {/* Redirect to signup */}
        <div className="mt-8 flex flex-col items-center gap-3">
          <div className="flex items-center gap-3 w-full">
            <div style={{ height: 1, flex: 1, background: 'var(--border-2)' }} />
            <span className="text-xs text-muted-foreground/60">New to MOTOFIX?</span>
            <div style={{ height: 1, flex: 1, background: 'var(--border-2)' }} />
          </div>
          <button onClick={() => navigate('/signup')}
            className="text-sm font-semibold transition-colors"
            style={{ color: 'var(--accent-green)' }}>
            Create your account →
          </button>
        </div>
      </div>

      <style>{`
        @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes fade-up {
          from { opacity: 0; transform: translateY(20px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes dot-blink {
          0%,100% { opacity: 1; }
          50%     { opacity: 0.25; }
        }
      `}</style>
    </div>
  );
}
