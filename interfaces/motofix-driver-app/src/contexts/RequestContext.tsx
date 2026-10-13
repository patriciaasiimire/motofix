// RequestContext.tsx — the shared store of the driver's service requests.
//
// A React "context" is app-wide shared state: any page can call useRequests() to
// read the driver's requests instead of each page fetching its own copy. This one
// is the source of truth for "what jobs do I have and what's happening with them".
//
// How it stays up to date (three layers, most-live first):
//   1. WebSocket — the server pushes events the instant something changes (mechanic
//      accepted, is en route, moved on the map, finished). Handled in the WS effect.
//   2. REST fetch — fetchAll() pulls the full list from the server (on load, on login
//      change, and after each WS event) as the reliable snapshot.
//   3. Polling fallback — while a request is active and WebSocket is unavailable,
//      refresh the request list every 15s (only while the page is visible).
//
// Two subtleties worth knowing:
//   • "Optimistic cancel": when the driver cancels, we flip the status locally right
//     away (markCancelled) and refuse to let a stale server snapshot revert it until
//     the server confirms — so the UI never flickers back to "active".
//   • Live mechanic position (mechanic_lat/lon) only exists in WebSocket messages, not
//     in the REST snapshot, so applyUpdates carefully preserves it across refreshes.

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
} from 'react';
import { requestsService, paymentsService } from '@/config/api';
import { createRequestsWs, WsPayload } from '@/services/driverWs';
import { addNotification } from '@/lib/notifications';
import { toast } from 'sonner';

export interface QuoteRecord {
  id: number;
  request_id: number;
  quoted_amount: number;
  commission: number;
  mechanic_payout: number;
  quote_approved: boolean;
  collection_status: string;
  disbursement_status: string;
}

export interface Request {
  id: number | string;
  service_type: string;
  location: string;
  description: string;
  status: string;
  created_at?: string;
  updated_at?: string;
  user_id?: number;
  driver_id?: number;
  workflow_status?: string;
  mechanic_id?: number | string;
  mechanic_name?: string;
  mechanic_lat?: number;
  mechanic_lon?: number;
  dispatched_at?: string;
  accepted_at?: string;
  en_route_at?: string;
  arrived_at?: string;
  service_started_at?: string;
  completed_at?: string;
  eta_minutes?: number;
  completion_by?: 'mechanic' | 'driver' | 'system' | null;
  actual_fee?: number | null;       // final charge the mechanic entered
  service_note?: string | null;     // what was fixed (the ticked AI fixes, joined)
  // v1 canonical fields
  issue_type?: string | null;
  area_id?: number | null;
  location_text?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  matched_mechanic_id?: number | null;
  matched_mechanic_name?: string | null;
  matched_mechanic_phone?: string | null;
  matched_mechanic_phone?: string | null;
  cancelled_at?: string | null;
}

interface RequestContextValue {
  requests: Request[];
  isLoading: boolean;
  error: string | null;
  isWsConnected: boolean;
  refresh: () => Promise<void>;
  markCancelled: (id: string) => void;
  revertCancelled: (id: string) => void;
  sendWsMessage: (data: object) => void;
  featureFlagsLoaded: boolean;
  paymentsEnabled: boolean;
  pendingQuote: QuoteRecord | null;
  pendingQuoteRequestId: string | null;
  setPendingQuote: (q: QuoteRecord | null) => void;
  clearPendingQuote: () => void;
}

const RequestContext = createContext<RequestContextValue | null>(null);

const STATUS_MESSAGES: Record<string, string> = {
  searching: '🔍 We are looking for a verified provider for your request',
  assigned: '🔧 A provider has accepted your request!',
  accepted: '🔧 A mechanic has accepted your request!',
  en_route: '🚗 Your mechanic is on the way!',
  arrived: '📍 Your mechanic has arrived!',
  service_started: '🛠️ Service has started!',
  completed: '✅ Your request has been completed!',
  // Only ever shown for an EXTERNAL cancellation: the driver's own cancels are recorded
  // in previousStatusesRef (by markCancelled) so they never re-fire a toast here. In this
  // app an external cancel means the mechanic pulled out, so we name them.
  cancelled: '❌ Your mechanic cancelled this request',
};

function canonicalStatus(status: string): string {
  if (status === 'pending' || status === 'searching') return 'searching';
  if (status === 'completed' || status === 'cancelled') return status;
  return 'assigned';
}

export function RequestProvider({ children }: { children: React.ReactNode }) {
  const [requests, setRequests] = useState<Request[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isWsConnected, setIsWsConnected] = useState(false);
  const [featureFlagsLoaded, setFeatureFlagsLoaded] = useState(false);
  const [paymentsEnabled, setPaymentsEnabled] = useState(false);
  const [pendingQuote, setPendingQuote] = useState<QuoteRecord | null>(null);
  const [pendingQuoteRequestId, setPendingQuoteRequestId] = useState<string | null>(null);

  const previousStatusesRef  = useRef<Map<string, string>>(new Map());
  const localCancelledRef    = useRef(new Set<string>());
  const fallbackPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const quoteCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wsSendRef = useRef<((data: object) => void) | null>(null);

  const sendWsMessage = useCallback((data: object) => {
    wsSendRef.current?.(data);
  }, []);

  const clearPendingQuote = useCallback(() => {
    setPendingQuote(null);
    setPendingQuoteRequestId(null);
  }, []);

  const markCancelled = useCallback((id: string) => {
    localCancelledRef.current.add(id);
    setRequests(prev =>
      prev.map(r => String(r.id) === id ? { ...r, status: 'cancelled', workflow_status: 'cancelled' } : r)
    );
    previousStatusesRef.current.set(id, 'cancelled');
  }, []);

  const revertCancelled = useCallback((id: string) => {
    localCancelledRef.current.delete(id);
  }, []);

  const applyUpdates = useCallback((incoming: Request[]) => {
    // Use functional form of setRequests so we can access current state and
    // preserve live mechanic positions (set via WS location_update) that the
    // REST API snapshot doesn't include.
    setRequests(prev => {
      // Build a lookup of current WS-sourced mechanic positions
      const mechPos = new Map(prev.map(r => [String(r.id), { lat: r.mechanic_lat, lon: r.mechanic_lon }]));

      const result = incoming.map((source) => {
        const workflowStatus = source.workflow_status ?? source.status;
        let r: Request = {
          ...source,
          workflow_status: workflowStatus,
          status: canonicalStatus(workflowStatus),
        };
        const id = String(r.id);
        // If we optimistically cancelled a request, don't let a stale server
        // response (arriving via WS-triggered fetchAll) revert it back to active.
        if (localCancelledRef.current.has(id)) {
          if (r.status === 'cancelled') {
            localCancelledRef.current.delete(id); // server confirmed — clean up
          } else {
            r = { ...r, status: 'cancelled', workflow_status: 'cancelled' }; // force cancelled until server confirms
          }
        }
        // Preserve live mechanic position from WS state — the REST API snapshot
        // never includes mechanic_lat/lon (they are in-memory only).
        const saved = mechPos.get(id);
        if (saved?.lat != null && r.mechanic_lat == null) {
          r = { ...r, mechanic_lat: saved.lat, mechanic_lon: saved.lon };
        }
        return r;
      });

      result.forEach((req) => {
        const prevStatus = previousStatusesRef.current.get(String(req.id));
        if (prevStatus && prevStatus !== req.status) {
          const msg = STATUS_MESSAGES[req.status];
          if (msg) {
            toast.success(msg, { duration: 5000 });
            addNotification({
              kind: 'job',
              title: msg,
              body: req.mechanic_name ? `Mechanic: ${req.mechanic_name}` : undefined,
              link: `/requests/${req.id}`,
              dedupeKey: `${req.id}:${req.status}`,
            });
          }
        }
        previousStatusesRef.current.set(String(req.id), req.status);
      });

      return result;
    });
  }, []);

  const fetchAll = useCallback(async (showLoader = true) => {
    if (showLoader) setIsLoading(true);
    setError(null);
    if (!localStorage.getItem('motofix_token')) {
      setRequests([]);
      setIsLoading(false);
      return;
    }
    try {
      const res = await requestsService.getAll();
      applyUpdates(res.data || []);
    } catch (err: unknown) {
      console.error('[dispatch] Could not load requests; continuing with cached or empty state.', err);
    } finally {
      setIsLoading(false);
    }
  }, [applyUpdates]);

  // Initial fetch
  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Clear stale data and re-fetch whenever the logged-in user changes
  useEffect(() => {
    const handleAuthChange = () => {
      setRequests([]);
      previousStatusesRef.current.clear();
      fetchAll(true);
    };
    window.addEventListener('motofix:auth-changed', handleAuthChange);
    return () => window.removeEventListener('motofix:auth-changed', handleAuthChange);
  }, [fetchAll]);

  // Feature flags (DB-backed) - varies by deployment via `SERVICE_VARIANT`
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const res = await requestsService.getFeatureFlags();
        if (!cancelled) setPaymentsEnabled(!!res.data?.payments);
      } catch (err) {
        console.warn('[dispatch] Feature flags unavailable; using disabled defaults.', err);
        if (!cancelled) setPaymentsEnabled(false);
      } finally {
        if (!cancelled) setFeatureFlagsLoaded(true);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // WebSocket for real-time updates
  useEffect(() => {
    const { stop, send } = createRequestsWs(
      (payload: WsPayload) => {
        // Real-time mechanic location update — only apply updates from the mechanic side
        if (
          payload.type === 'location_update' &&
          payload.lat != null && payload.lng != null &&
          (payload.role === 'mechanic' || payload.role == null)  // accept untagged legacy messages too
        ) {
          // Ignore echoes of the driver's own broadcasts
          if (payload.role === 'driver') return;
          const rid = String(payload.service_request_id ?? payload.request_id ?? payload.job_id ?? '');
          if (rid) {
            setRequests((prev) =>
              prev.map((r) =>
                String(r.id) === rid
                  ? { ...r, mechanic_lat: payload.lat as number, mechanic_lon: payload.lng as number }
                  : r
              )
            );
          }
          return;
        }

        if (payload.type === 'matching_empty') {
          window.dispatchEvent(new CustomEvent('motofix:matching-empty', {
            detail: { request_id: String(payload.request_id ?? '') },
          }));
          return;
        }

        // Handle status-change events pushed by the backend
        if (payload.type === 'status_update' || payload.type === 'job_taken') {
          // Optimistically update the matching request in state
          setRequests((prev) =>
            prev.map((r) => {
              const rid = String(r.id);
              const pid = String(payload.request_id ?? payload.job_id ?? '');
              if (rid !== pid) return r;
              // Never override a request the user just cancelled — wait for applyUpdates
              if (localCancelledRef.current.has(rid)) return r;
              // The backend bundles a full request snapshot with status_update —
              // pull the mechanic's final charge + what-was-fixed (and journey
              // fields) from it so the driver sees the AGREED figure live, before
              // confirming the job is done.
              const snap = (payload.request as Record<string, unknown> | undefined);
              const workflowStatus = String(payload.status ?? r.workflow_status ?? r.status);
              const updated: Request = {
                ...r,
                workflow_status: workflowStatus,
                status: canonicalStatus(workflowStatus),
                mechanic_id: (payload.mechanic_id as string) ?? r.mechanic_id,
                mechanic_name: (payload.mechanic_name as string) ?? r.mechanic_name,
                mechanic_lat: (payload.mechanic_lat as number) ?? r.mechanic_lat,
                mechanic_lon: (payload.mechanic_lon as number) ?? r.mechanic_lon,
                actual_fee:    (snap?.actual_fee as number | null | undefined) ?? r.actual_fee,
                service_note:  (snap?.service_note as string | null | undefined) ?? r.service_note,
                completion_by: (snap?.completion_by as Request['completion_by']) ?? r.completion_by,
                eta_minutes:   (snap?.eta_minutes as number | undefined) ?? r.eta_minutes,
              };
              // Fire toast if status changed
              const prev = previousStatusesRef.current.get(rid);
              if (prev && prev !== updated.status) {
                const msg = STATUS_MESSAGES[updated.status];
                if (msg) {
                  toast.success(msg, { duration: 5000 });
                  addNotification({
                    kind: 'job',
                    title: msg,
                    body: updated.mechanic_name ? `Mechanic: ${updated.mechanic_name}` : undefined,
                    link: `/requests/${rid}`,
                    dedupeKey: `${rid}:${updated.status}`,
                  });
                }
              }
              previousStatusesRef.current.set(rid, updated.status);
              return updated;
            })
          );
        }
        // Re-fetch on any event to stay in sync
        fetchAll(false);
      },
      () => {
        setIsWsConnected(true);
        if (fallbackPollRef.current) {
          clearInterval(fallbackPollRef.current);
          fallbackPollRef.current = null;
        }
      },
      () => {
        setIsWsConnected(false);
      },
    );

    wsSendRef.current = send;
    return () => {
      wsSendRef.current = null;
      stop();
    };
  }, [fetchAll]);

  const hasLiveRequest = requests.some(r => r.status !== 'completed' && r.status !== 'cancelled');

  // Refresh the request list only while work is active and the socket is down.
  useEffect(() => {
    if (isWsConnected || !hasLiveRequest) return;
    const poll = () => {
      if (document.visibilityState === 'visible') void fetchAll(false);
    };
    fallbackPollRef.current = setInterval(poll, 15_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') poll();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (fallbackPollRef.current) {
        clearInterval(fallbackPollRef.current);
        fallbackPollRef.current = null;
      }
    };
  }, [fetchAll, hasLiveRequest, isWsConnected]);

  const refresh = useCallback(() => fetchAll(false), [fetchAll]);

  // Poll for a pending quote whenever there are accepted/en_route requests
  useEffect(() => {
    if (!featureFlagsLoaded || !paymentsEnabled) return;

    const active = requests.filter(
      (r) => r.status === 'accepted' || r.status === 'en_route'
    );

    if (quoteCheckRef.current) clearInterval(quoteCheckRef.current);
    if (active.length === 0) return;

    const checkForQuote = async () => {
      for (const req of active) {
        try {
          const res = await paymentsService.getQuote(String(req.id));
          const q: QuoteRecord = res.data;
          if (q && q.collection_status !== 'success') {
            setPendingQuote(q);
            setPendingQuoteRequestId(String(req.id));
            return;
          }
        } catch {
          // No quote yet — keep polling
        }
      }
    };

    checkForQuote();
    quoteCheckRef.current = setInterval(checkForQuote, 5000);
    return () => { if (quoteCheckRef.current) clearInterval(quoteCheckRef.current); };
  }, [requests, featureFlagsLoaded, paymentsEnabled]);

  return (
    <RequestContext.Provider value={{
      requests,
      isLoading,
      error,
      isWsConnected,
      refresh,
      markCancelled,
      revertCancelled,
      sendWsMessage,
      featureFlagsLoaded,
      paymentsEnabled,
      pendingQuote, pendingQuoteRequestId, setPendingQuote, clearPendingQuote,
    }}>
      {children}
    </RequestContext.Provider>
  );
}

export function useRequests() {
  const ctx = useContext(RequestContext);
  if (!ctx) throw new Error('useRequests must be used inside RequestProvider');
  return ctx;
}
