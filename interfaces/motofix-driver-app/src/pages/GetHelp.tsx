// GetHelp.tsx — the v1 "What do you need?" screen (GET HELP, not SOS copy).
//
// Area-based v1 flow: pick mechanic or tow (with optional issue chips), then choose
// an area on the next screen. No GPS and no MOTOBOT/diagnosis on this path.
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Wrench, Truck, Disc3, Battery, Droplets, Zap, HelpCircle } from 'lucide-react';
import { useRequests } from '@/contexts/RequestContext';

type IssueId = 'general' | 'flat_tyre' | 'battery' | 'fuel' | 'engine' | 'other';

const CHIPS: { id: IssueId; label: string; icon: typeof Wrench }[] = [
  { id: 'flat_tyre', label: 'Flat tyre', icon: Disc3 },
  { id: 'battery', label: 'Dead battery', icon: Battery },
  { id: 'fuel', label: 'Out of fuel', icon: Droplets },
  { id: 'engine', label: 'Engine fault', icon: Zap },
];

export default function GetHelp() {
  const navigate = useNavigate();
  const { requests, isLoading } = useRequests();

  // If a request is already active, go straight to it — don't create a duplicate.
  useEffect(() => {
    const active = requests.find((r) => r.status === 'searching' || r.status === 'assigned');
    if (!isLoading && active) {
      navigate(`/requests/${active.id}`, { replace: true });
    }
  }, [requests, isLoading, navigate]);

  const goToLocation = (serviceType: 'mechanic' | 'tow', issueType: IssueId) => {
    if (isLoading) return;
    navigate('/get-help/location', { state: { serviceType, issueType } });
  };

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--page-bg)', paddingBottom: 40 }}>
      <div style={{ maxWidth: 480, margin: '0 auto', padding: '0 16px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 52, paddingBottom: 24 }}>
          <button
            onClick={() => navigate(-1)}
            style={{ width: 36, height: 36, borderRadius: '50%', border: 'none', background: 'var(--surface-3)', color: 'var(--text-md)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}
            aria-label="Back"
          >
            <ArrowLeft style={{ width: 18, height: 18 }} />
          </button>
          <div>
            <p style={{ color: 'rgba(245,158,11,0.75)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.22em', fontWeight: 700, marginBottom: 2 }}>
              MOTOFIX · Get Help
            </p>
            <h1 style={{ color: 'var(--text-hi)', fontWeight: 900, fontSize: 22, letterSpacing: '-0.02em', lineHeight: 1 }}>
              What do you need?
            </h1>
          </div>
        </div>

        {/* Primary — Request a mechanic */}
        <button
          onClick={() => goToLocation('mechanic', 'general')}
          disabled={isLoading}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 14, padding: '18px 18px',
            borderRadius: 20, border: '1.5px solid #000', cursor: 'pointer',
            background: 'linear-gradient(135deg, #F59E0B, #D97706)',
            boxShadow: '0 10px 32px rgba(245,158,11,0.35)',
            marginBottom: 12,
          }}
        >
          <div style={{ width: 46, height: 46, borderRadius: 14, background: 'rgba(0,0,0,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Wrench style={{ width: 22, height: 22, color: '#111827' }} />
          </div>
          <div style={{ textAlign: 'left' }}>
            <p style={{ color: '#111827', fontWeight: 900, fontSize: 17, lineHeight: 1 }}>Request a mechanic</p>
            <p style={{ color: 'rgba(17,24,39,0.72)', fontSize: 12, marginTop: 4 }}>A verified mechanic comes to you</p>
          </div>
        </button>

        {/* Secondary — Need a tow */}
        <button
          onClick={() => goToLocation('tow', 'general')}
          disabled={isLoading}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 14, padding: '16px 18px',
            borderRadius: 20, border: '1px solid var(--border-2)', cursor: 'pointer',
            background: 'var(--surface-1)', marginBottom: 28,
          }}
        >
          <div style={{ width: 46, height: 46, borderRadius: 14, background: 'rgba(96,165,250,0.14)', border: '1.5px solid rgba(96,165,250,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Truck style={{ width: 22, height: 22, color: '#60A5FA' }} />
          </div>
          <div style={{ textAlign: 'left' }}>
            <p style={{ color: 'var(--text-hi)', fontWeight: 800, fontSize: 16, lineHeight: 1 }}>Need a tow</p>
            <p style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 4 }}>Vehicle can't be driven safely</p>
          </div>
        </button>

        {/* Optional chips — only set the issue type */}
        <p style={{ color: 'var(--text-md)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.22em', fontWeight: 700, marginBottom: 12 }}>
          Or choose what's wrong
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          {CHIPS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => goToLocation('mechanic', id)}
              disabled={isLoading}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '13px 14px',
                borderRadius: 16, border: '1px solid var(--border-2)', background: 'var(--surface-1)',
                cursor: 'pointer', textAlign: 'left',
              }}
            >
              <Icon style={{ width: 18, height: 18, color: 'var(--text-md)', flexShrink: 0 }} />
              <span style={{ color: 'var(--text-hi)', fontSize: 13, fontWeight: 700 }}>{label}</span>
            </button>
          ))}
        </div>

        {/* Something else */}
        <button
          onClick={() => goToLocation('mechanic', 'other')}
          disabled={isLoading}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '13px 14px',
            borderRadius: 16, border: '1px solid var(--border-2)', background: 'var(--surface-1)',
            cursor: 'pointer', textAlign: 'left',
          }}
        >
          <HelpCircle style={{ width: 18, height: 18, color: 'var(--text-md)', flexShrink: 0 }} />
          <span style={{ color: 'var(--text-hi)', fontSize: 13, fontWeight: 700 }}>Something else</span>
        </button>
      </div>
    </div>
  );
}
