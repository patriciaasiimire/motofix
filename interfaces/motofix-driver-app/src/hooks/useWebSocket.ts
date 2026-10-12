// useWebSocket.ts — opens and maintains the live connection to the server.
//
// Given a logged-in user and token, it connects to the server's /ws/jobs channel and
// keeps that connection healthy: it sends a "ping" every 30s to stop it timing out,
// and automatically reconnects 3s after any drop. Exposes isConnected, the latest
// message received, and a sendMessage() function. Used by WebSocketContext, which
// shares one connection across the whole app.

import { useEffect, useRef, useState, useCallback } from 'react'
import { WS_URL } from '@/config/api'

export function useWebSocket(userId: string | undefined, token: string | null) {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const mountedRef = useRef(true)
  const retryCountRef = useRef(0)
  const loggedUnavailableRef = useRef(false)

  const [isConnected, setIsConnected] = useState(false)
  const [lastMessage, setLastMessage] = useState<unknown>(null)

  const connectRef = useRef<() => void>(() => {})
  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current || !userId || !token) return
    const delay = Math.min(1000 * 2 ** retryCountRef.current, 30_000)
    retryCountRef.current = Math.min(retryCountRef.current + 1, 5)
    reconnectRef.current = setTimeout(() => connectRef.current(), delay)
  }, [userId, token])

  const connect = useCallback(() => {
    if (!userId || !token || !mountedRef.current) return
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    // Connect through the SAME origin as the page (Vite/nginx proxies /ws → dispatch).
    // This works on a phone over the LAN and over HTTPS (wss), unlike a hardcoded
    // ws://localhost. An explicit VITE_WS_URL still wins if provided.
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = WS_URL || `${proto}//${window.location.host}/ws/jobs`
    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl)
    } catch (error) {
      if (!loggedUnavailableRef.current) {
        console.error('[WS] Unable to create dispatch connection.', error)
        loggedUnavailableRef.current = true
      }
      scheduleReconnect()
      return
    }
    wsRef.current = ws

    ws.onopen = () => {
      if (!mountedRef.current) return
      retryCountRef.current = 0
      loggedUnavailableRef.current = false
      setIsConnected(true)
      pingRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
      }, 30000)
    }

    ws.onmessage = e => {
      if (!mountedRef.current) return
      try {
        setLastMessage(JSON.parse(e.data))
      } catch {
        setLastMessage(e.data)
      }
    }

    ws.onclose = () => {
      if (!mountedRef.current) return
      setIsConnected(false)
      if (pingRef.current) clearInterval(pingRef.current)
      scheduleReconnect()
    }

    ws.onerror = () => {
      if (!loggedUnavailableRef.current) {
        console.error('[WS] Dispatch connection failed; live updates will retry in the background.')
        loggedUnavailableRef.current = true
      }
      ws.close()
    }
  }, [scheduleReconnect, userId, token])
  connectRef.current = connect

  useEffect(() => {
    mountedRef.current = true
    connect()
    return () => {
      mountedRef.current = false
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
      if (pingRef.current) clearInterval(pingRef.current)
      const ws = wsRef.current
      wsRef.current = null
      if (ws) {
        ws.onclose = null
        ws.onerror = null
        ws.close()
      }
    }
  }, [connect])

  const sendMessage = useCallback((data: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data))
    }
  }, [])

  return { isConnected, lastMessage, sendMessage }
}
