// config/legacy_api.ts — OLD version of the API setup, kept for reference only.
// The app now uses ./api.ts (which routes through the dev proxy and has the full set
// of services). Prefer api.ts for anything new; this file can be deleted once you've
// confirmed nothing still imports it.

import axios from "axios";
import { debugLog } from "@/utils/debug";

// Base URLs for microservices
export const AUTH_BASE_URL = import.meta.env.VITE_API_AUTH_URL ?? "";
export const REQUESTS_BASE_URL = import.meta.env.VITE_API_REQUESTS_URL || "https://motofix-service-requests.onrender.com";
export const PAYMENTS_BASE_URL = import.meta.env.VITE_API_PAYMENTS_URL || "https://motofix-payments-service.onrender.com";

// Add startup logging
debugLog("🚀 Initializing Motofix API:", {
  AUTH_BASE_URL,
  REQUESTS_BASE_URL,
  PAYMENTS_BASE_URL,
  timestamp: new Date().toISOString(),
});

// Create axios instances
export const authApi = axios.create({
  baseURL: AUTH_BASE_URL,
  headers: {
    "Content-Type": "application/json",
  },
  withCredentials: true, // send/receive httpOnly cookies from the API
  timeout: 30000, // 30s for slow networks
});

export const requestsApi = axios.create({
  baseURL: REQUESTS_BASE_URL,
  headers: {
    "Content-Type": "application/json",
  },
  withCredentials: true,
  timeout: 120000, // 2 min for media uploads
});

export const paymentsApi = axios.create({
  baseURL: PAYMENTS_BASE_URL,
  headers: {
    "Content-Type": "application/json",
  },
  withCredentials: true,
  timeout: 30000,
});

// JWT interceptor for authenticated requests
const addAuthInterceptor = (instance: ReturnType<typeof axios.create>) => {
  instance.interceptors.request.use(
    (config) => {
      const token = localStorage.getItem("motofix_token");
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
      // FormData: let browser set Content-Type with boundary (do not send application/json)
      if (typeof FormData !== "undefined" && config.data instanceof FormData) {
        delete config.headers["Content-Type"];
      }
      debugLog(`📤 ${config.method?.toUpperCase()} ${config.url}`, {
        hasToken: !!token,
      });
      return config;
    },
    (error) => {
      console.error("❌ Request interceptor error:", error);
      return Promise.reject(error);
    },
  );

  instance.interceptors.response.use(
    (response) => {
      debugLog(`📥 Response from ${response.config.url}:`, response.status);
      return response;
    },
    (error) => {
      console.error("❌ Response error:", {
        status: error.response?.status,
        statusText: error.response?.statusText,
        url: error.config?.url,
        fullUrl: `${error.config?.baseURL || ""}${error.config?.url || ""}`,
        method: error.config?.method,
        data: error.response?.data,
        rawResponse: error.response,
        message: error.message,
      });

      return Promise.reject(error);
    },
  );
};

addAuthInterceptor(authApi);
addAuthInterceptor(requestsApi);
addAuthInterceptor(paymentsApi);

// Auth API functions
export const authService = {
  sendOtp: (phone: string, fullName?: string, numberPlate?: string) =>
    authApi.post("/auth/register/driver", {
      phone,
      ...(fullName ? { full_name: fullName } : {}),
      ...(numberPlate ? { number_plate: numberPlate.trim().toUpperCase() } : {}),
    }),

  login: (phone: string, otp: string, fullName?: string) =>
    authApi.post("/auth/verify-otp", {
      phone,
      otp_code: otp,
      ...(fullName ? { full_name: fullName } : {}),
    }),

  resendOtp: (phone: string) => authApi.post("/auth/resend-otp", { phone }),

  logout: () => authApi.post("/auth/logout"),

  getMe: () => authApi.get("/auth/me"),

  updateProfile: (data: { full_name?: string; number_plate?: string }) => authApi.patch("/users/me", data),
};

// Requests API functions
export const requestsService = {
  create: (data: { customer_name: string; service_type: string; location: string; description: string }) => requestsApi.post("/requests/", data),

  createWithMedia: (formData: FormData) => {
    return requestsApi.post("/requests-with-media/", formData);
  },

  getAll: () => requestsApi.get("/requests/"),

  getById: (id: string) => requestsApi.get(`/requests/${id}`),

  updateStatus: (id: string, status: string) => requestsApi.patch(`/requests/${id}/status`, { status }),

  getCallPartner: (id: string) => requestsApi.get<{ phone: string }>(`/requests/${id}/call-partner`),

  // Feature flags are DB-backed and vary by deployment via `SERVICE_VARIANT`
  getFeatureFlags: () => requestsApi.get("/feature-flags"),
};

// Payment API functions — routed to motofix-payments-service
export const paymentsService = {
  getQuote: (requestId: string) => paymentsApi.get(`/payments/quote/${requestId}`),

  approveQuote: (requestId: string) => paymentsApi.post(`/payments/approve/${requestId}`),

  collect: (requestId: string, driverPhone: string) => paymentsApi.post(`/payments/collect/${requestId}`, { phone: driverPhone }),

  getStatus: (requestId: string) => paymentsApi.get(`/payments/status/${requestId}`),
};
