'use client'

import { useCallback, useEffect } from 'react'
import CDNCanvas from './CDNCanvas'
import Sidebar from './Sidebar'
import BottomLog from './BottomLog'
import { resolveUserCoords } from '../lib/geo'
import { useCdnStore } from '../store/cdnStore'

const TM_URL = process.env.NEXT_PUBLIC_TM_URL || 'http://127.0.0.1:4000'
const ORIGIN_URL = process.env.NEXT_PUBLIC_ORIGIN_URL || 'http://127.0.0.1:5000'

export default function Dashboard() {
  const local             = useCdnStore(s => s.local)
  const setLocalCoords    = useCdnStore(s => s.setLocalCoords)
  const spawnRequest      = useCdnStore(s => s.spawnRequest)
  const addLog            = useCdnStore(s => s.addLog)
  const resetGraph        = useCdnStore(s => s.resetGraph)
  const getEdgeByNodeName = useCdnStore(s => s.getEdgeByNodeName)
  const setMyClientId     = useCdnStore(s => s.setMyClientId)

  // ── Init: geo + fetch own clientId from TM ──────────────────────
  useEffect(() => {
    let cancelled = false
    resetGraph()

    // 1. Resolve browser geo
    resolveUserCoords().then(coords => {
      if (cancelled) return
      setLocalCoords(coords)
      addLog(`Geo initialized (${coords.lat.toFixed(2)}, ${coords.lon.toFixed(2)})`)
    })

    // 2. Get our stable clientId from TM — eliminates the race condition
    //    Must happen before any Fetch Data click so deduplication works from the start
    fetch(`${TM_URL}/me`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (cancelled || !data?.clientId) return
        setMyClientId(data.clientId)
        addLog(`Identity: ${data.clientId} (${data.country} · ${data.region})`)
      })
      .catch(() => {}) // TM might not be up yet, Dashboard still works

    return () => { cancelled = true }
  }, [addLog, resetGraph, setLocalCoords, setMyClientId])

  // Origin metrics every 10s
  useEffect(() => {
    const poll = () => fetch(`${ORIGIN_URL}/metrics`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) useCdnStore.setState({ originMetrics: d }) })
      .catch(() => {})

    poll()
    const id = setInterval(poll, 10_000)
    return () => clearInterval(id)
  }, [])

  // ── Fetch file through TM ──────────────────────────────────────
  const onFetch = useCallback(async () => {
    if (!local.coords) { addLog('Still locating…'); return }

    const fileName   = 'test.txt'
    const regionHint = local.nearestEdgeId === 'edge-ap-south'   ? 'Asia'
                     : local.nearestEdgeId === 'edge-eu-central'  ? 'Europe'
                     : 'America'
    const startTime = Date.now()

    try {
      const ctrl = new AbortController()
      const tid  = setTimeout(() => ctrl.abort(), 15000)
      const res  = await fetch(`${TM_URL}/file/${fileName}?region=${regionHint}`, { signal: ctrl.signal })
      clearTimeout(tid)

      const latencyMs   = Date.now() - startTime
      const cacheStatus = res.headers.get('X-Cache') || 'MISS'
      const edgeNode    = res.headers.get('X-Edge-Node') || ''

      // Also capture clientId in case /me wasn't called yet (fallback)
      const clientIdHdr = res.headers.get('X-Client-Id') || ''
      if (clientIdHdr) setMyClientId(clientIdHdr)

      const edgeEntry   = getEdgeByNodeName(edgeNode)
      const forceEdgeId = edgeEntry?.id || local.nearestEdgeId || 'edge-us-east'

      spawnRequest({
        userNodeId: 'user',
        clientId:   clientIdHdr || 'local',
        coords:     local.coords,
        fileName,
        cacheStatus,
        forceEdgeId,
        latencyMs,
      })
    } catch (e) {
      addLog(`Fetch failed: ${e.message}`)
    }
  }, [local.coords, local.nearestEdgeId, spawnRequest, addLog, getEdgeByNodeName, setMyClientId])

  return (
    <div className="h-screen w-screen bg-black overflow-hidden">
      {/* ── Desktop: 2-col grid (sidebar | map/log) ── */}
      {/* ── Mobile:  single col stack (map → sidebar → log) ── */}
      <div className="h-full w-full p-2 md:p-4 flex flex-col md:grid md:grid-cols-[320px_1fr] md:grid-rows-[1fr_220px] gap-2 md:gap-4">

        {/* Map — shown FIRST on mobile, spans full width */}
        <div className="order-1 md:order-2 md:row-start-1 md:col-start-2 min-h-0 h-[40vh] md:h-auto">
          <CDNCanvas />
        </div>

        {/* Sidebar — shown SECOND on mobile, full width */}
        <div className="order-2 md:order-1 md:row-span-2 md:row-start-1 md:col-start-1 min-h-0">
          <Sidebar onFetch={onFetch} />
        </div>

        {/* Log — shown THIRD on mobile */}
        <div className="order-3 md:order-3 md:row-start-2 md:col-start-2 min-h-0 h-[180px] md:h-auto">
          <BottomLog />
        </div>

      </div>
    </div>
  )
}
