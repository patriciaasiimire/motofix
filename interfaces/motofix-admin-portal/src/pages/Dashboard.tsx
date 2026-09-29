// Dashboard.tsx — the main control-room overview screen. Pulls together the headline
// stat cards, revenue chart, breakdown-hotspot map and analytics charts (each fed by the
// useDashboardData hooks), with drill-down modals for each metric. The admin's home page.

import { ReactNode, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import BackLogoutGuard from '@/components/BackLogoutGuard';
import { HeroCard, ChipCard } from '@/components/dashboard/StatsCard';
import { RevenueChart } from '@/components/dashboard/RevenueChart';
import { BreakdownHotspotMap } from '@/components/dashboard/BreakdownHotspotMap';
import { AnalyticsCharts } from '@/components/dashboard/AnalyticsCharts';
import { useDashboardStats, useRevenueChart } from '@/hooks/useDashboardData';
import { formatUGX } from '@/config/api';
import { getAdminInfo } from '@/lib/api';
import {
  CheckCircle, Clock, Users, BadgeCheck,
  Wallet, ArrowUpRight, X,
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';

const C = {
  surface:  'var(--adm-surface)',
  surface2: 'var(--adm-surface-2)',
  border:   'var(--adm-border)',
  amber:    'var(--adm-amber)',
  green:    'var(--adm-green)',
  red:      'var(--adm-red)',
  cyan:     'var(--adm-cyan)',
  purple:   'var(--adm-purple)',
  text:     'var(--adm-text)',
  muted:    'var(--adm-muted)',
} as const;

type ModalKey = 'totalRequests' | 'revenue' | 'completedJobs' | 'pendingJobs' | 'totalMechanics' | 'platformFees' | null;

export default function Dashboard() {
  const navigate = useNavigate();
  const [modal, setModal] = useState<ModalKey>(null);
  const { data: stats, isLoading: statsLoading, error: statsError } = useDashboardStats(45000);

  useEffect(() => {
    if (sessionStorage.getItem('motofix_just_logged_in')) {
      sessionStorage.removeItem('motofix_just_logged_in');
      const name = getAdminInfo()?.full_name ?? 'Admin';
      toast.success(`Welcome back, ${name}`);
    }
  }, []);
  const { data: revenueData, isLoading: revenueLoading, error: revenueError } = useRevenueChart(30, 60000);

  const s = stats ?? {
    totalRequests: 0, completedJobs: 0, pendingJobs: 0,
    totalMechanics: 0, verifiedMechanics: 0,
    revenueCollected: 0, pendingCollections: 0,
  };

  const completionRate = s.totalRequests > 0
    ? Math.round((s.completedJobs / s.totalRequests) * 100)
    : 0;

  const verifiedPct = s.totalMechanics > 0
    ? Math.round((s.verifiedMechanics / s.totalMechanics) * 100)
    : 0;

  if (statsError && !stats) {
    return (
      <DashboardLayout>
        <BackLogoutGuard />
        <div
          role="alert"
          style={{
            background: 'rgba(248,113,113,0.08)',
            border: '1px solid rgba(248,113,113,0.25)',
            borderRadius: 12,
            padding: '18px 20px',
            fontSize: 13,
            color: 'var(--adm-red)',
          }}
        >
          Dashboard statistics are unavailable. Check the analytics and database services, then refresh.
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <BackLogoutGuard />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* ── Row 1: Two hero metric cards ─────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <HeroCard
            title="Total Requests"
            value={s.totalRequests.toLocaleString()}
            todayDelta="All time"
            viewLabel="View Requests"
            onView={() => navigate('/requests')}
            onMore={() => setModal('totalRequests')}
            isLoading={statsLoading}
          />
          <HeroCard
            title="Revenue Collected"
            value={formatUGX(s.revenueCollected)}
            subValue={formatUGX(s.pendingCollections)}
            subLabel="Fees outstanding"
            viewLabel="View Payments"
            onView={() => navigate('/payments')}
            onMore={() => setModal('revenue')}
            isLoading={statsLoading}
          />

        </div>

        {/* ── Row 2: Four compact chip cards ───────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
          <ChipCard
            title="Completed Jobs"
            value={s.completedJobs.toLocaleString()}
            icon={<CheckCircle size={18} />}
            sub={`${completionRate}% completion`}
            iconColor={C.green}
            onMore={() => setModal('completedJobs')}
            onClick={() => navigate('/requests')}
            isLoading={statsLoading}
          />
          <ChipCard
            title="Pending Jobs"
            value={s.pendingJobs.toLocaleString()}
            icon={<Clock size={18} />}
            sub="Awaiting action"
            iconColor="#f59e0b"
            onMore={() => setModal('pendingJobs')}
            onClick={() => navigate('/requests')}
            isLoading={statsLoading}
          />
          <ChipCard
            title="Total Mechanics"
            value={s.totalMechanics.toLocaleString()}
            icon={<Users size={18} />}
            sub={`${s.verifiedMechanics} verified`}
            iconColor={C.cyan}
            onMore={() => setModal('totalMechanics')}
            onClick={() => navigate('/providers')}
            isLoading={statsLoading}
          />
          <ChipCard
            title="Platform Fees Collected"
            value={formatUGX(s.revenueCollected)}
            icon={<Wallet size={18} />}
            sub="UGX 10,000 / completed job"
            iconColor={C.purple}
            onMore={() => setModal('platformFees')}
            onClick={() => navigate('/payments')}
            isLoading={statsLoading}
          />
        </div>

        {/* ── Row 3: Revenue chart + Financial panel ────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>

          {/* Chart */}
          <RevenueChart data={revenueData ?? []} isLoading={revenueLoading} hasError={!!revenueError} />

          {/* Financial breakdown panel */}
          <div style={{
            background: C.surface,
            border: `2px solid var(--adm-card-border)`,
            boxShadow: 'var(--adm-card-shadow)',
            borderRadius: 16,
            padding: '24px 26px',
            display: 'flex',
            flexDirection: 'column',
            transition: 'transform 0.22s ease, box-shadow 0.22s ease, border-color 0.2s ease',
          }}
            onMouseEnter={e => {
              e.currentTarget.style.borderColor = 'var(--adm-border-hi)';
              e.currentTarget.style.transform = 'translateY(-3px)';
              e.currentTarget.style.boxShadow = 'var(--adm-hover-shadow)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.borderColor = 'var(--adm-card-border)';
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = 'var(--adm-card-shadow)';
            }}
          >
            <div style={{ marginBottom: 22 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 4 }}>
                Financials
              </div>
              <div style={{ fontSize: 12, color: C.muted }}>Revenue breakdown</div>
            </div>

            {/* Big total */}
            {statsLoading ? (
              <Skeleton className="h-9 w-36 mb-6" style={{ background: 'var(--adm-skeleton)' }} />
            ) : (
              <div style={{ marginBottom: 24 }}>
                <div style={{ fontSize: 11, color: C.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
                  Total Collected
                </div>
                <div style={{ fontSize: 28, fontWeight: 800, color: C.amber, letterSpacing: '-1px' }}>
                  {formatUGX(s.revenueCollected)}
                </div>
              </div>
            )}

            {/* Line items */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0, flex: 1 }}>
              <FinanceRow
                label="Revenue Collected"
                value={formatUGX(s.revenueCollected)}
                color={C.amber}
                pct={100}
                isLoading={statsLoading}
              />
              <FinanceRow
                label="Fees Outstanding"
                value={formatUGX(s.pendingCollections)}
                color="#f59e0b"
                pct={s.revenueCollected + s.pendingCollections > 0
                  ? Math.round((s.pendingCollections / (s.revenueCollected + s.pendingCollections)) * 100)
                  : 0}
                isLoading={statsLoading}
                isLast
              />
            </div>

            {/* Footer link */}
            <button
              onClick={() => navigate('/payments')}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                marginTop: 22, background: 'none', border: 'none', padding: 0,
                fontSize: 12.5, fontWeight: 700, color: C.amber, cursor: 'pointer',
              }}
            >
              View all payments <ArrowUpRight size={13} />
            </button>
          </div>
        </div>

        {/* ── Card detail modals ───────────────────────────────────────── */}
        {modal && (
          <CardDetailModal
            modalKey={modal}
            s={s}
            completionRate={completionRate}
            verifiedPct={verifiedPct}
            onClose={() => setModal(null)}
          />
        )}

        {/* ── Row 4: Breakdown Hotspot Map ─────────────────────────────── */}
        <BreakdownHotspotMap />

        {/* ── Row 5: Mechanics overview + Jobs breakdown ────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, paddingBottom: 8 }}>

          {/* Mechanics panel */}
          <div style={{
            background: C.surface,
            border: `2px solid var(--adm-card-border)`,
            boxShadow: 'var(--adm-card-shadow)',
            borderRadius: 16,
            padding: '24px 26px',
            transition: 'transform 0.22s ease, box-shadow 0.22s ease, border-color 0.2s ease',
          }}
            onMouseEnter={e => {
              e.currentTarget.style.borderColor = 'var(--adm-border-hi)';
              e.currentTarget.style.transform = 'translateY(-3px)';
              e.currentTarget.style.boxShadow = 'var(--adm-hover-shadow)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.borderColor = 'var(--adm-card-border)';
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = 'var(--adm-card-shadow)';
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 4 }}>Mechanics Overview</div>
                <div style={{ fontSize: 12, color: C.muted }}>Fleet verification status</div>
              </div>
              <button
                onClick={() => navigate('/providers')}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  background: 'none', border: `1px solid ${C.border}`,
                  borderRadius: 8, padding: '5px 12px',
                  fontSize: 12, fontWeight: 600, color: C.muted, cursor: 'pointer',
                }}
              >
                View all <ArrowUpRight size={12} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <MechanicBar
                label="Verified"
                icon={<BadgeCheck size={14} />}
                value={s.verifiedMechanics}
                total={s.totalMechanics}
                color={C.green}
                isLoading={statsLoading}
              />
              <MechanicBar
                label="Pending verification"
                icon={<Clock size={14} />}
                value={Math.max(0, s.totalMechanics - s.verifiedMechanics)}
                total={s.totalMechanics}
                color="#f59e0b"
                isLoading={statsLoading}
              />
            </div>

            {/* Big verified stat */}
            {!statsLoading && s.totalMechanics > 0 && (
              <div style={{
                marginTop: 20, padding: '14px 16px',
                background: 'var(--adm-green-dim)',
                border: '1px solid rgba(52,211,153,0.2)',
                borderRadius: 12,
                display: 'flex', alignItems: 'center', gap: 12,
              }}>
                <BadgeCheck size={18} style={{ color: C.green, flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
                    {verifiedPct}% of fleet verified
                  </div>
                  <div style={{ fontSize: 12, color: C.muted }}>
                    {s.verifiedMechanics} of {s.totalMechanics} mechanics
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Jobs breakdown */}
          <div style={{
            background: C.surface,
            border: `2px solid var(--adm-card-border)`,
            boxShadow: 'var(--adm-card-shadow)',
            borderRadius: 16,
            padding: '24px 26px',
            transition: 'transform 0.22s ease, box-shadow 0.22s ease, border-color 0.2s ease',
          }}
            onMouseEnter={e => {
              e.currentTarget.style.borderColor = 'var(--adm-border-hi)';
              e.currentTarget.style.transform = 'translateY(-3px)';
              e.currentTarget.style.boxShadow = 'var(--adm-hover-shadow)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.borderColor = 'var(--adm-card-border)';
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = 'var(--adm-card-shadow)';
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 4 }}>Jobs Breakdown</div>
                <div style={{ fontSize: 12, color: C.muted }}>By current status</div>
              </div>
              <button
                onClick={() => navigate('/requests')}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  background: 'none', border: `1px solid ${C.border}`,
                  borderRadius: 8, padding: '5px 12px',
                  fontSize: 12, fontWeight: 600, color: C.muted, cursor: 'pointer',
                }}
              >
                View all <ArrowUpRight size={12} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <JobBar label="Completed" value={s.completedJobs} total={s.totalRequests} color={C.green} isLoading={statsLoading} />
              <JobBar label="Pending" value={s.pendingJobs} total={s.totalRequests} color="#f59e0b" isLoading={statsLoading} />
              <JobBar
                label="Cancelled / Other"
                value={Math.max(0, s.totalRequests - s.completedJobs - s.pendingJobs)}
                total={s.totalRequests}
                color={C.red}
                isLoading={statsLoading}
              />
            </div>

            {/* Doughnut-style summary */}
            {!statsLoading && (
              <div style={{
                marginTop: 20,
                display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 10,
              }}>
                {[
                  { label: 'Done', val: completionRate + '%', color: C.green },
                  { label: 'Pending', val: s.totalRequests > 0 ? Math.round((s.pendingJobs / s.totalRequests) * 100) + '%' : '0%', color: '#f59e0b' },
                  { label: 'Total', val: s.totalRequests.toLocaleString(), color: C.amber },
                ].map(item => (
                  <div key={item.label} style={{
                    textAlign: 'center', padding: '10px 6px',
                    background: 'var(--adm-surface-2)', borderRadius: 10,
                    border: '1px solid var(--adm-divider)',
                  }}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: item.color, letterSpacing: '-0.5px' }}>
                      {item.val}
                    </div>
                    <div style={{ fontSize: 10, color: C.muted, fontWeight: 600, marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      {item.label}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Row 6: Analytics charts ──────────────────────────────────── */}
        <AnalyticsCharts />

      </div>
    </DashboardLayout>
  );
}

// ── Card detail modal ─────────────────────────────────────────────────────────

type StatsShape = {
  totalRequests: number; completedJobs: number; pendingJobs: number;
  totalMechanics: number; verifiedMechanics: number;
  revenueCollected: number; pendingCollections: number;
};

function CardDetailModal({
  modalKey, s, completionRate, verifiedPct, onClose,
}: {
  modalKey: NonNullable<ModalKey>;
  s: StatsShape;
  completionRate: number;
  verifiedPct: number;
  onClose: () => void;
}) {
  const pendingRate = s.totalRequests > 0 ? Math.round((s.pendingJobs / s.totalRequests) * 100) : 0;
  const cancelledJobs = Math.max(0, s.totalRequests - s.completedJobs - s.pendingJobs);
  const cancelRate = s.totalRequests > 0 ? Math.round((cancelledJobs / s.totalRequests) * 100) : 0;
  const unverifiedMechanics = Math.max(0, s.totalMechanics - s.verifiedMechanics);
  const unverifiedPct = 100 - verifiedPct;

  const CONFIGS: Record<NonNullable<ModalKey>, {
    title: string; icon: ReactNode; accentColor: string; description: string;
    mainValue: string; mainLabel: string;
    rows: { label: string; value: string; pct: number; color: string }[];
    footer?: string;
  }> = {
    totalRequests: {
      title: 'Total Requests',
      icon: <CheckCircle size={20} />,
      accentColor: C.amber,
      description: 'All service requests ever submitted on the MOTOFIX platform.',
      mainValue: s.totalRequests.toLocaleString(),
      mainLabel: 'Requests all time',
      rows: [
        { label: 'Completed', value: s.completedJobs.toLocaleString(), pct: completionRate, color: C.green },
        { label: 'Pending', value: s.pendingJobs.toLocaleString(), pct: pendingRate, color: '#f59e0b' },
        { label: 'Cancelled / Other', value: cancelledJobs.toLocaleString(), pct: cancelRate, color: C.red },
      ],
      footer: `${completionRate}% of all requests have been successfully completed.`,
    },
    revenue: {
      title: 'Revenue Collected',
      icon: <Wallet size={20} />,
      accentColor: C.amber,
      description: 'Platform fees marked paid in the platform_fees ledger.',
      mainValue: formatUGX(s.revenueCollected),
      mainLabel: 'Fees collected',
      rows: [
        { label: 'Fees collected', value: formatUGX(s.revenueCollected), pct: 100, color: C.amber },
        { label: 'Fees outstanding', value: formatUGX(s.pendingCollections), pct: s.revenueCollected + s.pendingCollections > 0
          ? Math.round((s.pendingCollections / (s.revenueCollected + s.pendingCollections)) * 100) : 0, color: '#f59e0b' },
      ],
      footer: 'Collected and outstanding amounts are sourced from platform_fees.',
    },
    completedJobs: {
      title: 'Completed Jobs',
      icon: <CheckCircle size={20} />,
      accentColor: C.green,
      description: 'Service requests successfully resolved by mechanics.',
      mainValue: s.completedJobs.toLocaleString(),
      mainLabel: 'Jobs completed',
      rows: [
        { label: 'Completion rate', value: `${completionRate}%`, pct: completionRate, color: C.green },
        { label: 'Still pending', value: s.pendingJobs.toLocaleString(), pct: pendingRate, color: '#f59e0b' },
        { label: 'Cancelled / Other', value: cancelledJobs.toLocaleString(), pct: cancelRate, color: C.red },
      ],
      footer: `Out of ${s.totalRequests.toLocaleString()} total requests.`,
    },
    pendingJobs: {
      title: 'Pending Jobs',
      icon: <Clock size={20} />,
      accentColor: '#f59e0b',
      description: 'Service requests currently awaiting mechanic assignment or action.',
      mainValue: s.pendingJobs.toLocaleString(),
      mainLabel: 'Awaiting action',
      rows: [
        { label: 'Share of total requests', value: `${pendingRate}%`, pct: pendingRate, color: '#f59e0b' },
        { label: 'Completed jobs', value: s.completedJobs.toLocaleString(), pct: completionRate, color: C.green },
        { label: 'Total platform requests', value: s.totalRequests.toLocaleString(), pct: 100, color: C.amber },
      ],
      footer: pendingRate > 20 ? 'High pending rate — consider deploying more mechanics.' : 'Pending rate is within normal range.',
    },
    totalMechanics: {
      title: 'Total Mechanics',
      icon: <Users size={20} />,
      accentColor: C.cyan,
      description: 'All registered service providers on the MOTOFIX platform.',
      mainValue: s.totalMechanics.toLocaleString(),
      mainLabel: 'Registered providers',
      rows: [
        { label: 'Verified & active', value: s.verifiedMechanics.toLocaleString(), pct: verifiedPct, color: C.green },
        { label: 'Pending verification', value: unverifiedMechanics.toLocaleString(), pct: unverifiedPct, color: '#f59e0b' },
      ],
      footer: `${verifiedPct}% of the fleet is verified and eligible for jobs.`,
    },
    platformFees: {
      title: 'Platform Fee Ledger',
      icon: <Wallet size={20} />,
      accentColor: C.purple,
      description: 'Paid and owed platform fees recorded for completed jobs.',
      mainValue: formatUGX(s.revenueCollected),
      mainLabel: 'Fees collected',
      rows: [
        { label: 'Paid fees', value: formatUGX(s.revenueCollected), pct: 100, color: C.amber },
        { label: 'Owed fees', value: formatUGX(s.pendingCollections), pct: 0, color: '#f59e0b' },
      ],
      footer: 'Driver payments to mechanics happen off-platform and are not included.',
    },
  };

  const cfg = CONFIGS[modalKey];

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.45)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '24px',
        animation: 'fadeIn 0.18s ease',
      }}
    >
      <style>{`@keyframes fadeIn { from { opacity:0; transform:scale(0.96) } to { opacity:1; transform:scale(1) } }`}</style>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--adm-surface)',
          border: `2px solid var(--adm-card-border)`,
          boxShadow: 'var(--adm-popup-shadow)',
          borderRadius: 20,
          padding: '28px 30px',
          width: '100%', maxWidth: 460,
          position: 'relative',
          animation: 'fadeIn 0.18s ease',
        }}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          style={{
            position: 'absolute', top: 16, right: 16,
            width: 32, height: 32, borderRadius: '50%',
            background: 'var(--adm-surface-2)',
            border: '1px solid var(--adm-divider)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', color: 'var(--adm-muted)',
            transition: 'background 0.15s, color 0.15s',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--adm-red-dim)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--adm-red)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--adm-surface-2)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--adm-muted)'; }}
        >
          <X size={15} />
        </button>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 12,
            background: `${cfg.accentColor}18`,
            border: `1px solid ${cfg.accentColor}30`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: cfg.accentColor, flexShrink: 0,
          }}>
            {cfg.icon}
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--adm-text)', letterSpacing: '-0.3px' }}>
              {cfg.title}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--adm-muted)', marginTop: 1 }}>
              {cfg.description}
            </div>
          </div>
        </div>

        {/* Divider */}
        <div style={{ height: 1, background: 'var(--adm-divider)', margin: '18px 0' }} />

        {/* Main metric */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, color: 'var(--adm-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
            {cfg.mainLabel}
          </div>
          <div style={{ fontSize: 38, fontWeight: 900, color: cfg.accentColor, letterSpacing: '-2px', lineHeight: 1 }}>
            {cfg.mainValue}
          </div>
        </div>

        {/* Row breakdown */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {cfg.rows.map((row, i) => (
            <div key={row.label} style={{
              padding: '13px 0',
              borderBottom: i < cfg.rows.length - 1 ? '1px solid var(--adm-divider)' : 'none',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: row.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 12.5, color: 'var(--adm-muted)', fontWeight: 500 }}>{row.label}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--adm-text)' }}>{row.value}</span>
                  <span style={{
                    fontSize: 10, fontWeight: 700,
                    background: `${row.color}18`, color: row.color,
                    border: `1px solid ${row.color}30`,
                    padding: '1px 7px', borderRadius: 20,
                  }}>{row.pct}%</span>
                </div>
              </div>
              <div style={{ height: 4, background: 'var(--adm-track-bg)', borderRadius: 99, overflow: 'hidden' }}>
                <div style={{
                  height: '100%', width: `${Math.min(row.pct, 100)}%`,
                  background: row.color, borderRadius: 99,
                  transition: 'width 0.6s ease',
                }} />
              </div>
            </div>
          ))}
        </div>

        {/* Footer note */}
        {cfg.footer && (
          <div style={{
            marginTop: 18, padding: '10px 14px',
            background: `${cfg.accentColor}0d`,
            border: `1px solid ${cfg.accentColor}20`,
            borderRadius: 10,
            fontSize: 12, color: 'var(--adm-muted)', lineHeight: 1.6,
          }}>
            {cfg.footer}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function FinanceRow({
  label, value, color, pct, isLoading, isLast,
}: {
  label: string; value: string; color: string;
  pct: number; isLoading?: boolean; isLast?: boolean;
}) {
  if (isLoading) {
    return (
      <div style={{ padding: '14px 0', borderBottom: isLast ? 'none' : '1px solid rgba(255,255,255,0.05)' }}>
        <Skeleton className="h-3 w-28 mb-2" style={{ background: 'var(--adm-skeleton)' }} />
        <Skeleton className="h-5 w-24" style={{ background: 'var(--adm-skeleton)' }} />
      </div>
    );
  }
  return (
    <div style={{
      padding: '14px 0',
      borderBottom: isLast ? 'none' : '1px solid var(--adm-divider)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
          <span style={{ fontSize: 12, color: 'var(--adm-muted)', fontWeight: 500 }}>{label}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--adm-text)' }}>{value}</span>
          <span style={{
            fontSize: 10, fontWeight: 700,
            background: `${color}18`, color, border: `1px solid ${color}30`,
            padding: '1px 6px', borderRadius: 20,
          }}>
            {pct}%
          </span>
        </div>
      </div>
      {/* Progress bar */}
      <div style={{ height: 3, background: 'var(--adm-track-bg)', borderRadius: 99, overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${Math.min(pct, 100)}%`,
          background: color, borderRadius: 99,
          transition: 'width 0.8s ease',
        }} />
      </div>
    </div>
  );
}

function MechanicBar({
  label, icon, value, total, color, isLoading,
}: {
  label: string; icon: ReactNode; value: number;
  total: number; color: string; isLoading?: boolean;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  if (isLoading) {
    return (
      <div>
        <Skeleton className="h-3 w-32 mb-2" style={{ background: 'var(--adm-skeleton)' }} />
        <Skeleton className="h-2 w-full" style={{ background: 'var(--adm-skeleton)' }} />
      </div>
    );
  }
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--adm-muted)', fontSize: 12 }}>
          <span style={{ color }}>{icon}</span> {label}
        </div>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--adm-text)' }}>{value} <span style={{ color: 'var(--adm-muted)', fontWeight: 400 }}>/ {total}</span></span>
      </div>
      <div style={{ height: 5, background: 'var(--adm-track-bg)', borderRadius: 99, overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${pct}%`, background: color,
          borderRadius: 99, transition: 'width 0.8s ease',
        }} />
      </div>
    </div>
  );
}

function JobBar({
  label, value, total, color, isLoading,
}: {
  label: string; value: number; total: number; color: string; isLoading?: boolean;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  if (isLoading) {
    return (
      <div>
        <Skeleton className="h-3 w-32 mb-2" style={{ background: 'var(--adm-skeleton)' }} />
        <Skeleton className="h-2 w-full" style={{ background: 'var(--adm-skeleton)' }} />
      </div>
    );
  }
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
          <span style={{ fontSize: 12, color: 'var(--adm-muted)' }}>{label}</span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--adm-text)' }}>{value.toLocaleString()}</span>
          <span style={{
            fontSize: 10, fontWeight: 700,
            background: `${color}18`, color, border: `1px solid ${color}28`,
            padding: '1px 6px', borderRadius: 20,
          }}>
            {pct}%
          </span>
        </div>
      </div>
      <div style={{ height: 5, background: 'var(--adm-track-bg)', borderRadius: 99, overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${pct}%`, background: color,
          borderRadius: 99, transition: 'width 0.8s ease',
        }} />
      </div>
    </div>
  );
}

