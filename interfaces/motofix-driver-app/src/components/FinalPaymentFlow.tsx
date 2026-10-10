// FinalPaymentFlow.tsx — the end-of-job payment screen shown to the driver once the
// mechanic finishes. It presents the agreed charge and what was fixed, then lets the
// driver pay by Mobile Money (MTN/Airtel) or mark it as cash. Replaced the old
// QuoteModal. NOTE: the MoMo fee math here is a demo simulation, not a real charge.

import { useEffect, useState } from 'react'
import { CheckCircle2, Loader2, Smartphone, DollarSign, Sparkles, ArrowRight, Wrench, MessageSquare } from 'lucide-react'

const PURPLE = '#A78BFA'
const GREEN  = '#22C55E'

function fmt(n: number) { return 'UGX ' + Math.round(n).toLocaleString() }

// Simulated MTN/Airtel MoMo withdrawal tariff (UGX). Added on top so the mechanic
// nets the full quoted amount after cashing out. (Demo only — no real charge.)
function momoWithdrawFee(amount: number): number {
  const a = Math.max(0, amount)
  if (a <= 2500)    return 0
  if (a <= 5000)    return 440
  if (a <= 15000)   return 700
  if (a <= 30000)   return 1045
  if (a <= 45000)   return 1320
  if (a <= 60000)   return 1485
  if (a <= 125000)  return 1815
  if (a <= 250000)  return 3850
  if (a <= 500000)  return 6050
  if (a <= 1000000) return 7150
  return 12500
}

type Step = 'confirm' | 'method' | 'momo' | 'cash' | 'waiting' | 'notreceived' | 'received'

interface Props {
  requestId: string
  amountDue: number
  mechanicName: string
  mechanicPhone: string | null
  serviceNote?: string | null
  sendMessage: (d: object) => void
  lastMessage: unknown
  onPaid: (method: 'momo' | 'cash') => void
  onMessageMechanic: () => void
}

/**
 * Driver-side end-of-job payment chain (simulation):
 *   confirm service → quote → method → (MoMo gateway w/ AI withdrawal-fee | Cash)
 *   → Complete Payment → wait for the mechanic to confirm receipt → done / cash-fallback.
 * The whole thing blurs + persists over the page; it clears when the mechanic
 * confirms receipt (which flips the request to 'completed' → rating).
 */
export default function FinalPaymentFlow({
  requestId, amountDue, mechanicName, mechanicPhone, serviceNote, sendMessage, lastMessage, onPaid, onMessageMechanic,
}: Props) {
  const [step, setStep] = useState<Step>('confirm')
  // The mechanic's first name for mid-sentence use ("message Bbosa", "pay Bbosa").
  // When there's no real name, fall back to the full phrase "your mechanic" (NOT just
  // "your", which the old split produced from the "your mechanic" placeholder).
  const _first = mechanicName.trim().split(' ')[0]
  const firstName = _first && _first.toLowerCase() !== 'your' ? _first : 'your mechanic'
  // Capitalised form for the start of a sentence.
  const firstNameCap = firstName.charAt(0).toUpperCase() + firstName.slice(1)
  const phone = mechanicPhone || 'the mechanic’s number'

  // ── MoMo gateway state ──
  const [amountStr, setAmountStr] = useState(String(Math.round(amountDue)))
  const [scanning, setScanning]   = useState(false)
  const [fee, setFee]             = useState<number | null>(null)
  const amount = Math.max(0, Math.round(Number(amountStr) || 0))
  const total  = fee != null ? amount + fee : amount

  // "MOTOBOT scan" of the MoMo tariff — runs (debounced) whenever the amount changes
  // on the gateway screen, then auto-adds the withdrawal fee to the total.
  useEffect(() => {
    if (step !== 'momo') return
    setFee(null); setScanning(true)
    const t = setTimeout(() => { setFee(momoWithdrawFee(amount)); setScanning(false) }, 1300)
    return () => clearTimeout(t)
  }, [amountStr, step]) // eslint-disable-line react-hooks/exhaustive-deps

  // Mechanic's acknowledgement (received / not received).
  useEffect(() => {
    const m = lastMessage as { type?: string; service_request_id?: string | number; received?: boolean } | null
    if (!m || m.type !== 'payment_ack' || String(m.service_request_id) !== String(requestId)) return
    setStep(prev => (prev === 'waiting' ? (m.received ? 'received' : 'notreceived') : prev))
  }, [lastMessage, requestId])

  const pay = (method: 'momo' | 'cash', paidAmount: number) => {
    sendMessage({ type: 'payment_completed', service_request_id: requestId, method, amount: paidAmount })
    onPaid(method)
    setStep('waiting')
  }

  // ── shared shells ──
  const Backdrop = (
    <div style={{ position: 'fixed', inset: 0, zIndex: 130, background: 'rgba(0,0,0,0.62)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }} />
  )
  const card: React.CSSProperties = {
    position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 131,
    width: 'calc(100% - 32px)', maxWidth: 400, borderRadius: 24, background: 'var(--overlay-bg)',
    border: `1.5px solid ${PURPLE}55`, boxShadow: '0 24px 80px rgba(0,0,0,0.6)', padding: '22px 20px',
    animation: 'cancel-slide-up 0.3s cubic-bezier(0.34,1.56,0.64,1)', maxHeight: '88vh', overflowY: 'auto',
  }
  const ring = (color: string, Icon: typeof Wrench) => (
    <div style={{ width: 54, height: 54, borderRadius: '50%', margin: '0 auto 14px', background: `${color}1e`, border: `2px solid ${color}55`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Icon style={{ width: 26, height: 26, color }} />
    </div>
  )
  const primaryBtn: React.CSSProperties = {
    width: '100%', height: 52, borderRadius: 15, border: 'none', cursor: 'pointer',
    background: `linear-gradient(135deg, ${PURPLE}, #7C3AED)`, color: '#fff', fontSize: 15, fontWeight: 800,
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
  }
  const ghostBtn: React.CSSProperties = {
    width: '100%', height: 48, borderRadius: 14, cursor: 'pointer',
    background: 'var(--surface-2)', border: '1px solid var(--border-3)', color: 'var(--text-md)', fontSize: 14, fontWeight: 700,
  }

  return (
    <>
      {Backdrop}
      <div style={card}>

        {/* 1 ── Confirm the service was provided ─────────────────────── */}
        {step === 'confirm' && (
          <>
            {ring(PURPLE, Wrench)}
            <h2 style={{ fontSize: 18, fontWeight: 900, color: 'var(--text-hi)', textAlign: 'center', marginBottom: 6 }}>Has the service been provided?</h2>
            <p style={{ fontSize: 13, color: 'var(--text-lo)', textAlign: 'center', lineHeight: 1.55, marginBottom: 18 }}>
              {firstNameCap} marked the job complete. Confirm so you can settle the bill of <strong style={{ color: PURPLE }}>{fmt(amountDue)}</strong>.
            </p>
            <button style={primaryBtn} onClick={() => setStep('method')}><CheckCircle2 style={{ width: 18, height: 18 }} /> Yes, it’s been done</button>
            <button style={{ ...ghostBtn, marginTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }} onClick={onMessageMechanic}>
              <MessageSquare style={{ width: 15, height: 15 }} /> Not yet — message {firstName}
            </button>
          </>
        )}

        {/* 2 ── Quote + choose method ────────────────────────────────── */}
        {step === 'method' && (
          <>
            <p style={{ fontSize: 12, color: 'var(--text-faint)', textAlign: 'center' }}>{firstNameCap} quoted</p>
            <p style={{ fontSize: 32, fontWeight: 900, color: PURPLE, textAlign: 'center', letterSpacing: '-0.02em', marginBottom: serviceNote ? 6 : 16 }}>{fmt(amountDue)}</p>
            {serviceNote && <p style={{ fontSize: 12, color: 'var(--text-lo)', textAlign: 'center', lineHeight: 1.5, marginBottom: 16 }}>{serviceNote}</p>}
            <p style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--text-faint)', marginBottom: 10 }}>How would you like to pay?</p>
            <button onClick={() => setStep('momo')} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderRadius: 14, background: 'var(--surface-2)', border: `1.5px solid ${PURPLE}55`, cursor: 'pointer', textAlign: 'left', width: '100%', marginBottom: 10 }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: `${PURPLE}22`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Smartphone style={{ width: 20, height: 20, color: PURPLE }} /></div>
              <div style={{ flex: 1 }}><p style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-hi)' }}>Airtel / MTN Mobile Money</p><p style={{ fontSize: 12, color: 'var(--text-faint)' }}>Pay to {firstName}’s MoMo number</p></div>
              <ArrowRight style={{ width: 18, height: 18, color: 'var(--text-faint)' }} />
            </button>
            <button onClick={() => setStep('cash')} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderRadius: 14, background: 'var(--surface-2)', border: `1.5px solid ${GREEN}55`, cursor: 'pointer', textAlign: 'left', width: '100%' }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: `${GREEN}22`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><DollarSign style={{ width: 20, height: 20, color: GREEN }} /></div>
              <div style={{ flex: 1 }}><p style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-hi)' }}>Cash</p><p style={{ fontSize: 12, color: 'var(--text-faint)' }}>Pay {firstName} directly</p></div>
              <ArrowRight style={{ width: 18, height: 18, color: 'var(--text-faint)' }} />
            </button>
          </>
        )}

        {/* 3 ── Simulated MoMo gateway ───────────────────────────────── */}
        {step === 'momo' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
              <Smartphone style={{ width: 18, height: 18, color: PURPLE }} />
              <p style={{ fontSize: 15, fontWeight: 900, color: 'var(--text-hi)' }}>Mobile Money</p>
            </div>
            <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', display: 'block', marginBottom: 6 }}>Paying to ({firstName})</label>
            <input value={phone} readOnly style={{ width: '100%', boxSizing: 'border-box', height: 46, borderRadius: 12, border: '1px solid var(--border-3)', background: 'var(--surface-3)', color: 'var(--text-hi)', padding: '0 13px', fontSize: 14.5, fontWeight: 700, marginBottom: 14 }} />

            <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', display: 'block', marginBottom: 6 }}>Amount</label>
            <div style={{ borderRadius: 14, border: `1.5px solid ${PURPLE}44`, background: 'var(--surface-2)', padding: '12px 14px', marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--text-faint)' }}>UGX</span>
                <input value={amountStr} onChange={e => setAmountStr(e.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-hi)', fontSize: 24, fontWeight: 900, letterSpacing: '-0.02em' }} />
              </div>
              {fee != null && fee > 0 && (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--border-3)', display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                  <span style={{ color: 'var(--text-lo)' }}>+ withdrawal charge</span>
                  <span style={{ fontWeight: 800, color: 'var(--text-md)' }}>{fmt(fee)}</span>
                </div>
              )}
              {fee != null && (
                <div style={{ marginTop: 6, display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                  <span style={{ fontWeight: 800, color: 'var(--text-hi)' }}>Total to send</span>
                  <span style={{ fontWeight: 900, color: PURPLE }}>{fmt(total)}</span>
                </div>
              )}
            </div>

            {/* Withdrawal-fee estimate */}
            {scanning ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12.5, color: PURPLE, fontWeight: 700, marginBottom: 14 }}>
                <Loader2 style={{ width: 16, height: 16, animation: 'spin 0.8s linear infinite' }} /> Calculating the MoMo withdrawal charge…
              </div>
            ) : fee != null && (
              <div style={{ display: 'flex', gap: 8, padding: '10px 12px', borderRadius: 12, background: `${PURPLE}14`, border: `1px solid ${PURPLE}33`, marginBottom: 14 }}>
                <Sparkles style={{ width: 14, height: 14, color: PURPLE, flexShrink: 0, marginTop: 1 }} />
                <p style={{ fontSize: 11.5, color: 'var(--text-md)', lineHeight: 1.5 }}>
                  {fee > 0
                    ? <>The estimated MoMo withdrawal charge for {fmt(amount)} is <strong>{fmt(fee)}</strong>. We’ve added it so {firstName} receives the full amount — you’ll send <strong style={{ color: PURPLE }}>{fmt(total)}</strong>.</>
                    : <>No estimated MoMo withdrawal charge applies at this amount.</>}
                </p>
              </div>
            )}

            <button style={{ ...primaryBtn, opacity: scanning || amount <= 0 ? 0.55 : 1, cursor: scanning || amount <= 0 ? 'not-allowed' : 'pointer' }} disabled={scanning || amount <= 0} onClick={() => pay('momo', total)}>
              <Smartphone style={{ width: 18, height: 18 }} /> {scanning ? 'Checking tariff…' : `Complete Payment · ${fmt(total)}`}
            </button>
            <button style={{ ...ghostBtn, marginTop: 10 }} onClick={() => setStep('method')}>Back</button>
            <p style={{ fontSize: 10.5, color: 'var(--text-faint)', textAlign: 'center', marginTop: 12, lineHeight: 1.5 }}>Demo gateway — no real charge is made.</p>
          </>
        )}

        {/* 3b ── Cash ────────────────────────────────────────────────── */}
        {step === 'cash' && (
          <>
            {ring(GREEN, DollarSign)}
            <h2 style={{ fontSize: 18, fontWeight: 900, color: 'var(--text-hi)', textAlign: 'center', marginBottom: 6 }}>Pay {fmt(amountDue)} in cash</h2>
            <p style={{ fontSize: 13, color: 'var(--text-lo)', textAlign: 'center', lineHeight: 1.55, marginBottom: 18 }}>Hand {fmt(amountDue)} to {firstName}. Once you’ve given it to them, tap below and they’ll confirm receipt.</p>
            <button style={{ ...primaryBtn, background: `linear-gradient(135deg, ${GREEN}, #16A34A)` }} onClick={() => pay('cash', amountDue)}><DollarSign style={{ width: 18, height: 18 }} /> Complete Payment</button>
            <button style={{ ...ghostBtn, marginTop: 10 }} onClick={() => setStep('method')}>Back</button>
          </>
        )}

        {/* 4 ── Waiting for the mechanic to confirm receipt ──────────── */}
        {step === 'waiting' && (
          <div style={{ textAlign: 'center', padding: '8px 0' }}>
            <Loader2 style={{ width: 30, height: 30, color: PURPLE, animation: 'spin 1.2s linear infinite', margin: '0 auto 14px' }} />
            <h2 style={{ fontSize: 17, fontWeight: 900, color: 'var(--text-hi)', marginBottom: 6 }}>Payment sent</h2>
            <p style={{ fontSize: 13, color: 'var(--text-lo)', lineHeight: 1.55 }}>Waiting for {firstName} to confirm they’ve received it…</p>
          </div>
        )}

        {/* 4b ── Mechanic says NOT received → cash fallback ──────────── */}
        {step === 'notreceived' && (
          <>
            {ring('#F59E0B', DollarSign)}
            <h2 style={{ fontSize: 17, fontWeight: 900, color: 'var(--text-hi)', textAlign: 'center', marginBottom: 6 }}>{firstNameCap} hasn’t received it</h2>
            <p style={{ fontSize: 13, color: 'var(--text-lo)', textAlign: 'center', lineHeight: 1.55, marginBottom: 18 }}>The Mobile Money payment didn’t reach them. We recommend settling in <strong>cash</strong> instead.</p>
            <button style={{ ...primaryBtn, background: `linear-gradient(135deg, ${GREEN}, #16A34A)` }} onClick={() => setStep('cash')}><CheckCircle2 style={{ width: 18, height: 18 }} /> Agree — pay cash</button>
          </>
        )}

        {/* 5 ── Received ─────────────────────────────────────────────── */}
        {step === 'received' && (
          <div style={{ textAlign: 'center', padding: '8px 0' }}>
            {ring(GREEN, CheckCircle2)}
            <h2 style={{ fontSize: 18, fontWeight: 900, color: 'var(--text-hi)', marginBottom: 6 }}>Payment received!</h2>
            <p style={{ fontSize: 13, color: 'var(--text-lo)', lineHeight: 1.55 }}>{firstNameCap} has confirmed your payment. Wrapping up the job…</p>
          </div>
        )}
      </div>
    </>
  )
}
