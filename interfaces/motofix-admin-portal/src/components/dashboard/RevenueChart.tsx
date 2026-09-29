// RevenueChart.tsx — the dashboard chart showing revenue over time (the last N days),
// fed by fetchRevenueChart. Lets admins see earning trends.

import {
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { Skeleton } from '@/components/ui/skeleton';
import { useTheme } from '@/contexts/ThemeContext';

interface DataPoint {
  label: string;
  revenue: number;
}

const fmtShort = (v: number) => {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(0)}K`;
  return v.toString();
};

interface RevenueChartProps {
  data: { date: string; amount: number }[];
  isLoading?: boolean;
  hasError?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

function CustomTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { value: number }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: 'var(--adm-popup-bg)',
      border: '1px solid var(--adm-popup-border)',
      borderRadius: 10, padding: '10px 14px',
      boxShadow: 'var(--adm-popup-shadow)',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--adm-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 800, color: '#FFB300' }}>
        UGX {payload[0].value.toLocaleString()}
      </div>
    </div>
  );
}

export function RevenueChart({ data, isLoading, hasError, className, style }: RevenueChartProps) {
  const { isDark } = useTheme();

  const AMBER = '#FFB300';
  const MUTED = isDark ? '#6b6b82' : '#374151';
  const TEXT  = isDark ? '#ededf4' : '#0f1121';
  const GRID  = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';

  const chartData: DataPoint[] = data.map(d => {
    let label = d.date;
    try { label = new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch { /* */ }
    return { label, revenue: d.amount };
  });

  const CARD: React.CSSProperties = {
    background: 'var(--adm-surface)',
    border: '2px solid var(--adm-card-border)',
    boxShadow: 'var(--adm-card-shadow)',
    borderRadius: 16,
    padding: '24px 26px',
  };

  if (isLoading) {
    return (
      <div style={CARD}>
        <Skeleton className="h-5 w-40 mb-8" style={{ background: 'var(--adm-skeleton)' }} />
        <Skeleton className="h-[260px] w-full" style={{ background: 'var(--adm-skeleton)' }} />
      </div>
    );
  }

  return (
    <div
      className={className}
      style={{ ...CARD, transition: 'transform 0.22s ease, box-shadow 0.22s ease, border-color 0.2s ease', ...style }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = 'var(--adm-border-hi)';
        e.currentTarget.style.transform   = 'translateY(-3px)';
        e.currentTarget.style.boxShadow   = 'var(--adm-hover-shadow)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = 'var(--adm-card-border)';
        e.currentTarget.style.transform   = 'translateY(0)';
        e.currentTarget.style.boxShadow   = 'var(--adm-card-shadow)';
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: AMBER, boxShadow: `0 0 6px ${AMBER}` }} />
          <span style={{ fontSize: 15, fontWeight: 700, color: TEXT }}>Revenue Collected</span>
        </div>
      </div>

      {/* Chart */}
      {hasError ? (
        <div style={{ height: 280, display: 'grid', placeItems: 'center', color: MUTED, fontSize: 13 }}>
          Revenue data is temporarily unavailable.
        </div>
      ) : data.length === 0 ? (
        <div style={{ height: 280, display: 'grid', placeItems: 'center', color: MUTED, fontSize: 13 }}>
          No platform fees have been collected in this period.
        </div>
      ) : <div style={{ height: 280 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="rcBarGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stopColor={AMBER} stopOpacity={0.95} />
                <stop offset="100%" stopColor={AMBER} stopOpacity={0.5}  />
              </linearGradient>
            </defs>

            <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />

            <XAxis
              dataKey="label"
              axisLine={false} tickLine={false}
              tick={{ fill: MUTED, fontSize: 11 }}
              dy={8}
              interval={4}
            />
            <YAxis
              axisLine={false} tickLine={false}
              tick={{ fill: MUTED, fontSize: 11 }}
              tickFormatter={fmtShort}
              width={48}
            />

            <Tooltip
              content={<CustomTooltip />}
              cursor={{ fill: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.04)' }}
            />

            <Bar
              dataKey="revenue"
              fill="url(#rcBarGrad)"
              radius={[4, 4, 0, 0]}
              maxBarSize={14}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>}
    </div>
  );
}
