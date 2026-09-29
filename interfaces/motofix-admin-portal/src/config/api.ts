/**
 * API Configuration
 * Centralized config for all backend API base URLs
 */

// Use environment variables, fallback to production URLs or same-origin proxy
const ADMIN_API_URL = import.meta.env.VITE_API_ADMIN_URL || '';

if (import.meta.env.PROD && !ADMIN_API_URL) {
  throw new Error('Production build requires VITE_API_ADMIN_URL to be set for the admin portal.');
}

export const API_CONFIG = {
  // Admin Dashboard API (for stats, mechanics, payments, requests)
  ADMIN_API_URL: ADMIN_API_URL || 'https://motofix-admin-dashboard.onrender.com',

  // Service Requests Microservice
  REQUESTS_API_URL:
    import.meta.env.VITE_API_REQUESTS_URL ||
    '/req-svc',

  // Mechanics Service — empty string routes through Vite proxy (/auth → localhost:8000)
  MECHANICS_API_URL:
    import.meta.env.VITE_API_MECHANICS_URL ?? '',

  // Auth Service — empty string routes through Vite proxy (/auth, /users, /providers)
  AUTH_API_URL:
    import.meta.env.VITE_API_AUTH_URL ?? '',

  // Notifications Service
  NOTIFICATIONS_API_URL:
    import.meta.env.VITE_API_NOTIFICATIONS_URL ||
    'https://motofix-notifications-service.onrender.com',
};

/**
 * Format currency in UGX with nice formatting
 * Examples:
 * - 45600000 -> "UGX 45.6M"
 * - 12500 -> "UGX 12.5K"
 * - 350 -> "UGX 350"
 */
export const formatUGX = (amount?: number | null): string => {
  // Guard against undefined/null/NaN stats so a missing value can never crash a
  // render (an unguarded amount.toLocaleString() white-screened the dashboard).
  const n = typeof amount === 'number' && isFinite(amount) ? amount : 0;
  if (n >= 1000000) {
    return `UGX ${(n / 1000000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `UGX ${(n / 1000).toFixed(1)}K`;
  }
  return `UGX ${n.toLocaleString()}`;
};

/**
 * Format date in short format (e.g., "Jan 23")
 */
export const formatDateShort = (dateString: string): string => {
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return dateString;
  }
};
