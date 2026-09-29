// src/lib/api.ts — the admin portal's data layer (all server calls live here).
//
// Every screen gets its data through a function in this file, so this is the place to
// look for "where does X come from?". It's large but organised in clear groups:
//   • Auth token helpers — getAuthToken / setAuthToken / clearAuthToken / isAuthenticated
//     and the saved admin info (token is kept under 'motofix_admin_token').
//   • Dashboard — fetchDashboardStats, fetchRevenueChart, fetchLiveStats, fetchMapData...
//   • Mechanics / providers — list, create, update, delete, ban, reinstate, strikes, fees.
//   • Requests, Payments, Drivers, Applications, Spare parts, Admin profile/settings.
//
// Each function calls one of the shared clients from axiosClient.ts (which add the
// admin token automatically) and returns typed data. Use these functions — usually via
// the useDashboardData hook or React Query — instead of calling axios from a page.

import { API_CONFIG } from '@/config/api';
import requestsClient, { authClient } from './axiosClient';

// Use an empty base in development so requests go to the dev server origin
// and are proxied by Vite to the hosted API (avoids CORS). In production
// use the hosted API URL directly.
// Safe for production — no hard-coded URLs in Git
const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ||
  API_CONFIG.ADMIN_API_URL; // Use configured admin API URL
// No hardcoded admin token here anymore — tokens must come from a real login.

const TOKEN_KEY = 'motofix_admin_token';
const INFO_KEY  = 'motofix_admin_info';

export const getAuthToken = (): string | null => {
  return localStorage.getItem(TOKEN_KEY);
};

export const setAuthToken = (token: string) => {
  localStorage.setItem(TOKEN_KEY, token);
};

export const clearAuthToken = () => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(INFO_KEY);
};

export const isAuthenticated = () => {
  return !!getAuthToken();
};

export interface AdminInfo {
  id: number;
  full_name: string;
  email: string;
  role: string;
}

export const setAdminInfo = (info: AdminInfo) => {
  localStorage.setItem(INFO_KEY, JSON.stringify(info));
};

export const getAdminInfo = (): AdminInfo | null => {
  try {
    const raw = localStorage.getItem(INFO_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function fetchWithAuth<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = getAuthToken();

  if (!token) {
    clearAuthToken();
    window.location.href = '/login';
    throw new ApiError(401, 'No auth token');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000); // 12s hard timeout

  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...options.headers,
      },
    });

    clearTimeout(timer);

    if (response.status === 401) {
      clearAuthToken();
      window.location.href = '/login';
      throw new ApiError(401, 'Unauthorized');
    }

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new ApiError(response.status, `API Error: ${text}`);
    }

    return response.json();
  } catch (err: any) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') throw new ApiError(408, 'Request timed out');
    throw err;
  }
}

// Dashboard Stats
export interface DashboardStats {
  totalRequests: number;
  completedJobs: number;
  pendingJobs: number;
  totalMechanics: number;
  verifiedMechanics: number;
  revenueCollected: number;
  pendingCollections: number;
}

export interface RevenueData {
  date: string;
  amount: number;
}

export const fetchDashboardStats = async (): Promise<DashboardStats> => {
  const raw = await fetchWithAuth<any>('/admin/stats');
  return {
    totalRequests: Number(raw.total_requests ?? 0),
    completedJobs: Number(raw.completed_jobs ?? 0),
    pendingJobs: Number(raw.pending_jobs ?? 0),
    totalMechanics: Number(raw.total_mechanics ?? 0),
    verifiedMechanics: Number(raw.verified_mechanics ?? 0),
    revenueCollected: Number(raw.revenue_collected_ugx ?? 0),
    pendingCollections: Number(raw.pending_collections_ugx ?? 0),
  };
};

export const fetchRevenueChart = async (days: number = 30): Promise<RevenueData[]> => {
  const raw = await fetchWithAuth<any[]>(`/admin/dashboard/revenue-chart?limit=${days}`);
  return raw.map((item) => ({ date: item.date || '', amount: Number(item.amount || 0) }));
};

// Service Requests
export interface ServiceRequest {
  id: string;
  customerName: string;
  serviceType: string;
  location: string;
  description?: string;
  status: 'pending' | 'accepted' | 'in_progress' | 'completed' | 'cancelled';
  mechanicId?: number;
  mechanicName?: string;
  createdAt: string;
  dispatchedAt?: string;
  completedAt?: string;
  actualFee?: number | null;     // the mechanic's final agreed charge (UGX)
  serviceNote?: string | null;   // what the mechanic fixed
  // Media tied to the job: files uploaded with the request PLUS anything exchanged in
  // the in-job chat (the backend folds both into this list for the admin view).
  media_files?: { url: string; file_type: string; size_kb: number; uploaded_at: string }[];
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface RequestsParams {
  page?: number;
  pageSize?: number;
  status?: string;
  search?: string;
}

export const fetchServiceRequests = (params: RequestsParams) => {
  const searchParams = new URLSearchParams();
  if (params.page) searchParams.set('page', params.page.toString());
  if (params.pageSize) searchParams.set('pageSize', params.pageSize.toString());
  if (params.status && params.status !== 'all') searchParams.set('status', params.status);
  if (params.search) searchParams.set('search', params.search);

  return fetchWithAuth<PaginatedResponse<ServiceRequest>>(`/admin/requests?${searchParams}`);
};

// Public requests endpoint (from requests microservice)
export const fetchPublicRequests = async (params: RequestsParams = {}) => {
  try {
    const resp = await requestsClient.get('/requests/', {
      params: {
        page: params.page,
        pageSize: params.pageSize,
        status: params.status,
        search: params.search,
      },
    });

    const raw = resp.data;

    // If backend returns plain array
    const arr = Array.isArray(raw) ? raw : (raw.data || raw.items || []);

    const data: ServiceRequest[] = arr.map((r: any) => ({
      id: String(r.id ?? r.request_id ?? r._id ?? ''),
      customerName: r.customer_name ?? r.customerName ?? r.customer_phone ?? r.phone ?? '',
      serviceType: r.service_type ?? r.serviceType ?? r.type ?? '',
      location: r.location ?? r.address ?? '',
      description: r.description ?? undefined,
      status: r.status ?? 'pending',
      mechanicId: r.mechanic_id ?? r.mechanicId ?? undefined,
      mechanicName: r.mechanic_name ?? r.mechanicName ?? r.assigned_mechanic ?? undefined,
      createdAt: r.created_at ?? r.createdAt ?? r.timestamp ?? new Date().toISOString(),
      dispatchedAt: r.dispatched_at ?? undefined,
      completedAt: r.completed_at ?? undefined,
      actualFee: r.actual_fee ?? null,
      serviceNote: r.service_note ?? null,
      media_files: r.media_files ?? [],   // uploaded + chat-exchanged media (kept for the admin table)
    }));

    return {
      data,
      total: raw.total ?? data.length,
      page: raw.page ?? params.page ?? 1,
      pageSize: raw.pageSize ?? params.pageSize ?? data.length,
      totalPages: raw.totalPages ?? 1,
    } as PaginatedResponse<ServiceRequest>;
  } catch (err) {
    console.error('fetchPublicRequests error', err);
    throw err;
  }
};

// Mechanics
export interface Mechanic {
  id: string;
  name: string;
  phone: string;
  location: string;
  rating: number;
  jobsCompleted: number;
  available: boolean;
  verified: boolean;
  joinedAt: string;
  isBanned: boolean;
  banReason: string | null;
}

export interface MechanicsParams {
  page?: number;
  pageSize?: number;
  verifiedOnly?: boolean;
  search?: string;
}

export const fetchMechanics = async (params: MechanicsParams) => {
  const resp = await authClient.get('/auth/admin/mechanics', {
    params: {
      page: params.page ?? 1,
      pageSize: params.pageSize ?? 10,
      ...(params.search ? { search: params.search } : {}),
      ...(params.verifiedOnly ? { verified: true } : {}),
    },
  });
  const raw = resp.data;
  const data: Mechanic[] = (raw.data ?? []).map((m: any) => ({
    id: String(m.id),
    name: m.name,
    phone: m.phone,
    location: m.location ?? '',
    rating: Number(m.rating ?? 0),
    jobsCompleted: Number(m.jobs_completed ?? m.jobsCompleted ?? 0),
    available: Boolean(m.is_available ?? m.available),
    verified: Boolean(m.is_verified ?? m.verified),
    joinedAt: m.created_at ?? new Date().toISOString(),
    isBanned: Boolean(m.is_banned),
    banReason: m.ban_reason ?? null,
  }));
  return {
    data,
    page: raw.page ?? 1,
    pageSize: raw.pageSize ?? 10,
    total: raw.total ?? data.length,
    totalPages: raw.totalPages ?? 1,
  } as PaginatedResponse<Mechanic>;
};

// Mechanic CRUD operations
// ─────────────────────── MECHANIC CRUD – FIXED FOR LIVE BACKEND ───────────────────────

export interface CreateMechanicData {
  full_name: string;
  phone: string;
  password?: string;
  location?: string;
  specialty?: string;
}

export interface UpdateMechanicData {
  name?: string;
  phone?: string;
  location?: string;
  is_verified?: boolean;
}

export const createMechanic = async (data: CreateMechanicData) => {
  const resp = await authClient.post('/auth/admin/create-provider', {
    full_name: data.full_name,
    phone: data.phone,
    location: data.location || '',
    specialty: data.specialty || 'General Repair',
    provider_type: 'mechanic',
  });
  return resp.data;
};

export const updateMechanic = async (id: string, data: UpdateMechanicData) => {
  const resp = await authClient.patch(`/auth/admin/mechanics/${id}`, data);
  return resp.data;
};

export const deleteMechanic = async (id: string, reason: string) => {
  const resp = await authClient.delete(`/auth/admin/mechanics/${id}`, { data: { reason } });
  return resp.data;
};

// Towing Providers
export interface TowingProvider {
  id: string;
  name: string;
  phone: string;
  location: string;
  verified: boolean;
  available: boolean;
  rating: number;
  jobsCompleted: number;
  spn: string | null;
  joinedAt: string;
  isBanned: boolean;
  banReason: string | null;
}

export const fetchTowingProviders = async (params: MechanicsParams) => {
  const resp = await authClient.get('/auth/admin/towing-providers', {
    params: {
      page: params.page ?? 1,
      pageSize: params.pageSize ?? 10,
      ...(params.search ? { search: params.search } : {}),
      ...(params.verifiedOnly ? { verified: true } : {}),
    },
  });
  const raw = resp.data;
  const data: TowingProvider[] = (raw.data ?? []).map((p: any) => ({
    id: String(p.id),
    name: p.name ?? p.full_name ?? '',
    phone: p.phone,
    location: p.location ?? '',
    verified: Boolean(p.is_verified),
    available: Boolean(p.is_available),
    rating: Number(p.rating ?? 0),
    jobsCompleted: Number(p.jobs_completed ?? p.jobsCompleted ?? 0),
    spn: p.spn ?? null,
    joinedAt: p.created_at ?? new Date().toISOString(),
    isBanned: Boolean(p.is_banned),
    banReason: p.ban_reason ?? null,
  }));
  return {
    data,
    page: raw.page ?? 1,
    pageSize: raw.pageSize ?? 10,
    total: raw.total ?? data.length,
    totalPages: raw.totalPages ?? 1,
  } as PaginatedResponse<TowingProvider>;
};

export const updateTowingProvider = async (id: string, data: Partial<{ name: string; phone: string; location: string; is_verified: boolean }>) => {
  const resp = await authClient.patch(`/auth/admin/towing-providers/${id}`, data);
  return resp.data;
};

export const deleteTowingProvider = async (id: string, reason: string) => {
  const resp = await authClient.delete(`/auth/admin/towing-providers/${id}`, { data: { reason } });
  return resp.data;
};

export const banProvider = async (id: string, providerType: 'mechanic' | 'towing_provider', reason: string): Promise<void> => {
  await authClient.post(`/auth/admin/ban-provider/${id}`, { provider_type: providerType, reason });
};

export const unbanProvider = async (id: string, providerType: 'mechanic' | 'towing_provider'): Promise<void> => {
  await authClient.post(`/auth/admin/unban-provider/${id}`, { provider_type: providerType, reason: '' });
};

// ── Cancellation suspension + platform fees (dispatch service) ─────────────────
export interface MechanicStrikeState {
  mechanic_id: number;
  strikes: number;
  suspended: boolean;
  suspended_at: string | null;
  suspension_count: number;
  limit: number;
}

// Lift a cancellation suspension after the mechanic has contacted support. Strikes
// reset but suspension_count is preserved so repeat offences can be escalated.
export const reinstateMechanic = async (mechanicId: string | number): Promise<{ suspension_count: number }> => {
  const resp = await requestsClient.post(`/mechanics/${mechanicId}/reinstate`);
  return resp.data;
};

export const fetchMechanicStrikes = async (mechanicId: string | number): Promise<MechanicStrikeState> => {
  const resp = await requestsClient.get(`/mechanics/${mechanicId}/strikes`);
  return resp.data;
};

export interface PlatformFeeState {
  mechanic_id: number;
  owed_count: number;
  owed_amount: number;
  fee_per_job: number;
  gate_jobs: number;
  gated: boolean;
  locked: boolean;
  jobs: { request_id: number; amount: number; created_at: string | null }[];
}

// A mechanic's outstanding platform-fee balance (MOTOFIX revenue).
export const fetchMechanicFees = async (mechanicId: string | number): Promise<PlatformFeeState> => {
  const resp = await requestsClient.get(`/fees/${mechanicId}`);
  return resp.data;
};

export interface ResetCredsResult {
  spn: string;
  temp_password: string;
  phone: string;
  message: string;
}

export const resetProviderCredentials = async (
  id: string,
  providerType: 'mechanic' | 'towing_provider',
): Promise<ResetCredsResult> => {
  const resp = await authClient.post(`/auth/admin/reset-provider-credentials/${id}`, {
    provider_type: providerType,
  });
  return resp.data;
};

// Live operational stats
export interface LiveStats {
  activeRequests: number;
  stuckRequests: number;
  requestsCreatedToday: number;
  completedRequestsCreatedToday: number;
  completionRateCreatedToday: number;
  towingOnline: number;
  mechanicsOnline: number;
  asOf: string;
}

export const fetchLiveStats = async (): Promise<LiveStats> => {
  const raw = await fetchWithAuth<any>('/admin/live-stats');
  return {
    activeRequests: raw.active_requests ?? 0,
    stuckRequests: raw.stuck_requests ?? 0,
    requestsCreatedToday: raw.requests_today ?? 0,
    completedRequestsCreatedToday: raw.completed_requests_created_today ?? 0,
    completionRateCreatedToday: raw.completion_rate_created_today ?? 0,
    towingOnline: raw.towing_online ?? 0,
    mechanicsOnline: raw.mechanics_online ?? 0,
    asOf: raw.as_of ?? new Date().toISOString(),
  };
};

export interface ProviderMapMarker {
  id: string;
  name: string;
  phone: string;
  location: string;
  isVerified: boolean;
  isAvailable?: boolean;
  latitude: number;
  longitude: number;
  type: 'mechanic' | 'towing';
}

export interface ActiveRequestPin {
  id: string;
  customerName: string;
  location: string;
  status: string;
  serviceType: string;
  createdAt: string;
}

export interface MapData {
  mechanics: ProviderMapMarker[];
  towingProviders: ProviderMapMarker[];
  activeRequests: ActiveRequestPin[];
}

export const fetchMapData = async (): Promise<MapData> => {
  const raw = await fetchWithAuth<any>('/admin/map-data');
  return {
    mechanics: (raw.mechanics ?? []).map((m: any): ProviderMapMarker => ({
      id: String(m.id),
      name: m.name ?? '',
      phone: m.phone ?? '',
      location: m.location ?? '',
      isVerified: Boolean(m.is_verified),
      latitude: Number(m.latitude),
      longitude: Number(m.longitude),
      type: 'mechanic',
    })),
    towingProviders: (raw.towing_providers ?? []).map((p: any): ProviderMapMarker => ({
      id: String(p.id),
      name: p.name ?? '',
      phone: p.phone ?? '',
      location: p.location ?? '',
      isVerified: Boolean(p.is_verified),
      isAvailable: Boolean(p.is_available),
      latitude: Number(p.latitude),
      longitude: Number(p.longitude),
      type: 'towing',
    })),
    activeRequests: (raw.active_requests ?? []).map((r: any): ActiveRequestPin => ({
      id: String(r.id),
      customerName: r.customer_name ?? '',
      location: r.location ?? '',
      status: r.status ?? 'pending',
      serviceType: r.service_type ?? '',
      createdAt: r.created_at ?? new Date().toISOString(),
    })),
  };
};

export const fetchRecentActivity = async (): Promise<ActiveRequestPin[]> => {
  const raw = await fetchWithAuth<any>('/admin/requests?limit=12');
  const arr = Array.isArray(raw) ? raw : (raw.data ?? []);
  return arr.slice(0, 12).map((r: any): ActiveRequestPin => ({
    id: String(r.id),
    customerName: r.customer_name ?? '',
    location: r.location ?? '',
    status: r.status ?? 'pending',
    serviceType: r.service_type ?? '',
    createdAt: r.created_at ?? new Date().toISOString(),
  }));
};

// Payments
export interface Payment {
  id: string;
  date: string;
  requestId: number;
  customerName: string;
  driverPhone: string;
  mechanicName: string;
  mechanicId: number;
  quotedAmount: number;
  commission: number;
  mechanicPayout: number;
  method: string;            // how they paid: 'mtn' | 'airtel' | 'cash' | 'momo'
  task: string;              // the service/task the payment was for
  collectionStatus: 'success' | 'pending' | 'failed' | 'initiated' | 'cash' | 'cancelled' | 'unknown';
  disbursementStatus: 'success' | 'pending' | 'failed' | 'initiated' | 'cancelled' | 'unknown';
}

export interface PaymentStats {
  totalCollected: number;
  totalTransactions: number;
  pendingCollections: number;
}

export interface PaymentsParams {
  page?: number;
  pageSize?: number;
  collectionStatus?: string;
  disbursementStatus?: string;
  search?: string;
}

export const fetchPayments = async (params: PaymentsParams) => {
  const searchParams = new URLSearchParams();
  if (params.page) searchParams.set('page', params.page.toString());
  if (params.pageSize) searchParams.set('page_size', params.pageSize.toString());
  if (params.collectionStatus && params.collectionStatus !== 'all')
    searchParams.set('collection_status', params.collectionStatus);
  if (params.disbursementStatus && params.disbursementStatus !== 'all')
    searchParams.set('disbursement_status', params.disbursementStatus);
  if (params.search) searchParams.set('search', params.search);

  const response = await fetchWithAuth<any>(`/admin/payments?${searchParams}`);

  const data: Payment[] = (response.data || []).map((p: any) => ({
    id: String(p.id),
    date: p.created_at || new Date().toISOString(),
    requestId: Number(p.request_id || 0),
    customerName: p.customer_name || '—',
    driverPhone: p.driver_phone || '—',
    mechanicName: p.mechanic_name || '—',
    mechanicId: Number(p.mechanic_id || 0),
    quotedAmount: Number(p.quoted_amount || 0),
    commission: Number(p.commission || 0),
    mechanicPayout: Number(p.mechanic_payout || 0),
    method: p.provider || '—',
    task: p.service_type || '—',
    collectionStatus: p.collection_status || 'pending',
    disbursementStatus: p.disbursement_status || 'pending',
  }));

  const pagination = response.pagination || {};
  return {
    data,
    total: pagination.total_items || 0,
    page: pagination.page || params.page || 1,
    pageSize: pagination.page_size || params.pageSize || 10,
    totalPages: pagination.total_pages || 1,
  } as PaginatedResponse<Payment>;
};

export const fetchPaymentStats = async (): Promise<PaymentStats> => {
  const stats = await fetchWithAuth<any>('/admin/stats');
  return {
    totalCollected:     stats.revenue_collected_ugx   ?? 0,
    totalTransactions:  stats.total_transactions       ?? 0,
    pendingCollections: stats.pending_collections_ugx  ?? 0,
  };
};

// Drivers
export interface Driver {
  id: string;
  phone: string;
  full_name: string | null;
  number_plate: string | null;
  vehicle_type: string | null;
  role: string;
  status: 'active' | 'suspended' | 'banned';
  status_reason: string | null;
  status_updated_at: string | null;
  created_at: string;
  request_count: number;
}

export interface DriverRequest {
  id: number;
  service_type: string;
  status: string;
  location: string;
  customer_name: string;
  mechanic_id: number | null;
  created_at: string;
  updated_at: string | null;
}

export interface DriverPaymentSummary {
  total_transactions: number;
  total_paid: number;
  pending_amount: number;
  last_transaction_at: string | null;
}

function mapDriver(u: any): Driver {
  return {
    id: String(u.id),
    phone: u.phone ?? '',
    full_name: u.full_name ?? null,
    number_plate: u.number_plate ?? null,
    vehicle_type: u.vehicle_type ?? null,
    role: u.role ?? 'driver',
    status: u.status ?? 'active',
    status_reason: u.status_reason ?? null,
    status_updated_at: u.status_updated_at ?? null,
    created_at: u.created_at ?? new Date().toISOString(),
    request_count: Number(u.request_count ?? 0),
  };
}

export const fetchDrivers = async (params: { search?: string } = {}): Promise<Driver[]> => {
  const resp = await authClient.get('/users/');
  let all: Driver[] = (resp.data as any[]).map(mapDriver);

  if (params.search) {
    const q = params.search.toLowerCase();
    all = all.filter(
      (d) =>
        (d.full_name ?? '').toLowerCase().includes(q) ||
        d.phone.toLowerCase().includes(q) ||
        (d.number_plate ?? '').toLowerCase().includes(q)
    );
  }

  return all;
};

export const fetchDriver = async (id: string): Promise<Driver> => {
  const resp = await authClient.get(`/users/${id}`);
  return mapDriver(resp.data);
};

export const updateDriverStatus = async (
  id: string,
  status: 'active' | 'suspended' | 'banned',
  reason?: string,
): Promise<void> => {
  await authClient.patch(`/users/${id}/status`, { status, reason });
};

export const fetchDriverRequests = async (id: string): Promise<DriverRequest[]> => {
  const resp = await requestsClient.get(`/admin/drivers/${id}/requests`);
  return Array.isArray(resp.data) ? resp.data : [];
};

export const fetchDriverPayments = async (id: string): Promise<DriverPaymentSummary> => {
  const resp = await requestsClient.get(`/admin/drivers/${id}/payments`);
  return resp.data;
};

// ── Admin profile ────────────────────────────────────────────────────────────

export interface PlatformFees {
  service_fee_pct: number;
  provider_cut_pct: number;
}

export const fetchPlatformFees = async (): Promise<PlatformFees> => {
  const resp = await authClient.get('/auth/admin/platform-fees');
  return resp.data;
};

export const updatePlatformFees = async (data: PlatformFees): Promise<{ message: string; notified: number }> => {
  const resp = await authClient.patch('/auth/admin/platform-fees', data);
  return resp.data;
};

export const setMaintenanceMode = async (data: {
  active: boolean;
  start_time?: string;
  end_time?: string;
  message?: string;
}): Promise<{ message: string; notified: number }> => {
  const resp = await authClient.post('/auth/admin/maintenance', data);
  return resp.data;
};

export const updateAdminProfile = async (data: { full_name: string; email: string }): Promise<AdminInfo> => {
  const resp = await authClient.patch('/auth/admin/profile', data);
  return resp.data;
};

export const changeAdminPassword = async (data: { current_password: string; new_password: string }): Promise<void> => {
  await authClient.post('/auth/admin/change-password', data);
};

export interface AdminRecord {
  id: number;
  full_name: string;
  email: string;
  role: string;
  created_at: string | null;
}

export const listAdmins = async (): Promise<AdminRecord[]> => {
  const resp = await authClient.get('/auth/admin/admins');
  return resp.data;
};

export const createAdmin = async (data: { full_name: string; email: string; password: string }): Promise<AdminRecord> => {
  const resp = await authClient.post('/auth/admin/register', data);
  return resp.data;
};

export const deleteAdmin = async (id: number): Promise<void> => {
  await authClient.delete(`/auth/admin/admins/${id}`);
};

// Auth
// Calls backend login endpoint, stores token, and returns token info
export const adminLogin = async (email: string, password: string): Promise<{ access_token: string; token_type: string }> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const response = await fetch(`/auth/login/admin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: controller.signal,
  });
  clearTimeout(timer);

  if (!response.ok) {
    throw new ApiError(response.status, 'Invalid credentials');
  }

  const data = await response.json();
  if (data?.access_token) {
    setAuthToken(data.access_token);
  }
  if (data?.admin) {
    setAdminInfo(data.admin);
  }
  return data;
};

// ── Provider Applications (admin verification panel) ────────────────────────

export interface ProviderApplication {
  id: string;
  full_name: string;
  phone: string;
  email: string;
  referral_name?: string;
  referral_phone?: string;
  provider_type: 'mechanic' | 'towing_provider';
  specializations: string;
  service_area: string;
  years_experience: string;
  business_name?: string;
  business_address?: string;
  business_reg_number?: string;
  garage_affiliation?: string;
  mobile_money_number: string;
  face_scan_url?: string;
  national_id_url?: string;
  certification_url?: string;
  profile_photo_url?: string;
  verification_status: 'pending' | 'approved' | 'rejected' | 'revoked';
  rejection_reason?: string;
  submitted_at: string;
  reviewed_at?: string;
}

function mapApplication(a: any): ProviderApplication {
  return {
    id: String(a.id),
    full_name: a.full_name ?? '',
    phone: a.phone ?? '',
    email: a.email ?? '',
    referral_name: a.referral_name,
    referral_phone: a.referral_phone,
    provider_type: a.provider_type ?? 'mechanic',
    specializations: a.specializations ?? '',
    service_area: a.service_area ?? '',
    years_experience: a.years_experience ?? '',
    business_name: a.business_name,
    business_address: a.business_address,
    business_reg_number: a.business_reg_number,
    garage_affiliation: a.garage_affiliation,
    mobile_money_number: a.mobile_money_number ?? '',
    face_scan_url: a.face_scan_url,
    national_id_url: a.national_id_url,
    certification_url: a.certification_url,
    profile_photo_url: a.profile_photo_url,
    verification_status: a.verification_status ?? 'pending',
    rejection_reason: a.rejection_reason,
    submitted_at: a.submitted_at ?? a.created_at ?? new Date().toISOString(),
    reviewed_at: a.reviewed_at,
  };
}

export const fetchProviderApplications = async (status?: string): Promise<ProviderApplication[]> => {
  const params = status && status !== 'all' ? { status } : {};
  const resp = await authClient.get('/providers/applications', { params });
  const raw = Array.isArray(resp.data) ? resp.data : (resp.data?.items ?? resp.data?.data ?? []);
  return raw.map(mapApplication);
};

export const fetchProviderApplication = async (id: string): Promise<ProviderApplication> => {
  const resp = await authClient.get(`/providers/applications/${id}`);
  return mapApplication(resp.data);
};

export const approveApplication = async (id: string): Promise<void> => {
  await authClient.post(`/providers/applications/${id}/approve`);
};

export const rejectApplication = async (id: string, reason: string): Promise<void> => {
  await authClient.post(`/providers/applications/${id}/reject`, { reason });
};

export const reopenApplication = async (id: string): Promise<void> => {
  await authClient.post(`/providers/applications/${id}/reopen`);
};

// ── Legacy single-document type (kept for backward compat) ───────────────────
export interface DocumentVerificationResult {
  is_genuine_document: boolean | null;
  document_type: string;
  confidence: number;
  extracted: {
    name: string | null;
    licence_number: string | null;
    date_of_birth: string | null;
    issue_date: string | null;
    expiry_date: string | null;
    vehicle_categories: string[];
    issuing_authority: string | null;
  };
  tampering_detected: boolean;
  tampering_indicators: string[];
  quality_issues: string[];
  name_matches: boolean | null;
  licence_number_matches: boolean | null;
  flags: string[];
  summary: string;
}

// ── Comprehensive multi-document verification result ─────────────────────────
export interface AppVerificationResult {
  national_id: {
    present: boolean;
    appears_genuine: boolean | null;
    quality: 'good' | 'poor' | 'unreadable';
    quality_issues: string[];
    tampering_detected: boolean;
    extracted: {
      name: string | null;
      id_number: string | null;
      date_of_birth: string | null;
      expiry_date: string | null;
      issuing_authority: string | null;
    };
  } | null;
  certification: {
    present: boolean;
    appears_genuine: boolean | null;
    quality: 'good' | 'poor' | 'unreadable';
    quality_issues: string[];
    extracted: {
      name: string | null;
      certification_type: string | null;
      issue_date: string | null;
      expiry_date: string | null;
      issuing_body: string | null;
    };
  } | null;
  profile_photo: {
    present: boolean;
    quality: 'good' | 'poor' | 'unreadable';
    quality_issues: string[];
    is_real_person: boolean | null;
  } | null;
  cross_checks: {
    all_names_consistent: boolean | null;
    name_matches_application: boolean | null;
    dob_consistent: boolean | null;
    discrepancies: string[];
  };
  overall: {
    recommendation: 'approve' | 'reject' | 'reupload_needed';
    rejection_reasons: string[];
    reupload_documents: string[];
    flags: string[];
    summary: string;
    id_expired: boolean;
    expiry_date: string | null;
    duplicate_id_detected: boolean;
    duplicate_app_id: number | null;
  };
}

export const verifyApplicationDocs = async (applicationId: string): Promise<AppVerificationResult> => {
  const resp = await authClient.post(`/providers/applications/${applicationId}/verify`);
  return resp.data;
};

export const requestDocumentReupload = async (
  applicationId: string,
  documents: string[],
  note?: string,
): Promise<void> => {
  await authClient.post(`/providers/applications/${applicationId}/request-reupload`, { documents, note });
};

export interface CreateProviderResult {
  id: number;
  name: string;
  phone: string;
  location: string;
  spn: string;
  temp_password: string;
  provider_type: string;
  message: string;
}

export const createProvider = async (data: {
  full_name: string;
  phone: string;
  location: string;
  provider_type: 'mechanic' | 'towing_provider';
  specialty?: string;
}): Promise<CreateProviderResult> => {
  const resp = await authClient.post('/auth/admin/create-provider', data);
  return resp.data;
};

// ── Activity Log ─────────────────────────────────────────────────────────────

export interface ActivityLogEntry {
  id: number;
  event_type: string;
  description: string;
  created_at: string;
  admin_name: string;
}

export interface ActivityLogResponse {
  data: ActivityLogEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// ── Admin Notification Feed ──────────────────────────────────────────────────

export interface AdminNotification {
  id: string;
  type: 'request' | 'payment' | 'provider' | 'driver' | 'system';
  title: string;
  body: string;
  detail: string;
  created_at: string;
}

export const fetchAdminNotifications = async (limit = 30): Promise<AdminNotification[]> => {
  try {
    // /admin/notifications is served by the analytics service (same base as the other
    // /admin/* calls) — must go through fetchWithAuth, NOT mechanicsClient.
    const data = await fetchWithAuth<AdminNotification[]>(`/admin/notifications?limit=${limit}`);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
};

// ── Spare-Parts Catalog (admin-curated overrides keyed by fault category) ─────

export interface CatalogPart {
  name: string;
  price_min: number;
  price_max: number;
}

export interface PartsCatalogEntry {
  fault_category: string;
  label: string;
  parts: CatalogPart[];
  service_fee_min: number | null;
  service_fee_max: number | null;
  notes: string | null;
  updated_at?: string | null;
}

export interface PartsCatalogUpsert {
  label: string;
  parts: CatalogPart[];
  service_fee_min: number | null;
  service_fee_max: number | null;
  notes: string | null;
}

export const fetchPartsCatalog = async (): Promise<PartsCatalogEntry[]> => {
  const resp = await authClient.get('/auth/admin/parts-catalog');
  return Array.isArray(resp.data) ? resp.data : [];
};

export const upsertPartsCatalog = async (
  faultCategory: string,
  data: PartsCatalogUpsert,
): Promise<PartsCatalogEntry> => {
  const resp = await authClient.put(`/auth/admin/parts-catalog/${faultCategory}`, data);
  return resp.data;
};

export const deletePartsCatalog = async (faultCategory: string): Promise<void> => {
  await authClient.delete(`/auth/admin/parts-catalog/${faultCategory}`);
};

// ── Spare-parts dealer directory (dispatch service) ──────────────────────────
export interface Dealer {
  id: number;
  name: string;
  phone: string;
  address: string;
  location: string;
  latitude: number | null;
  longitude: number | null;
  specialty: string;
  description: string;
  verified: boolean;
  active: boolean;
  created_at?: string | null;
  updated_at?: string | null;
  distance_km?: number | null;
}

export interface DealerInput {
  name: string;
  phone: string;
  address?: string;
  location?: string;
  latitude?: number | null;
  longitude?: number | null;
  specialty?: string;
  description?: string;
  verified?: boolean;
}

export const fetchDealers = async (): Promise<Dealer[]> => {
  const resp = await requestsClient.get('/dealers', { params: { limit: 200 } });
  return Array.isArray(resp.data?.dealers) ? resp.data.dealers : [];
};

export const createDealer = async (data: DealerInput): Promise<Dealer> => {
  const resp = await requestsClient.post('/dealers', data);
  return resp.data;
};

export const updateDealer = async (
  id: number,
  data: Partial<DealerInput> & { active?: boolean },
): Promise<Dealer> => {
  const resp = await requestsClient.put(`/dealers/${id}`, data);
  return resp.data;
};

export const deleteDealer = async (id: number): Promise<void> => {
  await requestsClient.delete(`/dealers/${id}`);
};

export const fetchActivityLog = async (params: {
  page?: number;
  pageSize?: number;
  event_type?: string;
  search?: string;
} = {}): Promise<ActivityLogResponse> => {
  const resp = await authClient.get('/auth/admin/activity-log', {
    params: {
      page: params.page ?? 1,
      pageSize: params.pageSize ?? 50,
      ...(params.event_type ? { event_type: params.event_type } : {}),
      ...(params.search ? { search: params.search } : {}),
    },
  });
  return resp.data;
};
