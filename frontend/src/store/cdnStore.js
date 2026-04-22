import { create } from 'zustand'
import { getNearestEdge } from '../lib/geo'

const CANVAS = { width: 1000, height: 600 }
const GRAPH_VERSION = 3

const ORIGIN_POS = { x: 390, y: 40 }
const EDGE_POS = {
  'edge-us-east': { x: 80, y: 260 },
  'edge-eu-central': { x: 390, y: 260 },
  'edge-ap-south': { x: 700, y: 260 },
}

const EDGE_NODES = [
  { id: 'edge-us-east', name: 'US-East', region: 'us-east-1', coords: { lat: 37.5, lon: -77.4 } },
  { id: 'edge-eu-central', name: 'EU-Central', region: 'eu-central-1', coords: { lat: 50.11, lon: 8.68 } },
  { id: 'edge-ap-south', name: 'AP-South', region: 'ap-south-1', coords: { lat: 19.08, lon: 72.88 } },
]

// Origin server is conceptually located in San Francisco (US-West)
const ORIGIN_NODE = { id: 'origin', name: 'Origin', region: 'origin', coords: { lat: 37.77, lon: -122.42 } }
const NODE_NAME_TO_EDGE = { A: EDGE_NODES[0], B: EDGE_NODES[1], C: EDGE_NODES[2] }

function nowIso() { return new Date().toISOString() }
function shortTime() { return new Date().toTimeString().slice(0, 8) }
function makeId(p) {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `${p}:${crypto.randomUUID()}`
  return `${p}:${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
}

/**
 * Haversine formula — great-circle distance in km between two lat/lon points.
 * Used to make animation speed proportional to geographic distance.
 */
function haversineKm(a, b) {
  const R = 6371
  const toRad = deg => deg * Math.PI / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const sinDLat = Math.sin(dLat / 2)
  const sinDLon = Math.sin(dLon / 2)
  const c = sinDLat * sinDLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinDLon * sinDLon
  return R * 2 * Math.asin(Math.min(1, Math.sqrt(c)))
}

/**
 * Distance-based visual animation duration.
 *
 * In a real CDN, latency ≈ distance / speed_of_light_in_fiber (~200 km/ms).
 * For visual purposes we scale slower so the packet is actually visible:
 *   MS_PER_KM = 0.08  →  1000 km ≈ 80ms per one-way hop
 *
 * HIT  (User→Edge→User):        2 × user_to_edge,   min 700ms
 * MISS (User→Edge→Origin→Edge→User): HIT + 2 × edge_to_origin,  min 1400ms total
 */
const MS_PER_KM     = 0.08   // visual ms per km (one-way)
const MIN_HIT_MS    = 700    // never faster than 700ms even for nearby edge
const MIN_MISS_MS   = 1400   // never faster than 1400ms for full origin fetch

function calcVisualMs(userCoords, edgeCoords, cacheStatus) {
  const userToEdge = haversineKm(userCoords, edgeCoords)
  const hitMs = Math.max(MIN_HIT_MS, userToEdge * MS_PER_KM * 2)  // round trip
  if (cacheStatus === 'HIT') return hitMs

  const edgeToOrigin = haversineKm(edgeCoords, ORIGIN_NODE.coords)
  const missExtra = Math.max(MIN_MISS_MS / 2, edgeToOrigin * MS_PER_KM * 2)
  return Math.max(MIN_MISS_MS, hitMs + missExtra)
}

function colorFromKey(key) {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360
  return `hsl(${h} 90% 60%)`
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)) }

function jitterForKey(key, radius = 34) {
  let seed = 0
  for (let i = 0; i < key.length; i++) seed = (seed * 33 + key.charCodeAt(i)) >>> 0
  const angle = ((seed % 360) * Math.PI) / 180
  const r = radius * (0.6 + ((seed % 97) / 97) * 0.4)
  return { dx: Math.cos(angle) * r, dy: Math.sin(angle) * r }
}

function buildBaseNodes() {
  return [
    {
      id: ORIGIN_NODE.id,
      type: 'cdn',
      position: ORIGIN_POS,
      data: { title: 'Origin Server', subtitle: 'Source of truth', kind: 'origin' },
    },
    ...EDGE_NODES.map(edge => ({
      id: edge.id,
      type: 'cdn',
      position: EDGE_POS[edge.id],
      data: { title: `Edge ${edge.name}`, subtitle: edge.region, kind: 'edge' },
    })),
    {
      id: 'user',
      type: 'cdn',
      position: { x: 390, y: 470 },
      data: { title: 'You', subtitle: 'Locating…', kind: 'user', accent: 'rgba(34,197,94,0.9)' },
    },
  ]
}

function buildBaseEdges() {
  return EDGE_NODES.map(edge => ({
    id: `e:origin:${edge.id}`,
    source: ORIGIN_NODE.id,
    target: edge.id,
    type: 'smoothstep',
    animated: false,
    style: { stroke: 'rgba(148,163,184,0.35)' },
  }))
}

function buildPath({ userNodeId, edgeId, cacheStatus }) {
  if (cacheStatus === 'HIT') return [userNodeId, edgeId, userNodeId]
  return [userNodeId, edgeId, ORIGIN_NODE.id, edgeId, userNodeId]
}

export const useCdnStore = create((set, get) => ({
  graphVersion: GRAPH_VERSION,
  nodes: buildBaseNodes(),
  edges: buildBaseEdges(),
  edgeCatalog: EDGE_NODES,
  origin: ORIGIN_NODE,

  local: { coords: null, region: 'unknown', nearestEdgeId: null, distanceKm: null },
  socket: { id: null, connected: false },
  stats: { cacheHits: 0, cacheMisses: 0, lastLatencyMs: null, lastEdgeNode: null },
  logs: [],
  activeRequests: [],
  tmMetrics: null,
  originMetrics: null,
  lbStrategy: 'weighted',   // mirrors TM's current strategy

  // ── Global users registry ──────────────────────────────────────
  // keyed by clientId (IP-based hash from TM)
  // { [clientId]: { clientId, country, region, coords, requestCount, lastSeen, recentRequests[] } }
  users: {},
  myClientId: null,   // set from X-Client-Id header on first fetch
  selectedUserId: null,   // for Users panel drill-down

  // ──────────────────────────────────────────────────────────────
  resetGraph: () => set(s => ({
    graphVersion: GRAPH_VERSION,
    nodes: buildBaseNodes(),
    edges: buildBaseEdges(),
    activeRequests: [],
    tmMetrics: null,
    originMetrics: null,
    users: {},
    selectedUserId: null,
    local: { ...s.local, coords: null, region: 'unknown', nearestEdgeId: null, distanceKm: null },
  })),

  setSocketState: (next) => set(s => ({ socket: { ...s.socket, ...next } })),
  setSelectedUser: (clientId) => set({ selectedUserId: clientId }),
  setMyClientId: (id) => set({ myClientId: id }),

  addLog: (message) => {
    const entry = { id: makeId('log'), ts: nowIso(), time: shortTime(), message }
    set(s => ({ logs: [...s.logs, entry].slice(-300) }))
  },

  setLocalCoords: (coords) => {
    const nearest = getNearestEdge(coords, EDGE_NODES.map(e => ({ ...e, coords: e.coords })))
    const region = nearest?.region || 'unknown'
    const nearestEdgeId = nearest?.id || null

    set(s => ({
      local: { coords, region, nearestEdgeId, distanceKm: null },
      nodes: s.nodes.map(n => n.id !== 'user' ? n : {
        ...n,
        position: { x: 390, y: 470 },
        data: {
          ...n.data,
          title: 'You',
          subtitle: `${coords.lat.toFixed(2)}, ${coords.lon.toFixed(2)} • ${region}`,
        },
      }),
    }))
  },

  // ── Upsert a user in the global users registry ─────────────────
  upsertUser: ({ clientId, country, region, coords, fileName, cacheStatus, latencyMs }) => {
    if (!clientId) return

    const newReq = { fileName, cacheStatus, latencyMs, time: shortTime(), ts: nowIso() }

    set(s => {
      const prev = s.users[clientId] || { requestCount: 0, recentRequests: [] }
      const recentRequests = [...prev.recentRequests, newReq].slice(-20)
      return {
        users: {
          ...s.users,
          [clientId]: {
            clientId,
            country: country || prev.country || '??',
            region: region || prev.region || 'unknown',
            coords: coords || prev.coords,
            requestCount: prev.requestCount + 1,
            lastSeen: Date.now(),
            recentRequests,
          },
        },
      }
    })
  },

  // ── Upsert a remote user NODE on the canvas ────────────────────
  upsertRemoteUserNode: ({ clientId, coords }) => {
    const nodeId = `user:${clientId}`
    const nearest = getNearestEdge(coords, EDGE_NODES.map(e => ({ ...e, coords: e.coords })))

    // Spread remote users in the bottom row
    const baseX = 390
    const { dx, dy } = jitterForKey(clientId, 80)
    const jittered = {
      x: clamp(baseX + dx, 20, CANVAS.width - 260),
      y: clamp(470 + dy, 20, CANVAS.height - 100),
    }

    set(s => {
      const exists = s.nodes.some(n => n.id === nodeId)
      const node = {
        id: nodeId,
        type: 'cdn',
        position: jittered,
        data: {
          title: clientId.slice(0, 8),
          subtitle: coords ? `${coords.lat.toFixed(1)}, ${coords.lon.toFixed(1)} · ${nearest?.name || ''}` : '',
          kind: 'user',
          accent: colorFromKey(clientId),
          clientId,
        },
      }
      return { nodes: exists ? s.nodes.map(n => n.id === nodeId ? node : n) : [...s.nodes, node] }
    })

    return nodeId
  },

  // ── Spawn an animated packet request ──────────────────────────
  spawnRequest: ({ userNodeId, clientId, coords, fileName, cacheStatus, forceEdgeId, latencyMs }) => {
    const nearest = forceEdgeId
      ? EDGE_NODES.find(e => e.id === forceEdgeId)
      : getNearestEdge(coords, EDGE_NODES.map(e => ({ ...e, coords: e.coords })))
    if (!nearest) return

    const path = buildPath({ userNodeId, edgeId: nearest.id, cacheStatus })
    const color = userNodeId === 'user' ? 'rgba(34,197,94,0.9)' : colorFromKey(clientId || userNodeId)
    // Distance-based animation: packet speed reflects geographic distance
    // so nearby edge = fast, far edge = slow — just like real CDN latency
    const visualMs = calcVisualMs(coords || nearest.coords, nearest.coords, cacheStatus)
    const speed = (path.length - 1) / visualMs   // segments per ms

    const request = {
      id: makeId('req'),
      clientId,
      userNodeId,
      coords,
      nearestEdgeId: nearest.id,
      fileName,
      cacheStatus,
      color,
      path,
      segmentIndex: 0,
      t: 0,
      speed,
      createdAt: nowIso(),
    }

    set(s => ({
      activeRequests: [...s.activeRequests, request].slice(-250),
      stats: {
        ...s.stats,
        cacheHits: cacheStatus === 'HIT' ? s.stats.cacheHits + 1 : s.stats.cacheHits,
        cacheMisses: cacheStatus !== 'HIT' ? s.stats.cacheMisses + 1 : s.stats.cacheMisses,
        lastLatencyMs: latencyMs ?? s.stats.lastLatencyMs,
        lastEdgeNode: nearest.name,
      },
    }))

    const prefix = userNodeId === 'user' ? 'You' : `User ${(clientId || '').slice(0, 6)}`
    const latStr = latencyMs ? ` in ${latencyMs}ms` : ''
    get().addLog(`${prefix} hit ${nearest.name} (${nearest.region}): CACHE ${cacheStatus} (${fileName})${latStr}`)
  },

  tick: (dtMs) => {
    if (!dtMs || dtMs <= 0) return
    set(s => {
      const next = []
      for (const r of s.activeRequests) {
        let { segmentIndex, t } = r
        t += dtMs * r.speed
        while (t >= 1 && segmentIndex < r.path.length - 2) { t -= 1; segmentIndex++ }
        const done = segmentIndex >= r.path.length - 2 && t >= 1
        if (!done) next.push({ ...r, segmentIndex, t: Math.min(t, 1) })
      }
      return { activeRequests: next }
    })
  },

  getEdgeByNodeName: (name) => NODE_NAME_TO_EDGE[name] || null,
}))

export function getEdgeCatalog() { return EDGE_NODES }
