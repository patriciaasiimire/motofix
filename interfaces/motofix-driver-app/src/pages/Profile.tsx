// Profile.tsx — the driver's account screen: view/edit their name, phone and number
// plate, and reach related actions (settings, logout, etc.).

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

function splashDisabled(): boolean {
  try { return JSON.parse(localStorage.getItem('motofix_settings') ?? '{}').disableSplash === true; }
  catch { return false; }
}
import {
  ChevronLeft, Phone, Car, Shield, LogOut,
  ChevronRight, Clock, Bell, HelpCircle, Info,
  Pencil, Check, X, Loader2, User, Settings as SettingsIcon, Star, Lock, BadgeCheck,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useTheme } from '@/contexts/ThemeContext';
import { authService } from '@/config/api';
import { toast } from 'sonner';

const WELCOME_DURATION = 3000;
const FADE_DURATION    = 500;
const Y = '#F59E0B';
const YD = '#D97706';

function ProfileOverlay() {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 60,
      backdropFilter: 'blur(18px)',
      WebkitBackdropFilter: 'blur(18px)',
      background: 'var(--overlay-bg)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: '32px 28px',
    }}>
      {/* Ambient glows */}
      <div style={{ position: 'absolute', top: -60, left: '50%', transform: 'translateX(-50%)', width: 320, height: 320, borderRadius: '50%', background: `${Y}0a`, filter: 'blur(70px)', pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', bottom: -40, right: -40, width: 240, height: 240, borderRadius: '50%', background: `${Y}07`, filter: 'blur(60px)', pointerEvents: 'none' }} />

      {/* MOTOFIX wordmark */}
      <span style={{ color: Y, fontSize: 12, fontWeight: 900, letterSpacing: '0.18em', textShadow: `0 0 20px ${Y}55`, marginBottom: 28 }}>
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
            animation: `pov-ring ${2 + i * 0.7}s ease-out ${i * 0.3}s infinite`,
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
          <User style={{ width: 24, height: 24, color: Y }} />
        </div>
      </div>

      {/* Headline */}
      <p style={{ color: 'var(--text-hi)', fontWeight: 900, fontSize: 26, textAlign: 'center', letterSpacing: '-0.02em', lineHeight: 1.15, marginBottom: 12 }}>
        My Profile
      </p>

      {/* Description */}
      <p style={{ color: 'var(--text-lo)', fontSize: 14, textAlign: 'center', lineHeight: 1.65, maxWidth: 290, marginBottom: 36 }}>
        Manage your account, update your vehicle details, and access your driver settings — all in one place.
      </p>

      {/* Preview icon row */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 36 }}>
        {[User, Car, Shield, Star, SettingsIcon].map((Icon, i) => (
          <div key={i} style={{
            width: 42, height: 42, borderRadius: 12,
            background: 'var(--surface-3)',
            border: '1px solid var(--border-3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            animation: `pov-icon 0.4s cubic-bezier(0.34,1.56,0.64,1) ${i * 0.07}s both`,
          }}>
            <Icon style={{ width: 18, height: 18, color: 'var(--text-lo)' }} />
          </div>
        ))}
      </div>

      {/* Progress bar */}
      <div style={{ width: '100%', maxWidth: 280, height: 2, borderRadius: 1, background: 'var(--surface-4)', overflow: 'hidden', marginBottom: 16 }}>
        <div style={{
          height: '100%', borderRadius: 1,
          background: `linear-gradient(90deg, ${YD}, ${Y})`,
          animation: `pov-bar ${WELCOME_DURATION}ms linear both`,
        }} />
      </div>

      <p style={{ color: 'var(--text-faint)', fontSize: 11 }}>Loading your profile…</p>

      <style>{`
        @keyframes pov-ring {
          0%   { transform: translate(-50%,-50%) scale(0.7); opacity: 0.8; }
          80%  { transform: translate(-50%,-50%) scale(2.2); opacity: 0; }
          100% { opacity: 0; }
        }
        @keyframes pov-icon {
          0%   { opacity: 0; transform: translateY(8px) scale(0.9); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes pov-bar { from { width: 0%; } to { width: 100%; } }
        @keyframes pov-fade-out { from { opacity: 1; } to { opacity: 0; } }
      `}</style>
    </div>
  );
}

function getInitials(name?: string) {
  if (!name) return 'DR';
  return name.split(' ').slice(0, 3).map(w => w[0]).join('').toUpperCase();
}

/* ── Inline editable field ───────────────────────────────── */
function EditableField({
  value,
  placeholder,
  onSave,
  transform,
}: {
  value: string;
  placeholder: string;
  onSave: (v: string) => Promise<void>;
  transform?: (v: string) => string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]   = useState(value);
  const [saving, setSaving] = useState(false);

  const commit = async () => {
    const cleaned = transform ? transform(draft.trim()) : draft.trim();
    if (!cleaned) { setEditing(false); setDraft(value); return; }
    if (cleaned === value) { setEditing(false); return; }
    setSaving(true);
    try {
      await onSave(cleaned);
      setEditing(false);
    } catch {
      setDraft(value);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => { setDraft(value); setEditing(false); };

  if (editing) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') cancel(); }}
          style={{
            flex: 1, background: 'var(--surface-4)',
            border: '1.5px solid rgba(245,158,11,0.5)',
            borderRadius: 10, padding: '6px 10px',
            color: 'var(--text-hi)', fontSize: 14, fontWeight: 700,
            outline: 'none',
          }}
        />
        {saving
          ? <Loader2 style={{ width: 16, height: 16, color: '#F59E0B', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
          : <>
              <button onClick={commit} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                <Check style={{ width: 17, height: 17, color: '#4ADE80' }} />
              </button>
              <button onClick={cancel} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                <X style={{ width: 17, height: 17, color: '#f87171' }} />
              </button>
            </>
        }
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <p style={{ color: 'var(--text-hi)', fontSize: 14, fontWeight: 700, lineHeight: 1, flex: 1 }}>
        {value || placeholder}
      </p>
      <button
        onClick={() => { setDraft(value); setEditing(true); }}
        style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 2,
          transition: 'opacity 0.15s ease',
        }}
        onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
        onMouseLeave={e => (e.currentTarget.style.opacity = '0.4')}
      >
        <Pencil style={{ width: 13, height: 13, color: '#F59E0B', opacity: 0.4 }} />
      </button>
    </div>
  );
}

/* ── Main page ───────────────────────────────────────────── */
export default function Profile() {
  const { user, logout, checkAuth } = useAuth();
  const { isDark } = useTheme();
  const navigate = useNavigate();
  const initials = getInitials(user?.full_name);

  const [overlayPhase, setOverlayPhase] = useState<'visible' | 'fading' | 'gone'>(() => splashDisabled() ? 'gone' : 'visible');
  const [showVerified, setShowVerified] = useState(false);

  useEffect(() => {
    if (splashDisabled()) return;
    const t = setTimeout(() => {
      setOverlayPhase('fading');
      setTimeout(() => setOverlayPhase('gone'), FADE_DURATION);
    }, WELCOME_DURATION);
    return () => clearTimeout(t);
  }, []);
  const role = user?.role
    ? user.role.charAt(0).toUpperCase() + user.role.slice(1)
    : 'Driver';

  const saveField = async (field: 'full_name' | 'number_plate', value: string) => {
    try {
      await authService.updateProfile({ [field]: value });
      await checkAuth();
      toast.success('Profile updated');
    } catch {
      toast.error('Could not save — please try again');
      throw new Error('save failed');
    }
  };

  const handleLogout = () => {
    logout();
    toast.success('Logged out successfully');
    navigate('/login', { replace: true });
  };

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--page-bg)', paddingBottom: 100, position: 'relative' }}>
      {overlayPhase !== 'gone' && (
        <div style={{ animation: overlayPhase === 'fading' ? `pov-fade-out ${FADE_DURATION}ms ease both` : undefined }}>
          <ProfileOverlay />
        </div>
      )}
      <div style={{ maxWidth: 480, margin: '0 auto', padding: '0 16px' }}>

        {/* ── Header ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 52, paddingBottom: 24 }}>
          <button
            onClick={() => navigate(-1)}
            style={{
              width: 36, height: 36, borderRadius: '50%', border: 'none',
              background: 'var(--surface-3)', color: 'var(--text-md)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', flexShrink: 0,
              transition: 'background 0.18s ease, box-shadow 0.18s ease',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = 'var(--surface-5)';
              e.currentTarget.style.boxShadow = 'none';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'var(--surface-3)';
              e.currentTarget.style.boxShadow = 'none';
            }}
          >
            <ChevronLeft style={{ width: 18, height: 18 }} />
          </button>
          <div>
            <p className="pf-brand" style={{ color: 'rgba(245,158,11,0.75)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.22em', fontWeight: 700, marginBottom: 2 }}>
              MOTOFIX · Account
            </p>
            <h1 className="pf-heading" style={{ color: 'var(--text-hi)', fontWeight: 900, fontSize: 22, letterSpacing: '-0.02em', lineHeight: 1 }}>
              My Profile
            </h1>
          </div>
        </div>

        {/* ── Avatar hero card ── */}
        <div
          className="pf-hero"
          style={{
            borderRadius: 24, padding: '24px 22px',
            background: 'linear-gradient(135deg, rgba(245,158,11,0.1) 0%, rgba(245,158,11,0.03) 100%)',
            border: isDark ? '1px solid rgba(245,158,11,0.2)' : '1.5px solid #000',
            display: 'flex', alignItems: 'center', gap: 20,
            marginBottom: 20,
            transition: 'border-color 0.2s ease, background 0.2s ease',
            cursor: 'default',
          }}
          onMouseEnter={e => {
            const el = e.currentTarget;
            el.style.borderColor = isDark ? 'rgba(245,158,11,0.38)' : '#000';
            el.style.background = 'linear-gradient(135deg, rgba(245,158,11,0.15) 0%, rgba(245,158,11,0.06) 100%)';
          }}
          onMouseLeave={e => {
            const el = e.currentTarget;
            el.style.borderColor = isDark ? 'rgba(245,158,11,0.2)' : '#000';
            el.style.background = 'linear-gradient(135deg, rgba(245,158,11,0.1) 0%, rgba(245,158,11,0.03) 100%)';
          }}
        >
          {/* Initials circle */}
          <div
            className="pf-avatar"
            style={{
              width: 72, height: 72, borderRadius: '50%', flexShrink: 0,
              background: 'linear-gradient(135deg, #F59E0B, #D97706)',
              border: '3px solid rgba(245,158,11,0.45)',
              boxShadow: '0 0 0 5px rgba(245,158,11,0.1), 0 0 28px rgba(245,158,11,0.25)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 24, fontWeight: 900, color: '#000', letterSpacing: '0.04em',
              transition: 'box-shadow 0.2s ease, transform 0.15s ease',
              cursor: 'default',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.boxShadow = '0 0 0 6px rgba(245,158,11,0.2), 0 0 36px rgba(245,158,11,0.45)';
              e.currentTarget.style.transform = 'scale(1.05)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.boxShadow = '0 0 0 5px rgba(245,158,11,0.1), 0 0 28px rgba(245,158,11,0.25)';
              e.currentTarget.style.transform = 'scale(1)';
            }}
          >
            {initials}
          </div>
          {/* Name + role */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <p
              className="pf-driver-name"
              style={{ color: 'var(--text-hi)', fontWeight: 900, fontSize: 20, letterSpacing: '-0.01em', lineHeight: 1.1, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {user?.full_name ?? 'Driver'}
              </span>
              {/* ID-verified drivers get an amber badge with a white tick; tap for details. */}
              <button
                onClick={() => setShowVerified(true)}
                aria-label="Verified — tap for details"
                style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', display: 'inline-flex', flexShrink: 0, lineHeight: 0 }}
              >
                <BadgeCheck style={{ width: 20, height: 20, color: '#fff', fill: '#F59E0B', flexShrink: 0 }} />
              </button>
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '3px 10px', borderRadius: 20,
                background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.3)',
                color: '#F59E0B', fontSize: 11, fontWeight: 700,
              }}>
                <Shield style={{ width: 10, height: 10 }} />
                {role}
              </span>
              {user?.number_plate && (
                <span style={{
                  display: 'inline-block',
                  padding: '3px 9px', borderRadius: 7,
                  background: '#F59E0B', color: '#000',
                  fontSize: 11, fontWeight: 900, letterSpacing: '0.07em',
                }}>
                  {user.number_plate}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* ── Editable details ── */}
        <p className="pf-section-label" style={{ color: 'var(--text-dim)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.22em', fontWeight: 700, marginBottom: 10 }}>
          Driver Details
        </p>
        <div style={{
          borderRadius: 20, overflow: 'hidden',
          background: 'var(--surface-1)',
          border: '1px solid var(--border-2)',
          marginBottom: 20,
        }}>

          {/* Full name — editable */}
          <div
            className="pf-row"
            style={{
              display: 'flex', alignItems: 'center', gap: 14,
              padding: '15px 18px',
              borderBottom: '1px solid var(--border-1)',
              transition: 'background 0.15s ease',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = 'rgba(245,158,11,0.05)';
              const lbl = e.currentTarget.querySelector('.pf-row-label') as HTMLElement | null;
              if (lbl) lbl.style.color = 'var(--text-md)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'transparent';
              const lbl = e.currentTarget.querySelector('.pf-row-label') as HTMLElement | null;
              if (lbl) lbl.style.color = 'var(--text-dim)';
            }}
          >
            <div style={{ width: 38, height: 38, borderRadius: 12, flexShrink: 0, background: 'rgba(245,158,11,0.12)', border: '1.5px solid rgba(245,158,11,0.28)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Shield style={{ width: 16, height: 16, color: '#F59E0B' }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p className="pf-row-label" style={{ color: 'var(--text-dim)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 700, marginBottom: 4, transition: 'color 0.15s ease' }}>
                Full Name
              </p>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-hi)' }}>
                  {user?.full_name ?? '—'}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 8, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', flexShrink: 0 }}>
                  <Lock style={{ width: 10, height: 10, color: '#F59E0B' }} />
                  <span style={{ fontSize: 10, fontWeight: 700, color: '#F59E0B', letterSpacing: '0.05em' }}>ID-verified</span>
                </div>
              </div>
            </div>
          </div>

          {/* Phone — read-only */}
          <div
            className="pf-row"
            style={{
              display: 'flex', alignItems: 'center', gap: 14,
              padding: '15px 18px',
              borderBottom: '1px solid var(--border-1)',
              transition: 'background 0.15s ease',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = 'rgba(96,165,250,0.05)';
              const lbl = e.currentTarget.querySelector('.pf-row-label') as HTMLElement | null;
              if (lbl) lbl.style.color = 'var(--text-md)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'transparent';
              const lbl = e.currentTarget.querySelector('.pf-row-label') as HTMLElement | null;
              if (lbl) lbl.style.color = 'var(--text-dim)';
            }}
          >
            <div style={{ width: 38, height: 38, borderRadius: 12, flexShrink: 0, background: 'rgba(96,165,250,0.12)', border: '1.5px solid rgba(96,165,250,0.28)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Phone style={{ width: 16, height: 16, color: '#60A5FA' }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p className="pf-row-label" style={{ color: 'var(--text-dim)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 700, marginBottom: 4, transition: 'color 0.15s ease' }}>
                Phone Number
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <p style={{ color: 'var(--text-hi)', fontSize: 14, fontWeight: 700, lineHeight: 1 }}>{user?.phone ?? '—'}</p>
                <span style={{ padding: '1px 7px', borderRadius: 8, background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.2)', color: '#60A5FA', fontSize: 9, fontWeight: 800, letterSpacing: '0.08em' }}>VERIFIED</span>
              </div>
            </div>
          </div>

          {/* Number plate — editable */}
          <div
            className="pf-row"
            style={{
              display: 'flex', alignItems: 'center', gap: 14,
              padding: '15px 18px',
              borderBottom: '1px solid var(--border-1)',
              transition: 'background 0.15s ease',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = 'rgba(245,158,11,0.05)';
              const lbl = e.currentTarget.querySelector('.pf-row-label') as HTMLElement | null;
              if (lbl) lbl.style.color = 'var(--text-md)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'transparent';
              const lbl = e.currentTarget.querySelector('.pf-row-label') as HTMLElement | null;
              if (lbl) lbl.style.color = 'var(--text-dim)';
            }}
          >
            <div style={{ width: 38, height: 38, borderRadius: 12, flexShrink: 0, background: 'rgba(245,158,11,0.12)', border: '1.5px solid rgba(245,158,11,0.28)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Car style={{ width: 16, height: 16, color: '#F59E0B' }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p className="pf-row-label" style={{ color: 'var(--text-dim)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 700, marginBottom: 4, transition: 'color 0.15s ease' }}>
                Number Plate
              </p>
              <EditableField
                value={user?.number_plate ?? ''}
                placeholder="e.g. UJA 564X"
                onSave={v => saveField('number_plate', v)}
                transform={v => v.toUpperCase()}
              />
            </div>
          </div>

          {/* Account ID — read-only */}
          <div
            className="pf-row"
            style={{
              display: 'flex', alignItems: 'center', gap: 14,
              padding: '15px 18px',
              transition: 'background 0.15s ease',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = 'rgba(148,163,184,0.05)';
              const lbl = e.currentTarget.querySelector('.pf-row-label') as HTMLElement | null;
              if (lbl) lbl.style.color = 'var(--text-md)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'transparent';
              const lbl = e.currentTarget.querySelector('.pf-row-label') as HTMLElement | null;
              if (lbl) lbl.style.color = 'var(--text-dim)';
            }}
          >
            <div style={{ width: 38, height: 38, borderRadius: 12, flexShrink: 0, background: 'rgba(148,163,184,0.1)', border: '1.5px solid rgba(148,163,184,0.22)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Info style={{ width: 16, height: 16, color: '#94A3B8' }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p className="pf-row-label" style={{ color: 'var(--text-dim)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 700, marginBottom: 4, transition: 'color 0.15s ease' }}>
                Account ID
              </p>
              <p style={{ color: 'var(--text-lo)', fontSize: 14, fontWeight: 700, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
                {user?.id ? `#${String(user.id).padStart(6, '0')}` : '—'}
              </p>
            </div>
          </div>
        </div>

        {/* ── Quick links ── */}
        <p className="pf-section-label" style={{ color: 'var(--text-dim)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.22em', fontWeight: 700, marginBottom: 10 }}>
          Quick Links
        </p>
        <div style={{
          borderRadius: 20, overflow: 'hidden',
          background: 'var(--surface-1)',
          border: '1px solid var(--border-2)',
          marginBottom: 20,
        }}>
          {[
            { icon: Clock,         label: 'Service History', sub: 'View your past requests',          accent: '#F59E0B', action: () => navigate('/history')   },
            { icon: Bell,          label: 'Reminders',       sub: 'Driver checklist & vehicle tips',  accent: '#60A5FA', action: () => navigate('/reminders') },
            { icon: SettingsIcon,  label: 'Settings',        sub: 'Notifications, theme & privacy',   accent: '#A78BFA', action: () => navigate('/settings')  },
            { icon: HelpCircle,    label: 'Help & Support',  sub: 'Get assistance from MOTOFIX',      accent: '#34D399', action: () => navigate('/contact-support') },
          ].map(({ icon: Icon, label, sub, accent, action }, idx, arr) => (
            <button
              key={label}
              onClick={action}
              style={{
                width: '100%', border: 'none', background: 'transparent',
                display: 'flex', alignItems: 'center', gap: 14,
                padding: '15px 18px', cursor: 'pointer', textAlign: 'left',
                borderBottom: idx < arr.length - 1 ? '1px solid var(--border-1)' : 'none',
                transition: 'background 0.15s ease',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.background = `${accent}0e`;
                const lbl  = e.currentTarget.querySelector('.pf-link-label') as HTMLElement | null;
                const sub_ = e.currentTarget.querySelector('.pf-link-sub')   as HTMLElement | null;
                const arr_ = e.currentTarget.querySelector('.pf-link-arrow') as HTMLElement | null;
                if (lbl)  lbl.style.color  = 'var(--text-hi)';
                if (sub_) sub_.style.color = 'var(--text-md)';
                if (arr_) arr_.style.color = `${accent}90`;
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = 'transparent';
                const lbl  = e.currentTarget.querySelector('.pf-link-label') as HTMLElement | null;
                const sub_ = e.currentTarget.querySelector('.pf-link-sub')   as HTMLElement | null;
                const arr_ = e.currentTarget.querySelector('.pf-link-arrow') as HTMLElement | null;
                if (lbl)  lbl.style.color  = 'var(--text-hi)';
                if (sub_) sub_.style.color = 'var(--text-dim)';
                if (arr_) arr_.style.color = 'var(--text-ghost)';
              }}
            >
              <div style={{ width: 38, height: 38, borderRadius: 12, flexShrink: 0, background: `${accent}14`, border: `1.5px solid ${accent}30`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon style={{ width: 16, height: 16, color: accent }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p className="pf-link-label" style={{ color: 'var(--text-hi)', fontSize: 14, fontWeight: 700, lineHeight: 1, transition: 'color 0.15s ease' }}>{label}</p>
                <p className="pf-link-sub"   style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 3, transition: 'color 0.15s ease' }}>{sub}</p>
              </div>
              <ChevronRight className="pf-link-arrow" style={{ width: 15, height: 15, color: 'var(--text-faint)', flexShrink: 0, transition: 'color 0.15s ease' }} />
            </button>
          ))}
        </div>

        {/* ── App info ── */}
        <div
          style={{
            borderRadius: 18, padding: '14px 18px',
            background: 'var(--surface-1)',
            border: '1px solid var(--border-1)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 20,
            transition: 'background 0.15s ease, border-color 0.15s ease',
            cursor: 'default',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.background = 'var(--surface-2)';
            e.currentTarget.style.borderColor = 'var(--border-3)';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = 'var(--surface-1)';
            e.currentTarget.style.borderColor = 'var(--border-2)';
          }}
        >
          <div>
            <p style={{ color: 'var(--text-dim)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 700, marginBottom: 3 }}>App Version</p>
            <p style={{ color: 'var(--text-md)', fontSize: 13, fontWeight: 700 }}>MOTOFIX v1.0.0</p>
          </div>
          <span style={{ padding: '4px 10px', borderRadius: 20, background: 'rgba(74,222,128,0.1)', border: '1px solid rgba(74,222,128,0.25)', color: '#4ADE80', fontSize: 10, fontWeight: 800 }}>
            Up to date
          </span>
        </div>

        {/* ── Logout ── */}
        <button
          onClick={handleLogout}
          style={{
            width: '100%', border: 'none',
            borderRadius: 18, padding: '16px 20px',
            background: '#dc2626',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            cursor: 'pointer',
            boxShadow: '0 4px 20px rgba(220,38,38,0.35)',
            transition: 'background 0.2s ease, transform 0.15s ease, box-shadow 0.2s ease',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.background = '#b91c1c';
            e.currentTarget.style.transform = 'scale(1.012)';
            e.currentTarget.style.boxShadow = '0 6px 28px rgba(220,38,38,0.5)';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = '#dc2626';
            e.currentTarget.style.transform = 'scale(1)';
            e.currentTarget.style.boxShadow = '0 4px 20px rgba(220,38,38,0.35)';
          }}
        >
          <LogOut style={{ width: 16, height: 16, color: '#fff' }} />
          <span style={{ color: '#fff', fontSize: 14, fontWeight: 800 }}>Logout</span>
        </button>

      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }

        .pf-brand {
          transition: color 0.18s ease, text-shadow 0.18s ease;
          cursor: default;
        }
        .pf-brand:hover {
          color: #F59E0B !important;
          text-shadow: 0 0 16px rgba(245,158,11,0.55), 0 0 32px rgba(245,158,11,0.22);
        }
        .pf-heading {
          transition: color 0.18s ease, text-shadow 0.18s ease;
          cursor: default;
        }
        .pf-heading:hover {
          color: var(--text-hi) !important;
        }
        .pf-driver-name {
          transition: color 0.18s ease, text-shadow 0.18s ease;
          cursor: default;
        }
        .pf-driver-name:hover {
          color: var(--text-hi) !important;
        }
        .pf-section-label {
          transition: color 0.18s ease;
          cursor: default;
        }
        .pf-section-label:hover {
          color: var(--text-md) !important;
        }
      `}</style>

      {showVerified && (
        <>
          <div onClick={() => setShowVerified(false)} style={{ position: 'fixed', inset: 0, zIndex: 4000, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }} />
          <div style={{ position: 'fixed', inset: 0, zIndex: 4001, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, pointerEvents: 'none' }}>
            <div style={{ background: 'var(--surface-1)', borderRadius: 24, padding: '28px 24px', maxWidth: 340, width: '100%', border: `1.5px solid ${Y}40`, pointerEvents: 'auto', textAlign: 'center', boxShadow: '0 24px 80px rgba(0,0,0,0.5)' }}>
              <div style={{ width: 64, height: 64, borderRadius: '50%', margin: '0 auto 16px', background: 'linear-gradient(135deg, #F59E0B, #D97706)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 6px 20px rgba(245,158,11,0.4)' }}>
                <BadgeCheck style={{ width: 34, height: 34, color: '#fff' }} />
              </div>
              <p style={{ fontSize: 18, fontWeight: 900, color: 'var(--text-hi)', marginBottom: 8 }}>Verified Driver</p>
              <p style={{ fontSize: 13, color: 'var(--text-md)', lineHeight: 1.65, marginBottom: 22 }}>
                {(user?.full_name ?? 'This driver')}'s identity has been verified with their National ID on MOTOFIX. This badge shows mechanics you're a trusted, verified driver on the platform.
              </p>
              <button onClick={() => setShowVerified(false)}
                style={{ width: '100%', height: 46, borderRadius: 14, border: 'none', background: 'linear-gradient(135deg, #F59E0B, #D97706)', color: '#000', fontWeight: 800, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' }}>
                Close
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
