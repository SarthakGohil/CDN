'use client'

import { useEffect, useRef } from 'react'
import { useCdnStore } from '../store/cdnStore'

export default function BottomLog() {
  const logs = useCdnStore((s) => s.logs)
  const ref = useRef(null)

  useEffect(() => {
    if (!ref.current) return
    ref.current.scrollTop = ref.current.scrollHeight
  }, [logs.length])

  return (
    <div className="h-full w-full rounded-xl bg-surface border border-white/10 overflow-hidden flex flex-col">
      <div className="px-3 py-2 border-b border-white/10 text-sm font-semibold tracking-wide">Live Terminal</div>
      <div ref={ref} className="flex-1 overflow-auto px-3 py-2 font-mono text-xs leading-5">
        {logs.length === 0 ? (
          <div className="text-slate-400">Waiting for events…</div>
        ) : (
          logs.map((l) => (
            <div key={l.id} className="text-slate-200">
              <span className="text-slate-400">[{l.time}] </span>
              <span>{l.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
