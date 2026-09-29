// config/api.ts — the single place that talks to the backend.
//
// Every network call the driver app makes goes through here. The layout:
//   1. Base URLs — one per backend microservice (auth, requests, payments, etc).
//      An empty string means "use the Vite dev proxy" during local development.
//   2. axios instances — one pre-configured HTTP client per service (authApi,
//      requestsApi, ...), each with its own timeout and cookie settings.
//   3. addAuthInterceptor — automatically attaches the logged-in user's token to
//      every request, and logs requests/responses to the console for debugging.
//   4. Service objects (authService, requestsService, diagnosisService, ...) — the
//      friendly functions the rest of the app actually calls, e.g.
//      `requestsService.getAll()`. Pages should import THESE, not raw axios.
//   5. TypeScript interfaces — the exact shape of the data each endpoint returns,
//      kept in sync with the backend's Pydantic schemas.
//
// So when a page needs data: call a service function here → it hits the right
// microservice → the token is added automatically → you get typed data back.

import axios from 'axios';
import { noteServerDate } from '@/utils/serverClock';

// Base URLs for microservices — empty string routes through the Vite dev proxy
export const AUTH_BASE_URL      = import.meta.env.VITE_API_AUTH_URL      ?? '';
export const REQUESTS_BASE_URL  = import.meta.env.VITE_API_REQUESTS_URL  ?? '';
export const PAYMENTS_BASE_URL  = import.meta.env.VITE_API_PAYMENTS_URL  ?? '';
export const DIAGNOSIS_BASE_URL = import.meta.env.VITE_API_DIAGNOSIS_URL ?? '';
export const MATCHING_BASE_URL  = import.meta.env.VITE_API_MATCHING_URL  ?? '';
export const INSURANCE_BASE_URL = import.meta.env.VITE_API_INSURANCE_URL ?? '';

// Add startup logging
console.log('🚀 Initializing Motofix API:', {
  AUTH_BASE_URL,
  REQUESTS_BASE_URL,
  PAYMENTS_BASE_URL,
  DIAGNOSIS_BASE_URL,
  timestamp: new Date().toISOString(),
});

// Create axios instances
export const authApi = axios.create({
  baseURL: AUTH_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true, // send/receive httpOnly cookies from the API
  timeout: 30000, // 30s for slow networks
});

export const requestsApi = axios.create({
  baseURL: REQUESTS_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true,
  timeout: 120000, // 2 min for media uploads
});

export const paymentsApi = axios.create({
  baseURL: PAYMENTS_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
  timeout: 30000,
});

export const diagnosisApi = axios.create({
  baseURL: DIAGNOSIS_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: 30000,
});

export const matchingApi = axios.create({
  baseURL: MATCHING_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: 20000,
});

export const insuranceApi = axios.create({
  baseURL: INSURANCE_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: 60000, // 60s — photos can make payloads large
});

// Attaches the login token to outgoing requests so we don't have to add it by hand
// every time. An "interceptor" is a hook axios runs on every request/response — here
// we use it to (a) add the saved token, (b) fix the Content-Type for file uploads,
// and (c) log what's being sent/received. Applied to every API instance below.
const addAuthInterceptor = (instance: ReturnType<typeof axios.create>) => {
  instance.interceptors.request.use(
    (config) => {
      // Pull the saved login token (set at login) and send it as a Bearer token,
      // which is how the backend knows who is making the request.
      const token = localStorage.getItem('motofix_token');
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
      // FormData: let browser set Content-Type with boundary (do not send application/json)
      if (typeof FormData !== 'undefined' && config.data instanceof FormData) {
        delete config.headers['Content-Type'];
      }
      console.log(`📤 ${config.method?.toUpperCase()} ${config.url}`, {
        hasToken: !!token,
        headers: config.headers,
      });
      return config;
    },
    (error) => {
      console.error('❌ Request interceptor error:', error);
      return Promise.reject(error);
    }
  );

  instance.interceptors.response.use(
    (response) => {
      // Keep the device's clock in step with the server (for the journey sim).
      noteServerDate(response.headers?.['date']);
      console.log(`📥 Response from ${response.config.url}:`, response.status, response.data);
      return response;
    },
    (error) => {
      console.error('❌ Response error:', {
        status: error.response?.status,
        statusText: error.response?.statusText,
        url: error.config?.url,
        fullUrl: `${error.config?.baseURL || ''}${error.config?.url || ''}`,
        method: error.config?.method,
        data: error.response?.data,
        rawResponse: error.response,
        message: error.message,
      });
      
      return Promise.reject(error);
    }
  );
};

addAuthInterceptor(authApi);
addAuthInterceptor(requestsApi);
addAuthInterceptor(paymentsApi);
addAuthInterceptor(diagnosisApi);
addAuthInterceptor(matchingApi);
addAuthInterceptor(insuranceApi);

// Auth API functions
export const authService = {
  sendOtp: (phone: string, fullName?: string, numberPlate?: string) =>
    authApi.post('/auth/register/driver', {
      phone,
      ...(fullName    ? { full_name:    fullName }                         : {}),
      ...(numberPlate ? { number_plate: numberPlate.trim().toUpperCase() } : {}),
    }),

  login: (phone: string, otp: string) =>
    authApi.post('/auth/verify-otp', {
      phone,
      otp_code: otp,
    }),

  resendOtp: (phone: string) =>
    authApi.post('/auth/resend-otp', { phone }),

  logout: () => authApi.post('/auth/logout'),

  getMe: () => authApi.get('/auth/me'),

  updateProfile: (data: { full_name?: string; number_plate?: string; national_id_number?: string }) =>
    authApi.patch('/users/me', data),

  getPreferences: () => authApi.get('/users/me/preferences'),
  savePreferences: (preferences: Record<string, unknown>) =>
    authApi.patch('/users/me/preferences', { preferences }),

  /**
   * Submit a licence/permit image for AI authenticity verification.
   * Returns a structured result — does NOT block registration.
   */
  verifyDocument: (
    file: File,
    expectedName?: string,
    expectedLicenceNumber?: string,
  ) => {
    const form = new FormData();
    form.append('file', file);
    if (expectedName)          form.append('expected_name', expectedName);
    if (expectedLicenceNumber) form.append('expected_licence_number', expectedLicenceNumber);
    return authApi.post<DocVerificationResult>('/auth/verify-document', form);
  },
};

export interface DocVerificationResult {
  is_genuine_document: boolean | null;
  document_type: string;
  confidence: number;
  extracted: {
    name?: string | null;
    licence_number?: string | null;
    date_of_birth?: string | null;
    issue_date?: string | null;
    expiry_date?: string | null;
    vehicle_categories?: string[];
    issuing_authority?: string | null;
  };
  tampering_detected: boolean;
  tampering_indicators: string[];
  quality_issues: string[];
  name_matches: boolean | null;
  licence_number_matches: boolean | null;
  flags: string[];
  summary: string;
}

// Requests API functions
export const requestsService = {
  create: (data: {
    customer_name: string;
    service_type: string;
    location: string;
    description: string;
    preferred_mechanic_id?: number;
  }) => requestsApi.post('/requests/', data),
  
  createWithMedia: (formData: FormData) => {
    return requestsApi.post('/requests-with-media/', formData);
  },
  
  getAll: () => requestsApi.get('/requests/'),
  
  getById: (id: string) => requestsApi.get(`/requests/${id}`),
  
  updateStatus: (id: string, status: string, cancelReason?: string) =>
    requestsApi.patch(`/requests/${id}/status`, null, {
      params: { status, ...(cancelReason ? { cancel_reason: cancelReason } : {}) },
    }),
  
  getCallPartner: (id: string) =>
    requestsApi.get<{ phone: string }>(`/requests/${id}/call-partner`),

  // Feature flags are DB-backed and vary by deployment via `SERVICE_VARIANT`
  getFeatureFlags: () => requestsApi.get('/feature-flags'),

  redispatch: (id: string) =>
    requestsApi.post(`/requests/${id}/redispatch`),

  submitReview: (requestId: string, data: { rating: number; comment?: string }) =>
    requestsApi.post(`/requests/${requestId}/review`, data),

  getReview: (requestId: string, direction = 'driver_to_mechanic') =>
    requestsApi.get(`/requests/${requestId}/review`, { params: { direction } }),
};

// ── In-job chat (persisted, two-way) ─────────────────────────────────────────
export interface JobChatMessage {
  id: number;
  request_id: number;
  sender_role: 'driver' | 'mechanic';
  sender_id: string;
  body: string;
  media_type: 'none' | 'voice' | 'image';
  media_url: string | null;
  seen_by_driver?: boolean;
  seen_by_mechanic?: boolean;
  created_at: string;
}

export const chatService = {
  list: (requestId: string, role: 'driver' | 'mechanic', markSeen = true) =>
    requestsApi.get<{ request_id: number; messages: JobChatMessage[] }>(
      `/requests/${requestId}/messages`,
      { params: { role, mark_seen: markSeen } },
    ),

  unread: (requestId: string, role: 'driver' | 'mechanic') =>
    requestsApi.get<{ unread: number }>(
      `/requests/${requestId}/messages/unread`, { params: { role } },
    ),

  markSeen: (requestId: string, role: 'driver' | 'mechanic') =>
    requestsApi.post(`/requests/${requestId}/messages/seen`, { role }),

  sendText: (requestId: string, data: { sender_role: 'driver' | 'mechanic'; sender_id: string; body: string }) =>
    requestsApi.post<JobChatMessage>(`/requests/${requestId}/messages`, data),

  sendMedia: (requestId: string, form: FormData) =>
    requestsApi.post<JobChatMessage>(`/requests/${requestId}/messages/media`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
};

// Diagnosis / AI chatbot service
export interface ChatMessage { role: 'user' | 'assistant'; content: string; }
export interface PartEstimate { name: string; price_min: number; price_max: number; }
export interface DiagnosisResult {
  fault_category: string;
  fault_description: string;
  provider_type: 'mechanic' | 'towing_provider' | 'spare_parts_dealer' | 'ambulance';
  severity: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  recommended_actions: string[];
  follow_up_questions?: string[];
  required_parts?: PartEstimate[];
  service_fee_min?: number | null;
  service_fee_max?: number | null;
  repair_fee_min?: number | null;
  repair_fee_max?: number | null;
  image_relevant?: boolean | null;
  image_feedback?: string | null;
  repair_or_replace?: 'repair' | 'replace' | 'inspect' | null;
  repair_or_replace_reason?: string | null;
  needs_better_photo?: boolean | null;
}
export interface ChatResponse { reply: string; diagnosis_ready: boolean; diagnosis?: DiagnosisResult; }

export interface GuidedAnswer { question: string; answer: string; }
export type GuidedResult =
  | { done: false; question: string; options: string[] }
  | { done: true; diagnosis: DiagnosisResult };

export const diagnosisService = {
  chat: (messages: ChatMessage[]) =>
    diagnosisApi.post<ChatResponse>('/chat', { messages }),

  /** Voice note → text (any language → English) via Groq Whisper. */
  transcribe: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return diagnosisApi.post<{ text: string }>('/transcribe', fd);
  },

  diagnoseText: (description: string) =>
    diagnosisApi.post<DiagnosisResult>('/diagnose', { description }),

  /** Rotating, AI-generated home-screen headlines (with built-in fallback). */
  greeting: (period: string): Promise<string[]> =>
    diagnosisApi.get<{ messages?: string[] }>('/greetings', { params: { role: 'driver', period } })
      .then(r => r.data?.messages ?? [])
      .catch(() => []),

  /** Step-by-step guided triage — returns the next question or a final diagnosis */
  guidedDiagnose: (answers: GuidedAnswer[]) =>
    diagnosisApi.post<GuidedResult>('/diagnose/guided', { answers }),

  /** Legacy direct-diagnosis endpoint — kept for non-chat use cases */
  diagnoseImage: (file: File, issue?: string) => {
    const fd = new FormData();
    fd.append('file', file);
    if (issue) fd.append('issue', issue);
    return diagnosisApi.post<DiagnosisResult>('/diagnose/image', fd);
  },

  /**
   * Image-aware chat turn. Vision model reads the photo, chatbot describes
   * what it sees and asks follow-up questions. Returns ChatResponse so it
   * slots into the normal chat flow.
   */
  chatWithImage: (file: File, priorMessages: ChatMessage[], userText = '') => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('messages', JSON.stringify(priorMessages));
    fd.append('user_text', userText);
    return diagnosisApi.post<ChatResponse>('/chat/image', fd);
  },
};

// ── Spare-parts catalog + self-fix orders ───────────────────────────────────
export interface CatalogPart { name: string; price_min: number; price_max: number; }
export interface PartsCatalogEntry {
  fault_category: string;
  label: string;
  parts: CatalogPart[];
  service_fee_min: number | null;
  service_fee_max: number | null;
  notes: string | null;
}
export interface PartsOrderPart { name: string; price_min: number; price_max: number; qty: number; }
export interface PartsOrder {
  id: number;
  fault_category: string | null;
  fault_label: string | null;
  parts: PartsOrderPart[];
  dealer_name: string | null;
  dealer_phone: string | null;
  dealer_place_id: string | null;
  estimated_total_min: number | null;
  estimated_total_max: number | null;
  status: string;
  created_at: string;
}
export interface PartsOrderCreate {
  fault_category?: string | null;
  fault_label?: string | null;
  parts: PartsOrderPart[];
  dealer_name?: string | null;
  dealer_phone?: string | null;
  dealer_place_id?: string | null;
  estimated_total_min?: number | null;
  estimated_total_max?: number | null;
}

export const partsService = {
  /** Admin-curated override for a fault category. Rejects with 404 when none — caller falls back to the AI estimate. */
  getCatalog: (faultCategory: string) =>
    authApi.get<PartsCatalogEntry>(`/auth/parts-catalog/${faultCategory}`),
  createOrder: (data: PartsOrderCreate) =>
    authApi.post<PartsOrder>('/auth/me/parts-orders', data),
  listOrders: () =>
    authApi.get<PartsOrder[]>('/auth/me/parts-orders'),
};

// ── MOTOBOT — AI spare-parts pricing assistant ───────────────────────────────
export interface PartPriceItem { name: string; price_min: number; price_max: number; new_min?: number; new_max?: number; used_min?: number; used_max?: number; note?: string | null }
export interface PartPriceResult { items: PartPriceItem[]; currency: string }

export interface RawDealer {
  place_id: string;
  name: string;
  vicinity: string;
  lat: number;
  lng: number;
  distance_km: number;
  phone: string | null;
  category: string;
  rating?: number | null;
  reviews?: number | null;
  hours?: string | null;
  photo?: string | null;
}
export interface DealersResult { dealers: RawDealer[]; source: 'osm' | 'fallback' }

export const motobotService = {
  /** Ask MOTOBOT (AI) for UGX price ranges for the parts the driver wants to buy. */
  priceItems: (items: string[]) =>
    diagnosisApi.post<PartPriceResult>('/parts-price', { items }),
  /** Real spare-parts dealers near the driver (OSM), Makerere-area fallback. */
  findDealers: (lat: number, lng: number) =>
    diagnosisApi.post<DealersResult>('/parts-dealers', { lat, lng }),
};

// Admin-managed spare-parts dealer directory (dispatch service). These are the
// businesses an admin registered — shown first in the driver app, with the
// branded sim dealers used only as a fallback when none are nearby.
export interface DirectoryDealer {
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
  distance_km: number | null;
}

export const dealerService = {
  searchNearby: (lat: number, lng: number, radiusKm = 30) =>
    requestsApi.get<{ total: number; dealers: DirectoryDealer[] }>('/dealers/search', {
      params: { lat, lon: lng, radius_km: radiusKm },
    }),
};

// Matching service — find nearby mechanics
export interface MechanicCandidate {
  mechanic_id: number;
  mechanic_name: string;
  phone?: string;
  distance_km: number;
  total_score: number;            // 0–100 match priority (== match_priority)
  match_priority?: number;        // 0–100 headline match priority %
  rationale?: string;             // one-line "why this mechanic" explanation
  capability_tier?: number | null;
  score_breakdown: Record<string, number>;  // spec_match | availability | proximity | rating (0–100)
  weights?: Record<string, number>;
}
export interface MatchResponse { request_id?: number; candidates: MechanicCandidate[]; total_eligible: number; }

export const matchingService = {
  findNearby: (lat: number, lng: number, serviceType: string, topN = 10) =>
    matchingApi.post<MatchResponse>('/match', {
      latitude: lat,
      longitude: lng,
      service_type: serviceType,
      top_n: topN,
    }),
};

// Insurance API types & service
export interface ClaimPhoto { slot: string; preview: string; }
export interface ClaimCreate {
  type: string;
  type_label: string;
  incident_date: string;   // YYYY-MM-DD
  incident_time: string;   // HH:MM
  location: string;
  description: string;
  injuries: boolean | null;
  third_party: boolean | null;
  insurer_id?: string | null;
  insurer_name?: string | null;
  photos: ClaimPhoto[];
}
export interface ClaimPhotoOut { id: number; slot: string; file_path: string; created_at: string; }
export interface ClaimRecord {
  id: number;
  reference: string;
  user_id: number;
  claim_type: string;
  claim_type_label: string;
  incident_date: string;
  incident_time: string;
  location: string;
  description: string;
  injuries: boolean | null;
  third_party: boolean | null;
  status: 'pending' | 'under_review' | 'approved' | 'rejected' | 'settled';
  created_at: string;
  updated_at: string;
  photos: ClaimPhotoOut[];
}

// Insurer catalog + applications (apply for cover)
export interface Insurer { id: string; name: string; short: string; tagline: string; }
export interface CoverType { id: string; label: string; blurb: string; }
export interface InsurerCatalog { insurers: Insurer[]; cover_types: CoverType[]; }
export interface ApplicationCreate {
  insurer_id: string;
  insurer_name: string;
  cover_type: string;
  cover_label: string;
  vehicle_reg: string;
  vehicle_make?: string;
  vehicle_model?: string;
  vehicle_year?: string;
  period?: string;
  notes?: string;
}
export interface ApplicationRecord {
  id: number;
  reference: string;
  user_id: number;
  insurer_id: string;
  insurer_name: string;
  cover_type: string;
  cover_label: string;
  vehicle_reg: string;
  vehicle_make: string;
  vehicle_model: string;
  vehicle_year: string;
  period: string;
  status: 'pending' | 'under_review' | 'active' | 'rejected' | 'expired' | 'cancelled';
  created_at: string;
  updated_at: string;
}

export const insuranceService = {
  submit: (data: ClaimCreate) =>
    insuranceApi.post<ClaimRecord>('/claims', data),

  list: () =>
    insuranceApi.get<ClaimRecord[]>('/claims'),

  get: (reference: string) =>
    insuranceApi.get<ClaimRecord>(`/claims/${reference}`),

  // Insurer catalog + applications
  insurers: () =>
    insuranceApi.get<InsurerCatalog>('/insurers'),

  apply: (data: ApplicationCreate) =>
    insuranceApi.post<ApplicationRecord>('/applications', data),

  applications: () =>
    insuranceApi.get<ApplicationRecord[]>('/applications'),
};

// A single customer review shown on the mechanic's public profile
export interface MechanicReview {
  rating: number;
  comment: string;
  created_at: string | null;
  reviewer_name: string;
  service_type: string | null;
}

// Mechanic public profile (no auth required — safe public fields only)
export interface MechanicPublicProfile {
  id: number;
  full_name: string;
  specialty: string | null;
  provider_type: string | null;
  rating: number;
  total_ratings: number;
  jobs_completed: number;
  profile_photo_url: string | null;
  garage_name: string | null;
  reviews?: MechanicReview[];
}

export const mechanicService = {
  getPublicProfile: (mechanicId: number | string) =>
    authApi.get<MechanicPublicProfile>(`/auth/providers/${mechanicId}/public`),
};

// ── Fuel Advisor ─────────────────────────────────────────────────────────────
export interface FuelAnalysis {
  compatible: boolean;
  caution: boolean;
  engine_type: string;
  analysis: string;
  price_estimates: {
    regular_petrol: string;
    super_petrol: string;
    diesel: string;
    kerosene: string;
  };
  warning: string | null;
  recommendation: string;
}

export interface NearbyStation {
  place_id: string;
  name: string;
  brand?: string;
  vicinity: string;
  lat: number;
  lng: number;
  rating?: number;
  user_ratings_total?: number;
  open_now?: boolean;
  opening_hours?: string;
  distance_km: number;
  maps_url: string;
  directions_url: string;
}

export const fuelAdvisorService = {
  analyze: (car_model: string, fuel_type: string) =>
    diagnosisApi.post<FuelAnalysis>('/fuel-advisor', { car_model, fuel_type }),

  // Overpass widens the radius server-side; keep a tight client cap so the UI stays snappy
  nearbyStations: (lat: number, lng: number) =>
    diagnosisApi.post<{ stations: NearbyStation[] }>('/fuel-advisor/stations', { lat, lng }, { timeout: 25000 }),
};

// Payment API functions — routed to motofix-payments-service
export const paymentsService = {
  getQuote: (requestId: string) =>
    paymentsApi.get(`/payments/quote/${requestId}`),

  approveQuote: (requestId: string) =>
    paymentsApi.post(`/payments/approve/${requestId}`),

  collect: (requestId: string, driverPhone: string) =>
    paymentsApi.post(`/payments/collect/${requestId}`, { phone: driverPhone }),

  payCash: (requestId: string) =>
    paymentsApi.post(`/payments/cash/${requestId}`),

  getStatus: (requestId: string) =>
    paymentsApi.get(`/payments/status/${requestId}`),
};
