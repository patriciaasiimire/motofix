// Login.tsx — the admin sign-in screen (email + password). On success it saves the admin
// token via lib/api and sends them to the dashboard; already-logged-in admins skip straight through.

import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { adminLogin, isAuthenticated } from "@/lib/api";
import { toast } from "sonner";
import { Lock, Mail, Loader2, Eye, EyeOff, ShieldCheck, Activity, Users, Wrench } from "lucide-react";

// ── Phase sequence ────────────────────────────────────────────────
type Phase = "idle" | "ring" | "scan" | "logo" | "text" | "ready" | "reveal";

const SCHEDULE: [number, Phase][] = [
  [80,   "ring"],
  [350,  "scan"],
  [600,  "logo"],
  [900,  "text"],
  [1200, "ready"],
  [1600, "reveal"],
];

const PHASE_ORDER: Phase[] = ["idle", "ring", "scan", "logo", "text", "ready", "reveal"];
const after = (current: Phase, from: Phase) => PHASE_ORDER.indexOf(current) >= PHASE_ORDER.indexOf(from);

// ── Ring geometry ─────────────────────────────────────────────────
const R = 110;
const R_OUT = 104;
const R_DRAW = 93;
const R_ACC = 76;
const CIRC = 2 * Math.PI * R_DRAW;

const FEATURES = [
  { icon: Activity, label: "Live Request Tracking" },
  { icon: Users, label: "Provider Management" },
  { icon: Wrench, label: "Fleet Oversight" },
  { icon: ShieldCheck, label: "Secure & Audited" },
];

// ─────────────────────────────────────────────────────────────────
export default function Login() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("idle");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const ids = SCHEDULE.map(([ms, p]) => setTimeout(() => setPhase(p), ms));
    return () => ids.forEach(clearTimeout);
  }, []);

  // Back-button landed here while already signed in → go to the dashboard, not re-login.
  useEffect(() => { if (isAuthenticated()) navigate('/dashboard', { replace: true }); }, [navigate]);

  // Both panels slide simultaneously on the same phase
  const revealed = after(phase, "reveal");

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const em = email.trim();
    const pw = password.trim();
    if (!em || !pw) {
      toast.error("Please enter your email and password");
      return;
    }
    setLoading(true);
    try {
      await adminLogin(em, pw);
      sessionStorage.setItem('motofix_just_logged_in', '1');
      navigate("/dashboard");
    } catch (err: any) {
      const s = err?.status ?? err?.response?.status;
      toast.error(s === 401 || s === 429 ? "Invalid email or password" : "Login failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  // ── The key trick: only transforms & opacity — zero layout reflow ──
  //
  // Content column sits at left:50%, centered on screen via translateX(-50%).
  // On reveal it shifts left by 22.5vw so it's centred inside the 55vw panel.
  //
  // Right panel starts translateX(100%) (off-screen right), slides to 0.
  // Neither transition touches width/height/margin — fully GPU-composited.

  const SLIDE = "cubic-bezier(0.22, 1, 0.36, 1)";
  const contentX = revealed
    ? "translate3d(calc(-50% - 22.5vw), -50%, 0)"
    : "translate3d(-50%, -50%, 0)";

  return (
    <div style={{ position: "fixed", inset: 0, overflow: "hidden", background: "linear-gradient(135deg, hsl(43 60% 97%) 0%, hsl(38 80% 95%) 50%, hsl(43 60% 97%) 100%)", fontFamily: "Inter, sans-serif" }}>
      {/* ── Full-screen grid ── */}
      <div style={{ position: "absolute", inset: 0, opacity: 0.3, pointerEvents: "none" }}>
        <svg width="100%" height="100%">
          <defs>
            <pattern id="g" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="hsl(var(--foreground)/0.08)" strokeWidth="0.5" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#g)" />
        </svg>
      </div>

      {/* Radial vignette — uses theme background so it works in both light and dark */}
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse at 50% 50%, transparent 30%, hsl(var(--background)) 75%)", pointerEvents: "none" }} />

      {/* ── Floating background shapes ── */}
      <FloatingShapes />

      {/* Ambient glow — follows content centre */}
      <div
        style={{
          position: "absolute",
          borderRadius: "50%",
          pointerEvents: "none",
          width: 500,
          height: 500,
          background: "hsl(var(--primary)/0.12)",
          filter: "blur(120px)",
          top: "50%",
          left: "50%",
          transform: revealed ? "translate3d(calc(-50% - 22.5vw), -50%, 0)" : "translate3d(-50%, -50%, 0)",
          transition: `transform 1s ${SLIDE}`,
          willChange: "transform",
        }}
      />

      {/* ── Corner brackets ── */}
      {(["tl", "tr", "bl", "br"] as const).map((pos, i) => (
        <CornerBracket key={pos} pos={pos} visible={after(phase, "text")} delay={i * 75} />
      ))}

      {/* ── Scan line — always rendered, transform-only animation (no top reflow) ── */}
      <div
        style={{
          position: "absolute",
          top: 0, left: 0, right: 0,
          height: 1, zIndex: 10, pointerEvents: "none",
          background: "linear-gradient(90deg,transparent,hsl(var(--primary)/0.85),transparent)",
          boxShadow: "0 0 14px hsl(var(--primary)/0.65)",
          willChange: "transform, opacity",
          animation: after(phase, "scan") ? "scan-line 1.3s ease forwards" : "none",
          opacity: after(phase, "scan") ? undefined : 0,
        }}
      />


      {/* ════════════════════════════════════════════════════════════
          SPLASH CONTENT — centred on screen, then slides left
      ════════════════════════════════════════════════════════════ */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          transform: contentX,
          transition: `transform 1s ${SLIDE}`,
          willChange: "transform",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          width: "min(440px, 85vw)",
        }}
      >
        {/* Ring + logo */}
        <div style={{ position: "relative", width: R * 2, height: R * 2, marginBottom: 28, flexShrink: 0 }}>
          <svg viewBox={`0 0 ${R * 2} ${R * 2}`} fill="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
            <circle cx={R} cy={R} r={R_OUT} stroke="hsl(var(--primary)/0.18)" strokeWidth="1" />

            {after(phase, "ring") &&
              Array.from({ length: 32 }).map((_, i) => {
                const rad = (i / 32) * 2 * Math.PI;
                const r2 = i % 4 === 0 ? R_OUT - 9 : R_OUT - 5;
                return (
                  <line
                    key={i}
                    x1={R + R_OUT * Math.cos(rad)}
                    y1={R + R_OUT * Math.sin(rad)}
                    x2={R + r2 * Math.cos(rad)}
                    y2={R + r2 * Math.sin(rad)}
                    stroke={`hsl(var(--primary)/${i % 4 === 0 ? "0.65" : "0.28"})`}
                    strokeWidth={i % 4 === 0 ? 1.5 : 0.8}
                    style={{ opacity: 0, animation: `tick-in 0.1s ease ${i * 18}ms forwards` }}
                  />
                );
              })}

            {after(phase, "ring") && (
              <circle
                cx={R}
                cy={R}
                r={R_DRAW}
                stroke="hsl(var(--primary))"
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray={CIRC}
                strokeDashoffset={CIRC}
                transform={`rotate(-90 ${R} ${R})`}
                style={{ animation: "draw-ring 1.25s cubic-bezier(0.4,0,0.2,1) forwards", filter: "drop-shadow(0 0 7px hsl(var(--primary)/0.7))" }}
              />
            )}

            {after(phase, "logo") && <circle cx={R} cy={R} r={R_ACC} stroke="hsl(var(--primary)/0.30)" strokeWidth="1" strokeDasharray="5 7" style={{ animation: "fade-in 0.4s ease forwards" }} />}
          </svg>

          {/* Logo badge */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              opacity: after(phase, "logo") ? 1 : 0,
              transform: after(phase, "logo") ? "scale(1)" : "scale(0.3)",
              transition: "transform 0.55s cubic-bezier(0.34,1.56,0.64,1), opacity 0.3s ease",
              willChange: "transform",
            }}
          >
            <div style={{ position: "absolute", width: 140, height: 140, borderRadius: "50%", background: "hsl(var(--primary)/0.12)", filter: "blur(22px)", animation: "pulse-halo 2.6s ease-in-out infinite" }} />
            <div
              style={{
                position: "relative",
                width: 112,
                height: 112,
                borderRadius: 26,
                background: "hsl(var(--primary)/0.12)",
                border: "2.5px solid hsl(var(--primary)/0.85)",
                boxShadow: "0 0 0 1px hsl(var(--primary)/0.2),0 0 32px hsl(var(--primary)/0.55),0 0 70px hsl(var(--primary)/0.2),inset 0 1px 0 hsl(var(--primary)/0.15)",
                animation: after(phase, "logo") ? "flicker 0.6s ease forwards" : undefined,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <img
                src="/logo.png"
                alt="MOTOFIX"
                style={{ width: 88, height: 88, objectFit: "contain" }}
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
            </div>
          </div>

          {/* Arc labels */}
          {after(phase, "text") && (
            <>
              <ArcLabel text="Secure Access" top={-22} />
              <ArcLabel text="Control Room" bottom={-22} />
            </>
          )}
        </div>

        {/* Wordmark */}
        <div style={{ display: "flex", alignItems: "flex-end", gap: 2, overflow: "hidden", height: 50, marginBottom: 10 }}>
          {"MOTOFIX".split("").map((ch, i) => (
            <span
              key={i}
              style={{
                fontSize: 40,
                fontWeight: 900,
                letterSpacing: "0.13em",
                color: "hsl(var(--foreground))",
                display: "inline-block",
                transform: after(phase, "text") ? "translateY(0)" : "translateY(54px)",
                opacity: after(phase, "text") ? 1 : 0,
                transition: `transform 0.4s cubic-bezier(0.34,1.56,0.64,1) ${i * 55}ms, opacity 0.25s ease ${i * 55}ms`,
                willChange: "transform",
              }}
            >
              {ch}
            </span>
          ))}
        </div>

        {/* Sub-label */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 18,
            opacity: after(phase, "text") ? 1 : 0,
            transform: after(phase, "text") ? "translateY(0)" : "translateY(8px)",
            transition: "opacity 0.5s ease 0.5s, transform 0.5s ease 0.5s",
            willChange: "transform",
          }}
        >
          <div style={{ height: 1, width: 28, background: "hsl(var(--primary)/0.55)" }} />
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.38em", textTransform: "uppercase", color: "hsl(var(--primary))" }}>Admin Control Room</span>
          <div style={{ height: 1, width: 28, background: "hsl(var(--primary)/0.55)" }} />
        </div>

        {/* SYSTEM READY */}
        <div
          style={{
            opacity: after(phase, "ready") ? 1 : 0,
            transform: after(phase, "ready") ? "translateY(0)" : "translateY(6px)",
            transition: "opacity 0.45s ease, transform 0.45s ease",
            willChange: "transform",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 18px",
              borderRadius: 20,
              border: "1.5px solid hsl(var(--primary)/0.42)",
              background: "hsl(var(--primary)/0.10)",
            }}
          >
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "hsl(var(--primary))", animation: "pulse-dot 1s ease-in-out infinite" }} />
            <span style={{ fontSize: 11, fontFamily: "JetBrains Mono,monospace", fontWeight: 700, letterSpacing: "0.18em", color: "hsl(var(--primary))" }}>SYSTEM READY</span>
          </div>
        </div>

        {/* Feature list — 2×2 grid, only mounted after reveal */}
        {revealed && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 10,
              width: "100%",
              marginTop: 28,
              animation: "fade-in 0.5s ease 0.4s both",
            }}
          >
            {FEATURES.map(({ icon: Icon, label }) => (
              <div key={label} style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "10px 13px", borderRadius: 10,
                background: "hsl(38 85% 92%)",
                border: "2px solid hsl(38 75% 55%)",
                boxShadow: "0 2px 8px hsl(38 75% 55% / 0.18), inset 0 1px 0 hsl(43 90% 96%)",
              }}>
                <div style={{
                  width: 30, height: 30, borderRadius: 7,
                  background: "hsl(38 85% 52%)",
                  border: "1.5px solid hsl(32 80% 42%)",
                  boxShadow: "0 2px 6px hsl(38 75% 45% / 0.35)",
                  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                }}>
                  <Icon size={14} style={{ color: "#fff" }} />
                </div>
                <span style={{ fontSize: 11.5, color: "hsl(32 80% 22%)", fontWeight: 700, lineHeight: 1.3, letterSpacing: "0.01em" }}>{label}</span>
              </div>
            ))}
          </div>
        )}
      </div>


      {/* ════════════════════════════════════════════════════════════
          RIGHT PANEL — visible immediately, slides to final pos
      ════════════════════════════════════════════════════════════ */}
      <div
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          bottom: 0,
          width: "45%",
          background: "hsl(43 55% 96%)",
          transform: revealed ? "translate3d(0,0,0)" : "translate3d(100%,0,0)",
          transition: `transform 1s ${SLIDE}`,
          willChange: "transform",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "48px 40px",
          overflow: "auto",
        }}
      >
        {/* Floating shapes inside right panel */}
        <FloatingShapes right />

        <div style={{ position: "relative", zIndex: 1, width: "100%", maxWidth: 400 }}>
          <div style={{ marginBottom: 36 }}>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 14px", borderRadius: 20, background: "#fff4d6", border: "1px solid #e8c36c", marginBottom: 18 }}>
              <ShieldCheck size={12} style={{ color: "#805300" }} />
              <span style={{ fontSize: 10, fontFamily: "JetBrains Mono,monospace", fontWeight: 700, letterSpacing: "0.22em", textTransform: "uppercase", color: "#805300" }}>Administrator</span>
            </div>
            <h2 style={{ fontSize: 32, fontWeight: 800, letterSpacing: "-0.025em", lineHeight: 1.15, color: "#171923", marginBottom: 10 }}>Welcome back.</h2>
            <p style={{ fontSize: 14, color: "#4b5563", lineHeight: 1.65 }}>Sign in with your administrator credentials to access the MOTOFIX control room.</p>
          </div>

          <form onSubmit={handleLogin} style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div>
              <label htmlFor="admin-email" style={{ display: "block", fontSize: 11, fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", color: "#805300", marginBottom: 8 }}>Email Address</label>
              <div style={{ position: "relative" }}>
                <Mail size={15} style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "hsl(var(--muted-foreground))" }} />
                <input
                  id="admin-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@motofix.ug"
                  autoFocus={revealed}
                  autoComplete="email"
                  required
                  style={{
                    width: "100%",
                    height: 50,
                    borderRadius: 12,
                    boxSizing: "border-box",
                    background: "hsl(var(--muted))",
                    border: "1.5px solid hsl(var(--border))",
                    color: "hsl(var(--foreground))",
                    fontSize: 14,
                    paddingLeft: 42,
                    paddingRight: 16,
                    outline: "none",
                    fontFamily: "Inter,sans-serif",
                    transition: "border-color 0.2s, box-shadow 0.2s",
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = "hsl(var(--primary)/0.7)";
                    e.target.style.boxShadow = "0 0 0 3px hsl(var(--primary)/0.12)";
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = "hsl(var(--border))";
                    e.target.style.boxShadow = "none";
                  }}
                />
              </div>
            </div>

            <div>
              <label htmlFor="admin-password" style={{ display: "block", fontSize: 11, fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", color: "#805300", marginBottom: 8 }}>Password</label>
              <div style={{ position: "relative" }}>
                <Lock size={15} style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "hsl(var(--muted-foreground))" }} />
                <input
                  id="admin-password"
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  autoComplete="current-password"
                  required
                  style={{
                    width: "100%",
                    height: 50,
                    borderRadius: 12,
                    boxSizing: "border-box",
                    background: "hsl(var(--muted))",
                    border: "1.5px solid hsl(var(--border))",
                    color: "hsl(var(--foreground))",
                    fontSize: 14,
                    paddingLeft: 42,
                    paddingRight: 50,
                    outline: "none",
                    fontFamily: "Inter,sans-serif",
                    transition: "border-color 0.2s, box-shadow 0.2s",
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = "hsl(var(--primary)/0.7)";
                    e.target.style.boxShadow = "0 0 0 3px hsl(var(--primary)/0.12)";
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = "hsl(var(--border))";
                    e.target.style.boxShadow = "none";
                  }}
                />
                <button type="button" aria-label={showPw ? "Hide password" : "Show password"} aria-pressed={showPw} onClick={() => setShowPw((v) => !v)} style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#c6c7d2", padding: 0, display: "flex" }}>
                  {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading || !email || !password}
              style={{
                width: "100%",
                height: 50,
                borderRadius: 12,
                border: "none",
                fontFamily: "Inter,sans-serif",
                fontWeight: 700,
                fontSize: 15,
                cursor: loading || !email || !password ? "not-allowed" : "pointer",
                background: loading || !email || !password ? "hsl(var(--muted))" : "linear-gradient(135deg,hsl(var(--primary)),hsl(38 92% 36%))",
                color: loading || !email || !password ? "hsl(var(--muted-foreground))" : "hsl(var(--primary-foreground))",
                boxShadow: loading || !email || !password ? "none" : "0 4px 22px hsl(var(--primary)/0.38)",
                transition: "all 0.2s",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
              }}
            >
              {loading ? (
                <>
                  <Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} /> Authenticating…
                </>
              ) : (
                "Login to Dashboard"
              )}
            </button>
          </form>

          <div style={{ marginTop: 28, padding: "14px 16px", borderRadius: 12, background: "#232334", border: "1px solid #39394e", display: "flex", alignItems: "flex-start", gap: 10 }}>
            <ShieldCheck size={15} style={{ color: "hsl(var(--primary))", flexShrink: 0, marginTop: 1 }} />
            <p style={{ fontSize: 12, color: "#d1d2dc", lineHeight: 1.65 }}>Restricted to authorised MOTOFIX administrators only. All access is logged and audited.</p>
          </div>
        </div>

      </div>

      <style>{`
        @keyframes draw-ring  { to { stroke-dashoffset: 0; } }
        @keyframes tick-in    { to { opacity: 1; } }
        @keyframes fade-in    { from { opacity: 0; } to { opacity: 1; } }
        @keyframes scan-line  { 0%{transform:translateY(10vh);opacity:0} 8%{transform:translateY(10vh);opacity:1} 100%{transform:translateY(90vh);opacity:0} }
        @keyframes flicker    { 0%,19%,21%,23%,25%,54%,56%,100%{opacity:1} 20%,22%,24%,55%{opacity:0.35} }
        @keyframes pulse-dot  { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.4;transform:scale(0.6)} }
        @keyframes pulse-halo { 0%,100%{opacity:0.6;transform:scale(1)} 50%{opacity:1;transform:scale(1.16)} }
        @keyframes spin       { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
        @keyframes bracket-tl { from{transform:translate(-12px,-12px);opacity:0} to{transform:translate(0,0);opacity:1} }
        @keyframes bracket-tr { from{transform:translate(12px,-12px);opacity:0}  to{transform:translate(0,0);opacity:1} }
        @keyframes bracket-bl { from{transform:translate(-12px,12px);opacity:0}  to{transform:translate(0,0);opacity:1} }
        @keyframes bracket-br { from{transform:translate(12px,12px);opacity:0}   to{transform:translate(0,0);opacity:1} }
        @keyframes float-up   { 0%{transform:translateY(0) rotate(0deg);opacity:0} 10%{opacity:1} 90%{opacity:0.6} 100%{transform:translateY(-110vh) rotate(360deg);opacity:0} }
        @keyframes float-drift{ 0%{transform:translate(0,0) rotate(0deg) scale(1)} 33%{transform:translate(18px,-22px) rotate(120deg) scale(1.08)} 66%{transform:translate(-14px,-44px) rotate(240deg) scale(0.94)} 100%{transform:translate(0,0) rotate(360deg) scale(1)} }
        @keyframes float-sway { 0%,100%{transform:translateY(0) rotate(0deg)} 50%{transform:translateY(-20px) rotate(8deg)} }
        @keyframes float-orb  { 0%,100%{transform:translate(0,0) scale(1);opacity:0.18} 50%{transform:translate(10px,-16px) scale(1.12);opacity:0.28} }
      `}</style>
    </div>
  );
}

function ArcLabel({ text, top, bottom }: { text: string; top?: number; bottom?: number }) {
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: top !== undefined ? top : undefined,
        bottom: bottom !== undefined ? bottom : undefined,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        gap: 6,
        animation: "fade-in 0.4s ease 0.35s both",
      }}
    >
      <div style={{ height: 1, width: 14, background: "hsl(var(--primary)/0.5)" }} />
      <span style={{ fontSize: 7, fontFamily: "JetBrains Mono,monospace", fontWeight: 700, letterSpacing: "0.3em", textTransform: "uppercase", color: "hsl(var(--primary)/0.7)" }}>{text}</span>
      <div style={{ height: 1, width: 14, background: "hsl(var(--primary)/0.5)" }} />
    </div>
  );
}

// ── Floating background decorations ─────────────────────────────
function FloatingShapes({ right = false }: { right?: boolean }) {
  // Wrench SVG path (simplified)
  const wrenchPath = "M17.27 6.73a4 4 0 0 0-5.54 5.54L3 21l3 3 9.73-8.73a4 4 0 0 0 5.54-5.54l-2.73 2.73-2-2 2.73-2.73z";
  const gearPath   = "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.07-2.14a7 7 0 0 0 .07-1 7 7 0 0 0-.07-.93l2-1.56a.5.5 0 0 0 .12-.63l-1.9-3.28a.5.5 0 0 0-.6-.22l-2.35.95a6.9 6.9 0 0 0-1.6-.93l-.36-2.5A.49.49 0 0 0 14 3h-3.8a.49.49 0 0 0-.49.42l-.36 2.5a6.9 6.9 0 0 0-1.6.93l-2.35-.95a.48.48 0 0 0-.6.22L3 9.4a.47.47 0 0 0 .12.63l2 1.56A7.2 7.2 0 0 0 5 12a7.2 7.2 0 0 0 .07.93l-2 1.56a.5.5 0 0 0-.12.63l1.9 3.28c.12.22.37.3.6.22l2.35-.95c.5.36 1.03.66 1.6.93l.36 2.5c.06.24.27.42.49.42H14c.22 0 .43-.18.49-.42l.36-2.5a6.9 6.9 0 0 0 1.6-.93l2.35.95c.23.08.48 0 .6-.22l1.9-3.28a.47.47 0 0 0-.12-.63l-2.11-1.56z";

  type ShapeEntry = {
    left: string; top: string; size: number; anim: string; dur: string; delay: string;
    opacity: number; shape: "circle" | "hex" | "diamond" | "wrench" | "gear" | "ring";
    color: string;
  };

  const leftShapes: ShapeEntry[] = [
    { left:"7%",  top:"15%", size:36, anim:"float-sway", dur:"7s",  delay:"0s",    opacity:0.42, shape:"hex",     color:"#d97706" },
    { left:"14%", top:"70%", size:28, anim:"float-drift",dur:"11s", delay:"1.2s",  opacity:0.38, shape:"diamond", color:"#f59e0b" },
    { left:"22%", top:"40%", size:24, anim:"float-sway", dur:"9s",  delay:"3s",    opacity:0.35, shape:"circle",  color:"#d97706" },
    { left:"3%",  top:"50%", size:30, anim:"float-drift",dur:"14s", delay:"0.5s",  opacity:0.32, shape:"ring",    color:"#f59e0b" },
    { left:"18%", top:"88%", size:26, anim:"float-sway", dur:"8s",  delay:"2s",    opacity:0.40, shape:"wrench",  color:"#b45309" },
    { left:"30%", top:"20%", size:24, anim:"float-drift",dur:"12s", delay:"4s",    opacity:0.36, shape:"gear",    color:"#d97706" },
    { left:"38%", top:"75%", size:32, anim:"float-sway", dur:"10s", delay:"1s",    opacity:0.30, shape:"hex",     color:"#f59e0b" },
    { left:"45%", top:"10%", size:20, anim:"float-drift",dur:"9s",  delay:"2.5s",  opacity:0.38, shape:"diamond", color:"#d97706" },
    { left:"50%", top:"50%", size:44, anim:"float-orb",  dur:"6s",  delay:"0s",    opacity:0.25, shape:"ring",    color:"#fbbf24" },
    { left:"10%", top:"32%", size:20, anim:"float-sway", dur:"7s",  delay:"4.5s",  opacity:0.40, shape:"gear",    color:"#d97706" },
  ];

  const rightShapes: ShapeEntry[] = [
    { left:"8%",  top:"8%",  size:28, anim:"float-sway", dur:"8s",  delay:"0.3s",  opacity:0.38, shape:"hex",     color:"#d97706" },
    { left:"70%", top:"12%", size:22, anim:"float-drift",dur:"11s", delay:"1.8s",  opacity:0.40, shape:"wrench",  color:"#b45309" },
    { left:"40%", top:"22%", size:24, anim:"float-sway", dur:"9s",  delay:"0.6s",  opacity:0.35, shape:"gear",    color:"#d97706" },
    { left:"85%", top:"35%", size:26, anim:"float-drift",dur:"12s", delay:"2.4s",  opacity:0.38, shape:"diamond", color:"#f59e0b" },
    { left:"15%", top:"45%", size:30, anim:"float-sway", dur:"7s",  delay:"1s",    opacity:0.32, shape:"ring",    color:"#f59e0b" },
    { left:"55%", top:"52%", size:38, anim:"float-orb",  dur:"6s",  delay:"0s",    opacity:0.22, shape:"ring",    color:"#fbbf24" },
    { left:"25%", top:"65%", size:24, anim:"float-drift",dur:"10s", delay:"3.2s",  opacity:0.36, shape:"circle",  color:"#d97706" },
    { left:"78%", top:"70%", size:28, anim:"float-sway", dur:"9s",  delay:"0.9s",  opacity:0.40, shape:"hex",     color:"#f59e0b" },
    { left:"5%",  top:"80%", size:22, anim:"float-drift",dur:"13s", delay:"2s",    opacity:0.38, shape:"gear",    color:"#b45309" },
    { left:"60%", top:"82%", size:26, anim:"float-sway", dur:"8s",  delay:"1.4s",  opacity:0.36, shape:"wrench",  color:"#d97706" },
    { left:"45%", top:"90%", size:20, anim:"float-drift",dur:"11s", delay:"3.6s",  opacity:0.34, shape:"diamond", color:"#f59e0b" },
    { left:"88%", top:"55%", size:24, anim:"float-sway", dur:"10s", delay:"0.5s",  opacity:0.40, shape:"circle",  color:"#d97706" },
    { left:"32%", top:"38%", size:20, anim:"float-drift",dur:"9s",  delay:"2.8s",  opacity:0.38, shape:"hex",     color:"#b45309" },
    { left:"72%", top:"25%", size:30, anim:"float-sway", dur:"12s", delay:"1.1s",  opacity:0.32, shape:"ring",    color:"#f59e0b" },
  ];

  const shapes = right ? rightShapes : leftShapes;

  return (
    <div style={{ position:"absolute", inset:0, pointerEvents:"none", zIndex:0 }}>
      {shapes.map((s, i) => {
        const common: React.CSSProperties = {
          position:"absolute", left:s.left, top:s.top,
          width:s.size, height:s.size,
          opacity:s.opacity,
          animation:`${s.anim} ${s.dur} ${s.delay} ease-in-out infinite`,
        };

        if (s.shape === "circle") return (
          <div key={i} style={{ ...common, borderRadius:"50%", border:`1.5px solid ${s.color}`, background:"transparent" }} />
        );
        if (s.shape === "ring") return (
          <div key={i} style={{ ...common, borderRadius:"50%", border:`2px solid ${s.color}`, background:"transparent" }} />
        );
        if (s.shape === "diamond") return (
          <div key={i} style={{ ...common, transform:"rotate(45deg)", border:`1.5px solid ${s.color}`, background:`${s.color}18`, borderRadius:3 }} />
        );
        if (s.shape === "hex") return (
          <svg key={i} style={{ ...common }} viewBox="0 0 24 24" fill="none">
            <polygon points="12,2 21,7 21,17 12,22 3,17 3,7" stroke={s.color} strokeWidth="1.5" fill={`${s.color}15`} />
          </svg>
        );
        if (s.shape === "wrench") return (
          <svg key={i} style={{ ...common }} viewBox="0 0 24 24" fill="none">
            <path d={wrenchPath} stroke={s.color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        );
        if (s.shape === "gear") return (
          <svg key={i} style={{ ...common }} viewBox="0 0 24 24" fill="none">
            <path d={gearPath} stroke={s.color} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        );
        return null;
      })}
    </div>
  );
}

function CornerBracket({ pos, visible, delay }: { pos: "tl" | "tr" | "bl" | "br"; visible: boolean; delay: number }) {
  const size = 18;
  const paths = { tl: `M ${size} 0 L 0 0 L 0 ${size}`, tr: `M 0 0 L ${size} 0 L ${size} ${size}`, bl: `M 0 0 L 0 ${size} L ${size} ${size}`, br: `M 0 ${size} L ${size} ${size} L ${size} 0` };
  const pos2style: Record<string, React.CSSProperties> = { tl: { top: 24, left: 24 }, tr: { top: 24, right: 24 }, bl: { bottom: 24, left: 24 }, br: { bottom: 24, right: 24 } };
  return (
    <div style={{ position: "absolute", zIndex: 20, ...pos2style[pos], opacity: visible ? 1 : 0, animation: visible ? `bracket-${pos} 0.4s ease ${delay}ms both` : undefined }}>
      <svg width={size} height={size} fill="none">
        <path d={paths[pos]} stroke="hsl(var(--primary)/0.65)" strokeWidth="2" strokeLinecap="square" />
      </svg>
    </div>
  );
}
