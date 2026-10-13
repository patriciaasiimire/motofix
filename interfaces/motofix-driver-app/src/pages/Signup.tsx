// Signup.tsx — new driver registration: collects name, phone and number plate, sends an
// OTP to verify the phone, and creates the account once the code is confirmed.

import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { User, Phone, Car, ArrowRight, ArrowLeft, Loader2, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authService, getAuthErrorMessage } from "@/config/api";
import { toast } from "sonner";
import axios from "axios";

type Phase = "form" | "otp";

const formatPhone = (v: string) => {
  const d = v.replace(/\D/g, "");
  if (d.startsWith("256")) return "+" + d;
  if (d.startsWith("0")) return "+256" + d.slice(1);
  if (d.length > 0) return "+256" + d;
  return "";
};

const inputCls = "pl-10 h-12 focus-visible:ring-green-500/50 focus-visible:border-green-400 " + "text-foreground bg-[var(--input-bg)] border-[var(--border-3)]";

// Ugandan number plates come in several shapes — accept them all, not just the
// classic private format:
//   • Private / standard:    UAA 123A   (U + 2 letters · 3 digits · 1 letter)
//   • New digital / tracked: UA 123BG   (2 letters · 3 digits · 2 letters)
//   • Government:            UG 1234W
//   • Diplomatic / special:  CD 123A, UP 1234, UN 123A, etc.
const stripPlate = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, "");

// Normalise as the user types: uppercase, drop junk, and put one space before
// the first digit (e.g. "ua123bg" → "UA 123BG").
const formatPlate = (raw: string) => {
  const s = stripPlate(raw).slice(0, 8);
  const m = s.match(/^([A-Z]+)(\d.*)?$/);
  return m && m[2] ? `${m[1]} ${m[2]}` : s;
};

// Permissive validity check covering all the formats above while still
// rejecting obvious nonsense: 1–3 letters, 2–4 digits, then 0–3 letters.
const isValidPlate = (raw: string) => {
  const s = stripPlate(raw);
  return s.length >= 5 && s.length <= 8 && /^[A-Z]{1,3}\d{2,4}[A-Z]{0,3}$/.test(s);
};

export default function Signup() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("form");
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Form values
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [numberPlate, setNumberPlate] = useState("");
  const [otp, setOtp] = useState("");

  const startCooldown = () => {
    setCooldown(30);
    if (cooldownRef.current) clearInterval(cooldownRef.current);
    cooldownRef.current = setInterval(() => {
      setCooldown((s) => {
        if (s <= 1) {
          clearInterval(cooldownRef.current!);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  };

  useEffect(
    () => () => {
      if (cooldownRef.current) clearInterval(cooldownRef.current);
    },
    [],
  );

  const handlePlateChange = (raw: string) => setNumberPlate(formatPlate(raw));

  const handleResend = async () => {
    if (cooldown > 0 || resending) return;
    setResending(true);
    try {
      let res;
      try {
        res = await authService.resendOtp(phone);
      } catch (resendErr: unknown) {
        if (axios.isAxiosError(resendErr) && resendErr.response?.status === 404) {
          res = await authService.sendOtp(phone, fullName, numberPlate || undefined);
        } else {
          throw resendErr;
        }
      }
      startCooldown();
      toast.success(res.data?.message ?? "New verification code sent", { duration: 5000 });
    } catch (err: unknown) {
      toast.error(getAuthErrorMessage(err));
    } finally {
      setResending(false);
    }
  };

  /* ── Submit form → send OTP ── */
  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();

    const name = fullName.trim();
    if (!name) {
      toast.error("Enter your name");
      return;
    }
    if (name.split(/\s+/).length < 2) {
      toast.error("Enter your first and last name");
      return;
    }

    const fmt = formatPhone(phone);
    if (fmt.length < 13) {
      toast.error("Enter a valid Ugandan phone number (e.g. 0700 123 456)");
      return;
    }

    if (!numberPlate.trim()) {
      toast.error("Enter your number plate");
      return;
    }
    if (!isValidPlate(numberPlate)) {
      toast.error("Enter a valid Ugandan number plate (e.g. UAA 111A or UA 123BG)");
      return;
    }

    setLoading(true);
    try {
      const res = await authService.sendOtp(fmt, name, numberPlate.trim() || undefined);
      setPhone(fmt);
      setPhase("otp");
      startCooldown();
      toast.success(res.data?.message ?? "Verification code sent", { duration: 5000 });
    } catch (err: unknown) {
      toast.error(getAuthErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  /* ── Submit OTP → proceed to verifying ── */
  const handleVerify = (e: React.FormEvent) => {
    e.preventDefault();
    if (otp.length < 6) {
      toast.error("Enter the 6-digit code");
      return;
    }
    navigate("/verifying", {
      state: {
        phone,
        otp,
        fullName: fullName.trim(),
        numberPlate: numberPlate.trim().toUpperCase(),
      },
    });
  };

  return (
    <div className="min-h-screen bg-background flex flex-col overflow-hidden relative">
      {/* Ambient glow */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          className="absolute top-1/3 left-1/2 -translate-x-1/2
                        w-96 h-96 rounded-full bg-green-500/7 blur-3xl"
        />
      </div>

      {/* Back button */}
      <button onClick={() => (phase === "otp" ? (setPhase("form"), setOtp("")) : navigate("/driver-entry"))} className="relative z-10 flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors mt-6 ml-5 w-fit" style={{ animation: "fade-in 0.3s ease both" }}>
        <ArrowLeft className="w-4 h-4" />
        <span className="text-sm">Back</span>
      </button>

      {/* Header */}
      <div className="relative z-10 flex flex-col items-center pt-8 pb-6 px-6 text-center" style={{ animation: "fade-down 0.45s ease 0.05s both" }}>
        <div className="w-12 h-12 rounded-xl bg-primary flex items-center justify-center mb-5" style={{ boxShadow: "0 0 24px hsl(var(--primary)/0.4)" }}>
          <img
            src="/motofix-logo.png"
            alt="MOTOFIX"
            className="w-8 h-8 object-contain"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        </div>

        {phase === "form" ? (
          <>
            <h1 className="text-2xl font-black text-foreground">Get help fast.</h1>
            <p className="text-muted-foreground text-sm mt-1.5 max-w-xs leading-relaxed">No uploads, no long forms. Just a few details and a quick phone verification.</p>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-black text-foreground">One last step.</h1>
            <p className="text-muted-foreground text-sm mt-1.5 max-w-xs leading-relaxed">
              Enter the 6-digit code sent to <span className="text-foreground font-semibold">{phone}</span>.
            </p>
          </>
        )}
      </div>

      {/* ── Content ── */}
      <div className="relative z-10 flex flex-col flex-1 px-5 pb-10 max-w-md mx-auto w-full" key={phase} style={{ animation: "fade-up 0.35s ease both" }}>
        {/* ══ FORM PHASE ══ */}
        {phase === "form" && (
          <form onSubmit={handleSendCode} className="space-y-4">
            {/* Full Name */}
            <div>
              <label className="text-xs font-semibold text-green-400 uppercase tracking-widest block mb-2">Full Name</label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-green-400" />
                <Input placeholder="e.g. Kakooza Morgan" value={fullName} onChange={(e) => setFullName(e.target.value)} className={inputCls} autoCapitalize="words" autoFocus />
              </div>
            </div>

            {/* Phone */}
            <div>
              <label className="text-xs font-semibold text-green-400 uppercase tracking-widest block mb-2">Phone Number</label>
              <div className="relative">
                <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-green-400" />
                <Input type="tel" placeholder="0700 123 456" value={phone} onChange={(e) => setPhone(e.target.value)} className={inputCls} />
              </div>
              <p className="text-[11px] text-muted-foreground/60 mt-1 pl-1">We'll send a verification code here — no password needed.</p>
            </div>

            {/* Number plate */}
            <div>
              <label className="text-xs font-semibold text-green-400 uppercase tracking-widest block mb-2">Vehicle Number Plate</label>
              <div className="relative">
                <Car className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-green-400" />
                <Input placeholder="e.g. UAA 111A or UA 123BG" value={numberPlate} onChange={(e) => handlePlateChange(e.target.value)} className={`${inputCls} tracking-widest font-mono`} maxLength={9} />
              </div>
              <p className="text-[11px] text-muted-foreground/60 mt-1 pl-1">Works for all Ugandan plates — classic (UAA 111A) and new tracked (UA 123BG).</p>
            </div>

            <Button type="submit" className="w-full h-12 bg-green-600 hover:bg-green-500 text-white font-semibold border-0 mt-2" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Sending code…
                </>
              ) : (
                <>
                  Complete Registration <ArrowRight className="w-4 h-4" />
                </>
              )}
            </Button>

            <p className="text-[11px] text-muted-foreground/50 text-center leading-relaxed pt-1">Your phone number verifies your identity. False service requests may result in account suspension.</p>
          </form>
        )}

        {/* ══ OTP PHASE ══ */}
        {phase === "otp" && (
          <form onSubmit={handleVerify} className="space-y-5">
            {/* Summary card */}
            <div className="rounded-xl p-4 space-y-2" style={{ background: "rgba(34,197,94,0.06)", border: "1px solid rgba(34,197,94,0.15)" }}>
              <p className="text-[10px] font-bold uppercase tracking-widest text-green-400 mb-2">Your details</p>
              <SummaryRow label="Name" value={fullName.trim()} />
              <SummaryRow label="Phone" value={phone} />
              <SummaryRow label="Plate" value={numberPlate.trim().toUpperCase()} />
            </div>

            {/* OTP input */}
            <div>
              <label className="text-xs font-semibold text-green-400 uppercase tracking-widest block mb-2">Verification Code</label>
              <div className="relative">
                <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-green-400" />
                <Input type="text" inputMode="numeric" placeholder="· · · · · ·" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))} className={`${inputCls} tracking-[0.6em] text-center font-mono text-lg`} maxLength={6} autoFocus />
              </div>
            </div>

            <Button type="submit" className="w-full h-12 bg-green-600 hover:bg-green-500 text-white font-semibold border-0" disabled={otp.length < 6}>
              Create My Account <ArrowRight className="w-4 h-4" />
            </Button>

            <div className="text-center">
              <button type="button" onClick={handleResend} disabled={cooldown > 0 || resending} className="text-xs transition-colors" style={{ color: cooldown > 0 ? "var(--muted-foreground)" : "var(--accent-green)" }}>
                {resending ? "Sending…" : cooldown > 0 ? `Resend code in ${cooldown}s` : "Didn't receive a code? Resend"}
              </button>
            </div>

            <button
              type="button"
              onClick={() => {
                setPhase("form");
                setOtp("");
              }}
              className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors text-center"
            >
              Wrong number? Go back
            </button>
          </form>
        )}

        {/* Log in link */}
        <div className="mt-8 flex flex-col items-center gap-3">
          <div className="flex items-center gap-3 w-full">
            <div style={{ height: 1, flex: 1, background: "var(--border-2)" }} />
            <span className="text-xs text-muted-foreground/60">Already registered?</span>
            <div style={{ height: 1, flex: 1, background: "var(--border-2)" }} />
          </div>
          <button onClick={() => navigate("/login")} className="text-sm font-semibold transition-colors" style={{ color: "var(--accent-blue)" }}>
            Log in instead →
          </button>
        </div>
      </div>

      <style>{`
        @keyframes fade-in   { from { opacity: 0; }                              to { opacity: 1; } }
        @keyframes fade-down { from { opacity: 0; transform: translateY(-16px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes fade-up   { from { opacity: 0; transform: translateY(16px); }  to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm gap-4">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="font-medium text-foreground text-right truncate">{value || "—"}</span>
    </div>
  );
}
