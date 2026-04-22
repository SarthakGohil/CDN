'use client'

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { useCdnStore } from '../store/cdnStore'

const SocketContext = createContext(null)

export function SocketProvider({ children }) {
  const [socket, setSocket]   = useState(null)
  const setSocketState        = useCdnStore(s => s.setSocketState)
  const addLog                = useCdnStore(s => s.addLog)
  const upsertRemoteNode      = useCdnStore(s => s.upsertRemoteUserNode)
  const upsertUser            = useCdnStore(s => s.upsertUser)
  const spawnRequest          = useCdnStore(s => s.spawnRequest)

  // Always read myClientId directly from store — avoids stale ref on first event
  const myClientIdRef = useRef(null)

  // Keep ref up to date
  useEffect(() => {
    const unsub = useCdnStore.subscribe(
      s => s.myClientId,
      id => {
        myClientIdRef.current = id

        // As soon as we know our own clientId, remove any stray remote node
        // that was created before the /me response arrived
        if (id) {
          const strayId = `user:${id}`
          useCdnStore.setState(s => ({
            nodes:          s.nodes.filter(n => n.id !== strayId),
            activeRequests: s.activeRequests.filter(r => r.userNodeId !== strayId),
          }))
        }
      }
    )
    // Also sync immediately in case myClientId is already set
    myClientIdRef.current = useCdnStore.getState().myClientId
    return unsub
  }, [])

  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SOCKET_URL || 'http://127.0.0.1:4000'
    const s = io(url, { transports: ['websocket'] })

    s.on('connect', () => {
      setSocketState({ id: s.id, connected: true })
      addLog(`Socket connected (${s.id.slice(0, 6)})`)
    })

    s.on('disconnect', () => {
      setSocketState({ connected: false })
      addLog('Socket disconnected')
    })

    s.on('cdn:log', payload => {
      if (payload?.message) addLog(payload.message)
    })

    // TM pushes metrics after every health check — no polling needed
    s.on('cdn:metrics', data => {
      useCdnStore.setState({ tmMetrics: data })
    })

    // Strategy change broadcast from TM — syncs across all viewers
    s.on('cdn:lb', data => {
      if (data?.strategy) useCdnStore.setState({ lbStrategy: data.strategy })
    })

    // Every real HTTP request through TM is broadcast here (all clients, including self)
    s.on('cdn:request', payload => {
      if (!payload || !payload.coords) return

      const clientId    = String(payload.clientId || payload.userKey || 'unknown')
      const coords      = payload.coords
      const fileName    = payload.fileName || 'file'
      const cacheStatus = payload.cacheStatus === 'HIT' ? 'HIT' : 'MISS'
      const latencyMs   = typeof payload.latencyMs === 'number' ? payload.latencyMs : null
      const forceEdgeId = payload.forceEdgeId || payload.edgeId || null

      // Update global users registry (everyone, visible in Users tab)
      upsertUser({ clientId, country: payload.country || '??', region: payload.region || 'unknown', coords, fileName, cacheStatus, latencyMs })

      // Read myClientId fresh from store at event time — not from a potentially stale ref
      const myId = myClientIdRef.current || useCdnStore.getState().myClientId

      if (myId && clientId === myId) {
        // This is OUR OWN request broadcast back from TM.
        // Dashboard.onFetch already animated on the 'user' node — skip.
        return
      }

      // It's a different real user — put their node on canvas and animate
      const userNodeId = upsertRemoteNode({ clientId, coords })
      spawnRequest({ userNodeId, clientId, coords, fileName, cacheStatus, forceEdgeId, latencyMs })
    })

    setSocket(s)
    return () => s.disconnect()
  }, [addLog, setSocketState, spawnRequest, upsertRemoteNode, upsertUser])

  const value = useMemo(() => ({ socket }), [socket])
  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>
}

export function useSocket() { return useContext(SocketContext) }
