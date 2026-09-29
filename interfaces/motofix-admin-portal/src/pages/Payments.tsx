// Payments.tsx — job-level payment records with summary figures from the platform-fee ledger.

import { useState, useMemo } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { ColumnDef } from '@tanstack/react-table';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { DataTable } from '@/components/table/DataTable';
import { Badge } from '@/components/ui/badge';
import { ChipCard } from '@/components/dashboard/StatsCard';
import { fetchPayments, fetchPaymentStats, Payment } from '@/lib/api';
import { format, isWithinInterval, startOfDay, endOfDay } from 'date-fns';
import { DateRange } from 'react-day-picker';
import { TrendingUp, User, Wrench, Search, X, CalendarRange, ChevronDown, Clock, Receipt, Wallet } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';

// ── Helpers ────────────────────────────────────────────────────────
const formatUGX = (n: number) => `UGX ${n.toLocaleString()}`;

const TIME_OPTIONS = [
  { value: 'all',       label: 'All hours' },
  { value: 'morning',   label: 'Morning  (6 am – 12 pm)' },
  { value: 'afternoon', label: 'Afternoon  (12 pm – 6 pm)' },
  { value: 'evening',   label: 'Evening  (6 pm – 12 am)' },
  { value: 'night',     label: 'Night  (12 am – 6 am)' },
] as const;
type TimeFilter = typeof TIME_OPTIONS[number]['value'];

const TIME_HOURS: Record<TimeFilter, [number, number]> = {
  all: [0, 24], morning: [6, 12], afternoon: [12, 18], evening: [18, 24], night: [0, 6],
};

// ── Status badge ───────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const normalized = String(status ?? '').trim().toLowerCase();
  const variants: Record<string, 'completed' | 'pending' | 'failed' | 'default'> = {
    success: 'completed',
    successful: 'completed',
    cash: 'completed',
    pending: 'pending',
    initiated: 'default',
    failed: 'failed',
    cancelled: 'failed',
    unknown: 'default',
    rejected: 'failed',
    declined: 'failed',
  };
  const labels: Record<string, string> = {
    success: 'Success',
    successful: 'Successful',
    cash: 'Cash',
    pending: 'Pending',
    initiated: 'Initiated',
    failed: 'Failed',
    cancelled: 'Cancelled',
    unknown: 'Unknown',
    rejected: 'Rejected',
    declined: 'Declined',
  };
  return <Badge variant={variants[normalized] ?? 'default'}>{(labels[normalized] ?? normalized) || 'Unknown'}</Badge>;
}

// Status dot colors for dropdowns
const STATUS_DOTS: Record<string, string> = {
  pending: 'bg-amber-500', initiated: 'bg-blue-500',
  success: 'bg-green-500', cash: 'bg-green-500', failed: 'bg-red-500', cancelled: 'bg-red-500',
};

// ── Columns ────────────────────────────────────────────────────────
const columns: ColumnDef<Payment>[] = [
  {
    accessorKey: 'date',
    header: 'Date',
    cell: ({ row }) => (
      <span className="text-sm text-muted-foreground whitespace-nowrap">
        {format(new Date(row.original.date), 'MMM d, HH:mm')}
      </span>
    ),
  },
  {
    accessorKey: 'customerName',
    header: 'Driver',
    cell: ({ row }) => (
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <User size={13} className="text-muted-foreground shrink-0" />
          <span className="text-sm font-medium">{row.original.customerName}</span>
        </div>
        <span className="text-xs text-muted-foreground font-mono pl-5">{row.original.driverPhone}</span>
      </div>
    ),
  },
  {
    accessorKey: 'mechanicName',
    header: 'Mechanic',
    cell: ({ row }) => (
      <div className="flex items-center gap-1.5">
        <Wrench size={13} className="text-muted-foreground shrink-0" />
        <span className="text-sm">{row.original.mechanicName}</span>
      </div>
    ),
  },
  {
    accessorKey: 'task',
    header: 'Task',
    cell: ({ row }) => (
      <span className="text-sm whitespace-nowrap">{row.original.task || '—'}</span>
    ),
  },
  {
    accessorKey: 'quotedAmount',
    header: 'Quoted',
    cell: ({ row }) => (
      <span className="font-semibold font-mono text-sm text-foreground">
        {formatUGX(row.original.quotedAmount)}
      </span>
    ),
  },
  {
    accessorKey: 'commission',
    header: 'Commission',
    cell: ({ row }) => (
      <span className="font-mono text-sm text-success">{formatUGX(row.original.commission)}</span>
    ),
  },
  {
    accessorKey: 'method',
    header: 'How paid',
    cell: ({ row }) => {
      const m = (row.original.method || '').toLowerCase();
      const label = m === 'mtn' ? 'MTN MoMo' : m === 'airtel' ? 'Airtel Money' : m === 'cash' ? 'Cash' : m === 'momo' ? 'Mobile Money' : '—';
      if (label === '—') return <span className="text-sm text-muted-foreground">—</span>;
      const color = m === 'mtn' ? '#F59E0B' : m === 'airtel' ? '#EF4444' : m === 'cash' ? '#22C55E' : '#A78BFA';
      return (
        <span className="text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap" style={{ color, background: `${color}22`, border: `1px solid ${color}55` }}>
          {label}
        </span>
      );
    },
  },
  {
    accessorKey: 'mechanicPayout',
    header: 'Payout',
    cell: ({ row }) => (
      <span className={cn('font-mono text-sm', row.original.disbursementStatus === 'success' ? 'text-warning' : 'text-muted-foreground')}>
        {formatUGX(row.original.mechanicPayout)}
      </span>
    ),
  },
  {
    accessorKey: 'collectionStatus',
    header: 'Collection',
    cell: ({ row }) => <StatusBadge status={row.original.collectionStatus} />,
  },
  {
    accessorKey: 'disbursementStatus',
    header: 'Payout Status',
    cell: ({ row }) => <StatusBadge status={row.original.disbursementStatus} />,
  },
];

// ─────────────────────────────────────────────────────────────────
export default function Payments() {
  const [search, setSearch]               = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [collectionStatus, setCollectionStatus]     = useState('all');
  const [disbursementStatus, setDisbursementStatus] = useState('all');
  const [dateRange, setDateRange]         = useState<DateRange | undefined>(undefined);
  const [calOpen, setCalOpen]             = useState(false);
  const [timeFilter, setTimeFilter]       = useState<TimeFilter>('all');
  const [page, setPage]                   = useState(1);

  const { data: paymentsData, isLoading: paymentsLoading, error: paymentsError } = useQuery({
    queryKey: ['payments', { search, collectionStatus, disbursementStatus, page }],
    queryFn: () => fetchPayments({
      search: search || undefined,
      collectionStatus: collectionStatus !== 'all' ? collectionStatus : undefined,
      disbursementStatus: disbursementStatus !== 'all' ? disbursementStatus : undefined,
      page,
      pageSize: 10,
    }),
    placeholderData: keepPreviousData,
    retry: 1,
    staleTime: 3 * 60 * 1000,   // 3 minutes
    gcTime:   10 * 60 * 1000,   // keep in cache 10 minutes
  });

  const { data: stats, isLoading: statsLoading, error: statsError } = useQuery({
    queryKey: ['payment-stats'],
    queryFn: fetchPaymentStats,
    placeholderData: keepPreviousData,
    retry: 1,
    staleTime: 3 * 60 * 1000,
    gcTime:   10 * 60 * 1000,
  });

  // Client-side date + time filter
  const displayData = useMemo(() => {
    let rows = paymentsData?.data || [];

    if (dateRange?.from) {
      const from = startOfDay(dateRange.from);
      const to   = endOfDay(dateRange.to ?? dateRange.from);
      rows = rows.filter(r => isWithinInterval(new Date(r.date), { start: from, end: to }));
    }

    if (timeFilter !== 'all') {
      const [h0, h1] = TIME_HOURS[timeFilter];
      rows = rows.filter(r => {
        const h = new Date(r.date).getHours();
        return h1 === 24 ? h >= h0 : h >= h0 && h < h1;
      });
    }

    return rows;
  }, [paymentsData, dateRange, timeFilter]);

  const displayStats = stats || { totalCollected: 0, totalTransactions: 0, pendingCollections: 0 };
  const hasFilters = search !== '' || collectionStatus !== 'all' || disbursementStatus !== 'all' || !!dateRange?.from || timeFilter !== 'all';

  const clearAll = () => {
    setSearch(''); setCollectionStatus('all'); setDisbursementStatus('all');
    setDateRange(undefined); setTimeFilter('all'); setPage(1);
  };

  const dateLabel = dateRange?.from
    ? dateRange.to && dateRange.to.getTime() !== dateRange.from.getTime()
      ? `${format(dateRange.from, 'MMM d')} – ${format(dateRange.to, 'MMM d, yyyy')}`
      : format(dateRange.from, 'MMM d, yyyy')
    : 'Pick a date range';

  const statusItems = [
    { value: 'all', label: 'All' },
    { value: 'pending',   label: 'Pending' },
    { value: 'initiated', label: 'Initiated' },
    { value: 'success',   label: 'Success' },
    { value: 'cash',      label: 'Cash' },
    { value: 'failed',    label: 'Failed' },
    { value: 'cancelled', label: 'Cancelled' },
  ];

  if ((paymentsError && !paymentsData) || (statsError && !stats)) {
    return (
      <DashboardLayout>
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          Payment data is unavailable. Check the dispatch and analytics database services, then refresh.
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-5">

        {/* Header */}
        <div>
          <h1 className="text-2xl lg:text-3xl font-bold">Payments & Transactions</h1>
          <p className="text-sm text-foreground/70 mt-1">Job-level payment and quote records. Platform revenue is tracked separately in platform_fees.</p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <ChipCard
            title="Job Payment Records"
            value={displayStats.totalTransactions.toLocaleString()}
            icon={<Receipt size={18} />}
            iconColor="var(--adm-muted)"
            isLoading={statsLoading}
          />
          <ChipCard
            title="Revenue Collected"
            value={formatUGX(displayStats.totalCollected)}
            icon={<TrendingUp size={18} />}
            iconColor="var(--adm-green)"
            isLoading={statsLoading}
          />
          <ChipCard
            title="Pending Collections"
            value={formatUGX(displayStats.pendingCollections)}
            icon={<Clock size={18} />}
            iconColor="var(--adm-amber)"
            isLoading={statsLoading}
          />
        </div>

        {/* Search */}
        <div className="relative">
          <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search by driver name or phone number…"
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            style={{
              border: searchFocused ? '1.5px solid rgba(255,179,0,0.80)' : '1.5px solid rgba(0,0,0,0.75)',
              boxShadow: searchFocused ? '0 0 0 3px rgba(255,179,0,0.13)' : 'none',
              transition: 'border-color 0.15s, box-shadow 0.15s',
            }}
            className="w-full h-10 pl-10 pr-9 rounded-lg bg-background text-sm outline-none"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X size={14} />
            </button>
          )}
        </div>

        {/* Filter row */}
        <div className="flex flex-wrap items-center gap-3">

          {/* Collection status */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">Collection</span>
            <Select value={collectionStatus} onValueChange={v => { setCollectionStatus(v); setPage(1); }}>
              <SelectTrigger className="h-9 w-[145px] text-sm" style={{ border: '1.5px solid rgba(0,0,0,0.75)' }}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statusItems.map(s => (
                  <SelectItem key={s.value} value={s.value}>
                    <span className="flex items-center gap-2">
                      {s.value !== 'all' && <span className={`w-2 h-2 rounded-full inline-block ${STATUS_DOTS[s.value]}`} />}
                      {s.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Disbursement status */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">Payout</span>
            <Select value={disbursementStatus} onValueChange={v => { setDisbursementStatus(v); setPage(1); }}>
              <SelectTrigger className="h-9 w-[145px] text-sm" style={{ border: '1.5px solid rgba(0,0,0,0.75)' }}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statusItems.map(s => (
                  <SelectItem key={s.value} value={s.value}>
                    <span className="flex items-center gap-2">
                      {s.value !== 'all' && <span className={`w-2 h-2 rounded-full inline-block ${STATUS_DOTS[s.value]}`} />}
                      {s.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Date range */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">Date</span>
            <Popover open={calOpen} onOpenChange={setCalOpen}>
              <PopoverTrigger asChild>
                <button
                  className={cn(
                    "flex items-center gap-2 h-9 px-3 rounded-lg text-sm transition-all",
                    dateRange?.from ? "bg-primary/8 text-primary font-medium" : "bg-secondary/50 text-muted-foreground hover:text-foreground",
                  )}
                  style={{ border: '1.5px solid rgba(0,0,0,0.75)' }}
                >
                  <CalendarRange size={14} />
                  <span>{dateLabel}</span>
                  {dateRange?.from
                    ? <X size={13} onClick={e => { e.stopPropagation(); setDateRange(undefined); }} className="ml-1 opacity-60 hover:opacity-100" />
                    : <ChevronDown size={13} className="ml-1" />
                  }
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-auto p-0 shadow-xl border">
                <div className="p-3 border-b flex items-center justify-between">
                  <span className="text-sm font-semibold">Select date range</span>
                  {dateRange?.from && (
                    <button onClick={() => setDateRange(undefined)} className="text-xs text-muted-foreground hover:text-foreground">Clear</button>
                  )}
                </div>
                <Calendar
                  mode="range"
                  selected={dateRange}
                  onSelect={val => { setDateRange(val); if (val?.from && val?.to) setCalOpen(false); }}
                  numberOfMonths={2}
                  disabled={{ after: new Date() }}
                  initialFocus
                />
                {dateRange?.from && (
                  <div className="px-4 py-2.5 border-t bg-muted/30 text-xs text-muted-foreground">
                    {dateRange.to && dateRange.to.getTime() !== dateRange.from.getTime()
                      ? <>{format(dateRange.from, 'PPPP')} → {format(dateRange.to, 'PPPP')}</>
                      : <>{format(dateRange.from, 'PPPP')} — click another day to set end date</>
                    }
                  </div>
                )}
              </PopoverContent>
            </Popover>
          </div>

          {/* Time of day */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">Time</span>
            <Select value={timeFilter} onValueChange={v => setTimeFilter(v as TimeFilter)}>
              <SelectTrigger className="h-9 w-[190px] text-sm" style={{ border: '1.5px solid rgba(0,0,0,0.75)' }}>
                <Clock size={13} className="mr-1 text-muted-foreground flex-shrink-0" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIME_OPTIONS.map(o => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Clear all */}
          {hasFilters && (
            <button
              onClick={clearAll}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground border border-border/60 hover:border-border px-3 h-9 rounded-lg transition-all ml-auto"
            >
              <X size={13} /> Clear all
            </button>
          )}
        </div>

        {/* Table */}
        <DataTable
          columns={columns}
          data={displayData}
          isLoading={paymentsLoading}
          pagination={paymentsData ? {
            page: paymentsData.page,
            pageSize: paymentsData.pageSize,
            total: paymentsData.total,
            totalPages: paymentsData.totalPages,
            onPageChange: setPage,
          } : undefined}
        />
      </div>
    </DashboardLayout>
  );
}
