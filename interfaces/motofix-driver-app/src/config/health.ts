// config/health.ts — developer debugging helpers (not used in the normal app flow).
// checkServiceHealth() pings the auth and requests services to see if they're up,
// and testAuthEndpoint() tries the send-OTP call. Handy when something isn't working
// and you want to confirm the backend is reachable; results are printed to the console.

import axios from 'axios';
import { AUTH_BASE_URL, REQUESTS_BASE_URL, authService, getAuthErrorMessage } from './api';
import { debugLog } from '@/utils/debug';

export async function checkServiceHealth() {
  debugLog('🏥 Checking Motofix services health...');
  
  const services = {
    auth: { url: AUTH_BASE_URL, healthy: false, error: '' },
    requests: { url: REQUESTS_BASE_URL, healthy: false, error: '' },
  };

  // Check Auth Service
  try {
    debugLog('🔍 Checking Auth Service:', AUTH_BASE_URL);
    const response = await axios.get(`${AUTH_BASE_URL}/health`, { timeout: 5000 });
    services.auth.healthy = response.status === 200;
    debugLog('✅ Auth Service is healthy');
  } catch (error: unknown) {
    services.auth.error = error instanceof Error ? error.message : String(error);
    console.warn('⚠️ Auth Service check failed:', services.auth.error);
  }

  // Check Requests Service
  try {
    debugLog('🔍 Checking Requests Service:', REQUESTS_BASE_URL);
    const response = await axios.get(`${REQUESTS_BASE_URL}/health`, { timeout: 5000 });
    services.requests.healthy = response.status === 200;
    debugLog('✅ Requests Service is healthy');
  } catch (error: unknown) {
    services.requests.error = error instanceof Error ? error.message : String(error);
    console.warn('⚠️ Requests Service check failed:', services.requests.error);
  }

  debugLog('📊 Health Check Results:', services);
  return services;
}

export async function testAuthEndpoint(phone: string) {
  debugLog('🧪 Testing Auth endpoint with phone:', phone);
  
  try {
    const response = await authService.sendOtp(phone);
    debugLog('✅ Auth endpoint test successful:', response.status);
    return { success: true, status: response.status };
  } catch (error: unknown) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    console.error('❌ Auth endpoint test failed:', {
      status,
      message: getAuthErrorMessage(error),
    });
    return { 
      success: false, 
      status,
      error: getAuthErrorMessage(error),
    };
  }
}
