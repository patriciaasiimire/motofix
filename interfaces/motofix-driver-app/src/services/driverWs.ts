// src/services/driverWs.ts
// Production-ready WebSocket client for real-time request status updates

import { WS_URL } from '@/config/api';
import { debugLog } from '@/utils/debug';

export interface WsPayload {
  type: string;
  job_id?: number | string;
  request_id?: number | string;
  service_request_id?: number | string;
  status?: string;
  mechanic_id?: string;
  mechanic_name?: string;
  mechanic_lat?: number;
  mechanic_lon?: number;
  lat?: number;
  lng?: number;
  [key: string]: unknown;
}

/**
 * Opens a WebSocket connection to the requests service with automatic
 * exponential-backoff reconnection. Reads the JWT from localStorage so
 * no import of a broken auth helper is needed.
 *
 * @returns cleanup function — call it when the consumer unmounts.
 */
export function createRequestsWs(
  onMessage: (payload: WsPayload) => void,
  onConnect?: () => void,
  onDisconnect?: () => void,
): { stop: () => void; send: (data: object) => void } {
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let retryCount = 0;
  let loggedUnavailable = false;
  const maxReconnectAttempts = 8;

  const connect = () => {
    if (stopped || !localStorage.getItem('motofix_token')) return;

    const token = localStorage.getItem('motofix_token');
    // Pass token as query param so the backend can authenticate WS connections
    const fallbackUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/jobs`;
    const url = `${WS_URL || fallbackUrl}${token ? `?token=${encodeURIComponent(token)}` : ''}`;

    try {
      ws = new WebSocket(url);
    } catch (error) {
      if (!loggedUnavailable) {
        console.error('[WS] Unable to create dispatch connection.', error);
        loggedUnavailable = true;
      }
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      retryCount = 0;
      loggedUnavailable = false;
      debugLog('[WS] connected');
      onConnect?.();
    };

    ws.onmessage = (ev) => {
      try {
        const payload: WsPayload = JSON.parse(ev.data as string);
        onMessage(payload);
      } catch {
        // Ignore malformed frames
      }
    };

    ws.onclose = () => {
      ws = null;
      onDisconnect?.();
      scheduleReconnect();
    };

    ws.onerror = () => {
      if (!loggedUnavailable) {
        console.error('[WS] Dispatch connection failed; live updates will retry in the background.');
        loggedUnavailable = true;
      }
      // onclose will fire after onerror, triggering reconnect
      ws?.close();
    };
  };

  const scheduleReconnect = () => {
    if (stopped || !localStorage.getItem('motofix_token')) return;
    if (retryCount >= maxReconnectAttempts) {
      if (!loggedUnavailable) {
        console.error(`[WS] Stopped reconnecting after ${maxReconnectAttempts} failed attempts.`);
        loggedUnavailable = true;
      }
      return;
    }
    // Exponential backoff: 1s, 2s, 4s … capped at 30s
    const delay = Math.min(1000 * 2 ** retryCount, 30_000);
    retryCount += 1;
    reconnectTimer = setTimeout(connect, delay);
  };

  const onAuthChanged = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
    }
    ws = null;
    retryCount = 0;
    if (localStorage.getItem('motofix_token')) connect();
    else onDisconnect?.();
  };
  window.addEventListener('motofix:auth-changed', onAuthChanged);
  connect();

  const send = (data: object): void => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  };

  return {
    stop: () => {
      stopped = true;
      window.removeEventListener('motofix:auth-changed', onAuthChanged);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    },
    send,
  };
}
