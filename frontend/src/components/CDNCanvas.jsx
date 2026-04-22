'use client'

import { useEffect, useMemo } from 'react'
import ReactFlow, { Background, Controls, Handle, Position, ReactFlowProvider, useStore } from 'react-flow-renderer'
import { useCdnStore } from '../store/cdnStore'

function CdnNode({ data }) {
  const kind = data?.kind || 'edge'
  const accent =
    data?.accent ||
    (kind === 'origin' ? 'rgba(167,139,250,0.9)' : kind === 'user' ? 'rgba(34,197,94,0.9)' : 'rgba(34,211,238,0.9)')

  return (
    <>
      <Handle type="target" position={Position.Top} style={{ opacity: 0, width: 1, height: 1, border: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, width: 1, height: 1, border: 0 }} />
      <div
        style={{
          width: 220,
          borderRadius: 14,
          border: `1px solid ${accent}`,
          background: 'rgba(5,10,20,0.72)',
          backdropFilter: 'blur(8px)',
          boxShadow: `0 0 22px ${accent}33`,
          padding: 12,
          color: '#e5e7eb',
        }}
      >
        <div style={{ fontWeight: 700, letterSpacing: '0.02em', lineHeight: 1.2 }}>{data?.title || 'Node'}</div>
        <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85, lineHeight: 1.25 }}>{data?.subtitle || ''}</div>
      </div>
    </>
  )
}

function centerOfNode(internalNode) {
  const pos = internalNode.positionAbsolute || internalNode.position || { x: 0, y: 0 }
  const width =
    internalNode.width ??
    internalNode.__rf?.width ??
    internalNode.measured?.width ??
    internalNode.__rf?.measured?.width ??
    0
  const height =
    internalNode.height ??
    internalNode.__rf?.height ??
    internalNode.measured?.height ??
    internalNode.__rf?.measured?.height ??
    0

  return { x: pos.x + width / 2, y: pos.y + height / 2 }
}

function PacketLayer() {
  const activeRequests = useCdnStore((s) => s.activeRequests)
  const nodeInternals = useStore((s) => s.nodeInternals)
  const transform = useStore((s) => s.transform)

  const packets = useMemo(() => {
    const list = []
    for (const r of activeRequests) {
      const fromId = r.path[r.segmentIndex]
      const toId = r.path[r.segmentIndex + 1]
      const a = nodeInternals.get(fromId)
      const b = nodeInternals.get(toId)
      if (!a || !b) continue
      const p1 = centerOfNode(a)
      const p2 = centerOfNode(b)
      const x = p1.x + (p2.x - p1.x) * r.t
      const y = p1.y + (p2.y - p1.y) * r.t
      list.push({ id: r.id, x, y, color: r.color })
    }
    return list
  }, [activeRequests, nodeInternals])

  const [tx, ty, zoom] = transform

  return (
    <div className="absolute inset-0 pointer-events-none">
      <div style={{ transform: `translate(${tx}px, ${ty}px) scale(${zoom})`, transformOrigin: '0 0' }}>
        {packets.map((p) => (
          <div
            key={p.id}
            style={{
              position: 'absolute',
              left: p.x - 5,
              top: p.y - 5,
              width: 10,
              height: 10,
              borderRadius: 9999,
              background: p.color,
              boxShadow: `0 0 14px ${p.color}`,
              opacity: 0.95,
            }}
          />
        ))}
      </div>
    </div>
  )
}

function CDNCanvasInner() {
  const nodes = useCdnStore((s) => s.nodes)
  const edges = useCdnStore((s) => s.edges)
  const tick = useCdnStore((s) => s.tick)
  const nodeTypes = useMemo(() => ({ cdn: CdnNode }), [])

  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const loop = (t) => {
      tick(t - last)
      last = t
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [tick])

  return (
    <div className="relative h-full w-full rounded-xl bg-panel border border-white/10 shadow-glow overflow-hidden">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag
      >
        <Background color="rgba(148,163,184,0.15)" gap={24} />
        <Controls />
        <PacketLayer />
      </ReactFlow>
    </div>
  )
}

export default function CDNCanvas() {
  return (
    <ReactFlowProvider>
      <CDNCanvasInner />
    </ReactFlowProvider>
  )
}
