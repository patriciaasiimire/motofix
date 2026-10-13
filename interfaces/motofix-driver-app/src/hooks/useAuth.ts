// useAuth.ts — the hook every screen uses to know "is someone logged in, and who?".
//
// It exposes: user, isAuthenticated, isLoading, and login()/logout() functions.
// How login persists: on success we save the token + user in the browser
// (localStorage) so the user stays logged in across refreshes. On startup it shows
// the cached user instantly (no flicker) then quietly re-checks with the server via
// /auth/me without ending the local session on verification failures. Login/logout
// fire a 'motofix:auth-changed' event
// so other parts of the app (requests, websocket) can react.

import { createContext, createElement, useContext, useState, useEffect, useCallback, useRef } from 'react';
import type { ReactNode } from 'react';
import axios from 'axios';
import { authService } from '@/config/api';
import { debugLog } from '@/utils/debug';

const STORAGE_SETTINGS_KEY = 'motofix_settings';

function mergeServerPreferences(serverPrefs: Record<string, unknown>) {
  try {
    const local = JSON.parse(localStorage.getItem(STORAGE_SETTINGS_KEY) ?? '{}');
    localStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify({ ...local, ...serverPrefs }));
  } catch { /* ignore */ }
}
interface User {
  id?: string;
  phone: string;
  full_name?: string;
  role: string;
  number_plate?: string;
}

const STORAGE_TOKEN_KEY = 'motofix_token';
const STORAGE_USER_KEY = 'motofix_user';
const STORAGE_LAST_AUTH_CHECK = 'motofix_last_auth_check';

const getStoredUser = (): User | null => {
  const storedUser = localStorage.getItem(STORAGE_USER_KEY);
  if (!storedUser) return null;

  try {
    return JSON.parse(storedUser);
  } catch (e) {
    console.error('❌ Failed to parse stored user', e);
    localStorage.removeItem(STORAGE_USER_KEY);
    return null;
  }
};

/**
 * Custom hook for managing authentication state
 * Provides robust persistent login using localStorage + httpOnly cookies
 * Auto-checks auth on app load via /auth/me endpoint
 */
function useAuthState() {
  const [user, setUser] = useState<User | null>(() => getStoredUser());
  const [isLoading, setIsLoading] = useState(() => {
    return !localStorage.getItem(STORAGE_TOKEN_KEY);
  });
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    return !!localStorage.getItem(STORAGE_TOKEN_KEY);
  });
  const authCheckInProgressRef = useRef(false);

  /**
   * Verify token with server by calling /auth/me
   * This ensures token is valid and gets fresh user data
   * Includes retry logic for network failures
   */
  const checkAuth = useCallback(async (retryCount = 0, maxRetries = 2) => {
    // Prevent concurrent auth checks
    if (authCheckInProgressRef.current) {
      debugLog('⏳ Auth check already in progress, skipping...');
      return;
    }

    try {
      authCheckInProgressRef.current = true;
      
      // Check if token exists in localStorage
      const token = localStorage.getItem(STORAGE_TOKEN_KEY);
      debugLog('🔍 checkAuth: token exists?', !!token);
      
      if (!token) {
        debugLog('❌ No token found - not authenticated');
        setIsAuthenticated(false);
        setUser(null);
        setIsLoading(false);
        return;
      }

      debugLog('✅ Token found, verifying with /auth/me...');
      try {
        // Call /auth/me to verify token and get fresh user data
        const response = await authService.getMe();
        const userData = response.data;
        
        debugLog('✅ Auth verification succeeded');
        setUser(userData);
        setIsAuthenticated(true);
        // Update localStorage with fresh user data
        localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(userData));
        localStorage.setItem(STORAGE_LAST_AUTH_CHECK, Date.now().toString());
      } catch (error: unknown) {
        // If network error and retries available, retry
        if (
          axios.isAxiosError(error) &&
          (error.code === 'ECONNABORTED' || error.message === 'Network Error') &&
          retryCount < maxRetries
        ) {
          debugLog(`⚠️ Network error, retrying... (${retryCount + 1}/${maxRetries})`);
          // Wait 2 seconds before retrying
          await new Promise(resolve => setTimeout(resolve, 2000));
          authCheckInProgressRef.current = false;
          return checkAuth(retryCount + 1, maxRetries);
        }
        throw error;
      }
    } catch (error: unknown) {
      console.error(
        '❌ Auth check failed:',
        axios.isAxiosError(error) ? error.response?.status : undefined,
        error instanceof Error ? error.message : String(error),
      );
      
      // Verification failures never end the local session; only explicit logout
      // or clearing browser storage removes the saved credentials.
      debugLog(
        '⚠️ Auth check failed but keeping cached session:',
        error instanceof Error ? error.message : String(error),
      );
      const storedUser = localStorage.getItem(STORAGE_USER_KEY);
      if (storedUser) {
        try {
          setUser(JSON.parse(storedUser));
          setIsAuthenticated(true);
          debugLog('✅ Using cached user session');
        } catch (e) {
          console.error('Failed to parse cached user', e);
        }
      }
    } finally {
      setIsLoading(false);
      authCheckInProgressRef.current = false;
    }
  }, []);

  /**
   * On mount: check for existing token and verify with server
   * This enables persistent login across page reloads
   */
  useEffect(() => {
    debugLog('📱 useAuth mounted - checking for existing session...');
    
    // Load from localStorage first for instant UI (avoid flash/flicker)
    const storedToken = localStorage.getItem(STORAGE_TOKEN_KEY);
    const storedUser = localStorage.getItem(STORAGE_USER_KEY);
    
    debugLog('🔍 localStorage check: token?', !!storedToken, 'user?', !!storedUser);
    
    if (storedToken && storedUser) {
      try {
        const parsedUser = JSON.parse(storedUser);
        setUser(parsedUser);
        setIsAuthenticated(true);
        setIsLoading(false);
      } catch (e) {
        console.error('❌ Failed to parse stored user', e);
        localStorage.removeItem(STORAGE_USER_KEY);
      }
    } else {
      debugLog('ℹ️ No cached user found');
      setIsLoading(false);
    }

    // Always verify with server (even if we have cached data)
    // This ensures token is still valid and gets fresh user info
    debugLog('🔄 Starting server verification...');
    checkAuth();

  }, [checkAuth]);

  /**
   * Handle login: send OTP and receive JWT token
   * @param phone - User's phone number (formatted)
   * @param otp - One-time password from SMS
   * @param fullName - Optional name for new users
   */
  const login = async (phone: string, otp: string, fullName?: string) => {
    try {
      debugLog('🔐 Attempting login with phone:', phone);
      const response = await authService.login(phone, otp, fullName);

      // Backend returns: { access_token, user }
      const { access_token, user: userData } = response.data;
      
      debugLog('✅ Login successful');
      // Save JWT token to localStorage
      // axios interceptor will automatically include it in all API requests
      if (access_token) {
        localStorage.setItem(STORAGE_TOKEN_KEY, access_token);
        localStorage.setItem(STORAGE_LAST_AUTH_CHECK, Date.now().toString());
      }

      // Persist user info for instant UI
      localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(userData));
      debugLog('✅ User saved to localStorage');

      sessionStorage.removeItem('motofix_driver_greeting');  // fresh home-screen headline each login

      setUser(userData);
      setIsAuthenticated(true);
      window.dispatchEvent(new Event('motofix:auth-changed'));

      // Sync preferences from server so settings follow the user across devices/URLs
      authService.getPreferences()
        .then(res => { if (res.data?.preferences) mergeServerPreferences(res.data.preferences); })
        .catch(() => {});

      return userData;
    } catch (error) {
      console.error('❌ Login failed:', error);
      throw error;
    }
  };

  /**
   * Handle logout: clear token and user data
   * Calls /auth/logout on server to clear httpOnly cookie
   */
  const logout = () => {
    debugLog('🚪 Logout initiated');
    // Clear localStorage
    localStorage.removeItem(STORAGE_TOKEN_KEY);
    localStorage.removeItem(STORAGE_USER_KEY);
    localStorage.removeItem(STORAGE_LAST_AUTH_CHECK);
    debugLog('✅ localStorage cleared');
    
    // Clear state
    setUser(null);
    setIsAuthenticated(false);
    window.dispatchEvent(new Event('motofix:auth-changed'));

    // Call server to clear httpOnly cookie (best effort - ignore errors)
    authService.logout().catch((err) => {
      console.error('⚠️ Logout request failed (non-blocking):', err);
    });
  };

  return {
    user,
    isLoading,
    isAuthenticated,
    login,
    logout,
    checkAuth, // For manual auth checks if needed
  };
}

type AuthContextValue = ReturnType<typeof useAuthState>;
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const auth = useAuthState();
  return createElement(AuthContext.Provider, { value: auth }, children);
}

export function useAuth(): AuthContextValue {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error('useAuth must be used inside AuthProvider');
  return auth;
}
