'use client'

import { useMemo, useState } from 'react'
import { useCdnStore } from '../store/cdnStore'

const FLAG = (cc) => {
  if (!cc || cc === '??') return '🌐'
  try {
    return cc.toUpperCase().replace(/./g, c =>
      String.fromCodePoint(c.charCodeAt(0) + 127397)
    )
  } catch { return '🌐' }
}

function timeAgo(ms) {
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s ago`
  return `${Math.floor(s / 60)}m ago`
}

// ── Tab: CDN Stats ────────────────────────────────────────────────────────────
function CDNTab({ onFetch }) {
  const local         = useCdnStore(s => s.local)
  const stats         = useCdnStore(s => s.stats)
  const socket        = useCdnStore(s => s.socket)
  const tmMetrics     = useCdnStore(s => s.tmMetrics)
  const originMetrics = useCdnStore(s => s.originMetrics)
  const users         = useCdnStore(s => s.users)
  const lbStrategy    = useCdnStore(s => s.lbStrategy)

  const cacheHits   = tmMetrics?.global_hits   ?? 0
  const cacheMisses = tmMetrics?.global_misses ?? 0
  const total       = cacheHits + cacheMisses
  const cacheRatio  = total > 0 ? cacheHits / total : 0
  const userCount   = Object.keys(users).length

  return (
    <div className="flex flex-col gap-3 flex-1 overflow-auto pb-2">
      {/* Status row */}
      <div className="flex items-center justify-between">
        <div className="text-xs text-slate-400">Region: <span className="text-white">{local.region}</span></div>
        <div className="text-xs text-slate-400">{userCount} user{userCount !== 1 ? 's' : ''} global</div>
      </div>

      {/* Edge nodes live */}
      <div className="rounded-lg bg-panel border border-white/10 p-3">
        <div className="text-xs text-slate-300 mb-2">Live Edge Nodes</div>
        <div className="flex flex-col gap-1 text-xs font-mono">
          {tmMetrics?.nodes?.map(n => (
            <div key={n.name} className="flex justify-between">
              <span className="text-slate-400">Edge {n.name} <span className="text-slate-500">({n.region})</span></span>
              <span className={n.status === 'ONLINE' ? 'text-emerald-400' : 'text-rose-400'}>
                {n.status === 'ONLINE'
                  ? `${n.active_connections}c · ${n.cache_size}f · ${n.rtt_latency_ms}ms`
                  : 'OFFLINE'}
              </span>
            </div>
          )) ?? <span className="text-slate-500">Waiting for TM…</span>}
        </div>
      </div>

      {/* Load Balancer — informational, not switchable */}
      <div className="rounded-lg bg-panel border border-white/10 p-3">
        <div className="text-xs text-slate-300 mb-1.5 flex items-center justify-between">
          <span>Load Balancer</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-400/10 border border-emerald-400/20 text-emerald-300 font-mono">active</span>
        </div>
        <div className="text-[11px] text-slate-400 leading-relaxed">
          <span className="text-cyan-300 font-semibold">Geo-priority + Live Load</span>
          <br />Routes to nearest region. Falls back to least-loaded node if nearest is congested (score = RTT + conns×20).
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-panel border border-white/10 p-2.5">
          <div className="text-xs text-slate-400">Last RTT</div>
          <div className="font-mono text-sm mt-0.5">{stats.lastLatencyMs != null ? `${stats.lastLatencyMs}ms` : '—'}</div>
          {stats.lastEdgeNode && <div className="text-xs text-slate-500">via Edge {stats.lastEdgeNode}</div>}
        </div>
        <div className="rounded-lg bg-panel border border-white/10 p-2.5">
          <div className="text-xs text-slate-400">Cache Ratio</div>
          <div className="font-mono text-sm mt-0.5">{Math.round(cacheRatio * 100)}%</div>
        </div>
        <div className="rounded-lg bg-panel border border-white/10 p-2.5">
          <div className="text-xs text-slate-400">Hits</div>
          <div className="font-mono text-sm mt-0.5">{cacheHits}</div>
        </div>
        <div className="rounded-lg bg-panel border border-white/10 p-2.5">
          <div className="text-xs text-slate-400">Misses</div>
          <div className="font-mono text-sm mt-0.5">{cacheMisses}</div>
        </div>
        <div className="rounded-lg bg-panel border border-white/10 p-2.5 col-span-2">
          <div className="text-xs text-slate-400">Origin Files</div>
          <div className="font-mono text-sm mt-0.5">{originMetrics?.total_files ?? '—'} files in source</div>
        </div>
      </div>

      {/* Fetch */}
      <button
        type="button"
        onClick={onFetch}
        className="mt-auto w-full rounded-lg bg-cyan-400/15 hover:bg-cyan-400/25 border border-cyan-300/40 text-cyan-100 py-3 font-semibold tracking-wide text-sm"
      >
        ▶ Fetch Data
      </button>

      <div className="text-xs text-slate-500 text-center">
        {local.coords ? `${local.coords.lat.toFixed(2)}, ${local.coords.lon.toFixed(2)}` : 'Locating…'}
      </div>
    </div>
  )
}

// ── Tab: Global Users ─────────────────────────────────────────────────────────
function UsersTab() {
  const users          = useCdnStore(s => s.users)
  const selectedUserId = useCdnStore(s => s.selectedUserId)
  const setSelectedUser = useCdnStore(s => s.setSelectedUser)
  const myClientId     = useCdnStore(s => s.myClientId)

  const sorted = useMemo(() =>
    Object.values(users).sort((a, b) => b.lastSeen - a.lastSeen),
    [users]
  )

  const selected = selectedUserId ? users[selectedUserId] : null

  if (selected) {
    return (
      <div className="flex flex-col gap-3 flex-1 overflow-auto">
        {/* Back button */}
        <button
          onClick={() => setSelectedUser(null)}
          className="text-xs text-cyan-400 hover:text-cyan-200 text-left flex items-center gap-1"
        >
          ← All Users
        </button>

        {/* User info */}
        <div className="rounded-lg bg-panel border border-white/10 p-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-lg">{FLAG(selected.country)}</span>
            <div>
              <div className="font-mono text-sm text-white">{selected.clientId}</div>
              <div className="text-xs text-slate-400">{selected.country} · {selected.region}</div>
            </div>
            {selected.clientId === myClientId && (
              <span className="ml-auto text-xs bg-emerald-400/10 border border-emerald-400/30 text-emerald-300 px-2 py-0.5 rounded-full">You</span>
            )}
          </div>
          <div className="text-xs font-mono text-slate-300">
            Requests: <span className="text-white">{selected.requestCount}</span>
            <span className="ml-3 text-slate-500">{timeAgo(selected.lastSeen)}</span>
          </div>
          {selected.coords && (
            <div className="text-xs font-mono text-slate-500 mt-1">
              {selected.coords.lat.toFixed(2)}, {selected.coords.lon.toFixed(2)}
            </div>
          )}
        </div>

        {/* Recent requests */}
        <div className="text-xs text-slate-400 font-semibold">Recent Requests</div>
        <div className="flex flex-col gap-1.5 overflow-auto">
          {selected.recentRequests.length === 0 && (
            <div className="text-xs text-slate-500">No requests yet.</div>
          )}
          {[...selected.recentRequests].reverse().map((r, i) => (
            <div key={i} className="rounded-md bg-panel border border-white/10 px-2.5 py-2 text-xs font-mono">
              <div className="flex justify-between">
                <span className="text-slate-400">{r.time}</span>
                <span className={r.cacheStatus === 'HIT' ? 'text-emerald-400' : 'text-orange-400'}>
                  {r.cacheStatus}
                </span>
              </div>
              <div className="text-white mt-0.5">{r.fileName}</div>
              {r.latencyMs != null && (
                <div className="text-slate-500 mt-0.5">{r.latencyMs}ms</div>
              )}
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 flex-1 overflow-auto">
      <div className="text-xs text-slate-400">{sorted.length} user{sorted.length !== 1 ? 's' : ''} seen globally</div>

      {sorted.length === 0 && (
        <div className="text-xs text-slate-500 mt-4 text-center">
          No users yet. Request activity will appear here when users hit the CDN.
        </div>
      )}

      {sorted.map(u => (
        <button
          key={u.clientId}
          onClick={() => setSelectedUser(u.clientId)}
          className="rounded-lg bg-panel border border-white/10 p-3 text-left hover:border-cyan-400/30 transition-colors"
        >
          <div className="flex items-center gap-2">
            <span>{FLAG(u.country)}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-white truncate">{u.clientId}</span>
                {u.clientId === myClientId && (
                  <span className="text-[10px] bg-emerald-400/10 border border-emerald-400/30 text-emerald-300 px-1.5 py-0.5 rounded-full whitespace-nowrap">You</span>
                )}
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5">{u.country} · {u.region}</div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-xs text-white">{u.requestCount} req</div>
              <div className="text-[10px] text-slate-500">{timeAgo(u.lastSeen)}</div>
            </div>
          </div>
        </button>
      ))}
    </div>
  )
}

// ── Sidebar shell ─────────────────────────────────────────────────────────────
export default function Sidebar({ onFetch }) {
  const [tab, setTab] = useState('cdn')
  const socket = useCdnStore(s => s.socket)

  return (
    <div className="h-full w-full rounded-xl bg-surface border border-white/10 p-4 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div className="text-base font-semibold tracking-wide">CDN Control</div>
        <div className={`text-xs px-2 py-0.5 rounded-full border ${
          socket.connected
            ? 'border-emerald-400/40 text-emerald-200'
            : 'border-rose-400/40 text-rose-200'
        }`}>
          {socket.connected ? 'LIVE' : 'OFFLINE'}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex rounded-lg bg-panel border border-white/10 p-0.5 shrink-0">
        {['cdn', 'users'].map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-1.5 text-xs font-semibold rounded-md transition-colors ${
              tab === t
                ? 'bg-cyan-400/20 text-cyan-200 border border-cyan-400/30'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t === 'cdn' ? 'CDN Stats' : 'Global Users'}
          </button>
        ))}
      </div>

      {tab === 'cdn'   ? <CDNTab onFetch={onFetch} /> : <UsersTab />}
    </div>
  )
}
