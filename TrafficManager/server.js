import express from 'express';
import fetch from 'node-fetch';
import geoip from 'geoip-lite';
import dotenv from 'dotenv';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { createHash } from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

let nodes = [
    { name: "A", region: "America", url: process.env.EDGE_URL_A || 'http://127.0.0.1:3001', latency: 0, active: 0, healthy: true },
    { name: "B", region: "Europe", url: process.env.EDGE_URL_B || 'http://127.0.0.1:3002', latency: 0, active: 0, healthy: true },
    { name: "C", region: "Asia", url: process.env.EDGE_URL_C || 'http://127.0.0.1:3003', latency: 0, active: 0, healthy: true }
];

// LOCAL_MOCK_IP — used when request comes from localhost.
// Change in .env to test routing for different regions:
//   Asia (India):   103.21.244.0  → routes to Edge C
//   Europe (DE):    5.145.0.0     → routes to Edge B
//   America (US):   8.8.8.8       → routes to Edge A
const LOCAL_MOCK_IP = process.env.LOCAL_MOCK_IP || '103.21.244.0';

const activeViewers = new Map();

function makeClientId(ip) {
    return createHash('md5').update(ip).digest('hex').slice(0, 12);
}

function getClientInfo(req) {
    let clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (clientIp && clientIp.includes(',')) clientIp = clientIp.split(',')[0].trim();
    if (clientIp && clientIp.startsWith('::ffff:')) clientIp = clientIp.replace('::ffff:', '');

    // Use stable mock IP for localhost so local testing shows 1 user, not many
    if (!clientIp || clientIp === '127.0.0.1' || clientIp === '::1') {
        clientIp = LOCAL_MOCK_IP;
    }

    const geo = geoip.lookup(clientIp) || {};
    let region = 'America', country = 'US', lat = 37.09, lon = -95.71;

    if (geo.country) {
        country = geo.country;
        lat = geo.ll?.[0] ?? lat;
        lon = geo.ll?.[1] ?? lon;

        const europeCountries = ['GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'SE', 'NO', 'DK', 'FI', 'PL', 'PT'];
        const asiaCountries = ['IN', 'JP', 'CN', 'KR', 'SG', 'TH', 'ID', 'MY', 'PH', 'VN', 'BD', 'PK'];

        if (asiaCountries.includes(country)) region = 'Asia';
        else if (europeCountries.includes(country)) region = 'Europe';
    }

    return { ip: clientIp, clientId: makeClientId(clientIp), region, country, lat, lon };
}

// ─────────────────────────────────────────────────────────────────────────────
//  LOAD BALANCING — Weighted Probabilistic Geo Routing with Request Momentum
//
//  Two signals lower a node's weight so traffic shifts away from busy nodes:
//   1. active     — real-time concurrent requests (resets instantly on completion)
//   2. recentReqs — accumulates per request, decays -1 every 2s (momentum)
//
//  Momentum is needed because cache HITs finish in ~50ms — active drops to 0
//  before the next request arrives. Without momentum every request would always
//  pick the geo-nearest node. With it, traffic visibly spreads across all nodes.
//
//  Formula: weight = geo_base / (1 + active + recentReqs × 0.4)
//
//  Default split (Asia user, idle):  C=57%  B=29%  A=14%
//  After 5 hits to C (momentum=5):   C=27%  B=40%  A=20%  ← load redistributed
//  Decay: -1 every 2s → resets to default after ~10s idle
// ─────────────────────────────────────────────────────────────────────────────

const ROUTING_PRIORITY = {
    "Asia": ["C", "B", "A"],
    "Europe": ["B", "A", "C"],
    "America": ["A", "B", "C"]
};

const GEO_BASE_WEIGHTS = [4, 2, 1];  // index 0 = nearest, 2 = furthest

nodes.forEach(n => { n.recentReqs = 0; });

setInterval(() => {
    nodes.forEach(n => { n.recentReqs = Math.max(0, n.recentReqs - 1); });
}, 2000);

function healthyNodes() {
    return nodes.filter(n => n.healthy && n.active < 3);
}

function chooseNode(region) {
    const priority = ROUTING_PRIORITY[region] || ROUTING_PRIORITY["America"];
    const available = healthyNodes();
    if (!available.length) return null;

    const weighted = available.map(n => {
        const geoRank = Math.max(0, priority.indexOf(n.name));
        const baseWeight = GEO_BASE_WEIGHTS[geoRank] ?? 1;
        const load = n.active + (n.recentReqs * 0.4);
        return { node: n, weight: baseWeight / (1 + load) };
    });

    const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0);
    let rand = Math.random() * totalWeight;
    for (const w of weighted) {
        rand -= w.weight;
        if (rand <= 0) return w.node;
    }
    return weighted[weighted.length - 1].node;
}


app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Expose-Headers", "X-Cache, X-Edge-Node, X-Client-Id");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Returns the caller's stable clientId + geo.
// Frontend calls this once on mount so it knows its own ID before any fetch,
// eliminating the race condition between HTTP response and socket broadcast.
app.get('/me', (req, res) => {
    const info = getClientInfo(req);
    res.json({ clientId: info.clientId, country: info.country, region: info.region, lat: info.lat, lon: info.lon });
});

app.get('/lb/info', (req, res) => {
    res.json({
        algorithm: 'weighted-probabilistic-geo-routing-with-momentum',
        nodes: nodes.map(n => ({
            name: n.name, region: n.region, healthy: n.healthy,
            active: n.active, momentum: n.recentReqs, latency: n.latency,
            status: n.healthy ? (n.active >= 2 ? 'AT_CAPACITY' : 'ONLINE') : 'OFFLINE'
        }))
    });
});


// Reverse proxy to chosen edge node.
// node.active is incremented HERE (before forwarding) so chooseNode() always
// sees the accurate live concurrency count, not a stale health-check value.
app.get('/file/:name', async (req, res) => {
    const clientInfo = getClientInfo(req);
    let region = req.query.region || clientInfo.region;
    if (!['America', 'Europe', 'Asia'].includes(region)) region = 'America';

    const node = chooseNode(region);
    if (!node) {
        console.error(`[503] All nodes overloaded or offline`);
        return res.status(503).send("All edge nodes are busy or offline.");
    }

    node.active++;
    node.recentReqs++;
    console.log(`[ROUTE] ${clientInfo.country}/${region} → Node ${node.name} | active=${node.active} momentum=${node.recentReqs}`);

    const startTime = Date.now();
    const edgeUrl = `${node.url}/file/${req.params.name}?clientId=${clientInfo.clientId}&nodeName=${node.name}`;

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        const edgeRes = await fetch(edgeUrl, { signal: controller.signal });
        clearTimeout(timeout);

        const latencyMs = Date.now() - startTime;
        const cacheStatus = edgeRes.headers.get('X-Cache') || 'MISS';
        const contentType = edgeRes.headers.get('content-type') || 'application/octet-stream';
        const body = Buffer.from(await edgeRes.arrayBuffer());

        res.status(edgeRes.status);
        res.header('Content-Type', contentType);
        res.header('X-Cache', cacheStatus);
        res.header('X-Edge-Node', node.name);
        res.header('X-Client-Id', clientInfo.clientId);
        res.send(body);

        const edgeIdMap = { A: 'edge-us-east', B: 'edge-eu-central', C: 'edge-ap-south' };
        if (global.io) {
            global.io.emit('cdn:request', {
                userKey: clientInfo.clientId,
                clientId: clientInfo.clientId,
                sourceSocketId: null,
                coords: { lat: clientInfo.lat, lon: clientInfo.lon },
                region: clientInfo.region,
                country: clientInfo.country,
                fileName: req.params.name,
                cacheStatus,
                forceEdgeId: edgeIdMap[node.name] || null,
                edgeId: edgeIdMap[node.name] || null,
                latencyMs,
            });
        }

    } catch (err) {
        if (err.name === 'AbortError') {
            console.error(`[TIMEOUT] Node ${node.name} timed out`);
            return res.status(504).send("Edge node timed out.");
        }
        console.error(`[ERROR] Node ${node.name}: ${err.message}`);
        return res.status(502).send("Edge node unreachable.");
    } finally {
        // Decrement after response — keeps count accurate regardless of success/error
        node.active = Math.max(0, node.active - 1);
    }
});


app.get('/metrics', (req, res) => {
    let totalHits = 0, totalMisses = 0, totalCacheSize = 0;

    const mappedNodes = nodes.map(n => {
        totalHits += (n.hits || 0);
        totalMisses += (n.misses || 0);
        totalCacheSize += (n.cache_size || 0);
        return {
            name: n.name, region: n.region,
            status: n.healthy ? "ONLINE" : "OFFLINE",
            active_connections: n.active,
            rtt_latency_ms: n.latency,
            hits: n.hits || 0, misses: n.misses || 0, cache_size: n.cache_size || 0
        };
    });

    res.json({ nodes: mappedNodes, global_hits: totalHits, global_misses: totalMisses, global_cache_size: totalCacheSize });
});


async function checkHealth() {
    for (let node of nodes) {
        const startTime = Date.now();
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);
            const res = await fetch(`${node.url}/health`, { signal: controller.signal });
            clearTimeout(timeout);

            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const rtt = Date.now() - startTime;

            // Health checks update latency + cache metrics only.
            // Do NOT overwrite node.active — it is tracked in real-time by the proxy handler.
            node.latency = rtt;
            node.hits = data.hits || 0;
            node.misses = data.misses || 0;
            node.cache_size = data.cache_size || 0;

            if (!node.healthy) console.log(`[HEALTH] Node ${node.name} recovered.`);
            node.healthy = true;

        } catch (err) {
            if (node.healthy) console.error(`[HEALTH] Node ${node.name} went DOWN! (${err.message})`);
            node.healthy = false;
            node.latency = 9999;
            node.active = 0;  // Reset if node crashed mid-request
        }
    }

    // Push metrics to all connected viewers via socket (avoids frontend polling)
    if (global.io) {
        let totalHits = 0, totalMisses = 0, totalCacheSize = 0;
        const mappedNodes = nodes.map(n => {
            totalHits += (n.hits || 0);
            totalMisses += (n.misses || 0);
            totalCacheSize += (n.cache_size || 0);
            return {
                name: n.name, region: n.region,
                status: n.healthy ? "ONLINE" : "OFFLINE",
                active_connections: n.active,
                rtt_latency_ms: n.latency,
                hits: n.hits || 0, misses: n.misses || 0, cache_size: n.cache_size || 0
            };
        });
        global.io.emit('cdn:metrics', { nodes: mappedNodes, global_hits: totalHits, global_misses: totalMisses, global_cache_size: totalCacheSize });
    }
}

setInterval(checkHealth, 5000);


const server = http.createServer(app);
global.io = new SocketIOServer(server, { cors: { origin: '*' } });

global.io.on('connection', (socket) => {
    activeViewers.set(socket.id, { connectedAt: Date.now() });
    console.log(`[SOCKET] Connected: ${socket.id} | Viewers: ${activeViewers.size}`);
    socket.broadcast.emit('cdn:log', { message: `New viewer connected (${socket.id.slice(0, 6)})` });

    socket.on('cdn:request', (payload) => {
        if (!payload || !payload.coords) return;
        socket.broadcast.emit('cdn:request', payload);
    });

    socket.on('disconnect', () => {
        activeViewers.delete(socket.id);
        console.log(`[SOCKET] Disconnected: ${socket.id} | Viewers: ${activeViewers.size}`);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Traffic Manager running on ${PORT}`);
    console.log(`View live metrics at http://0.0.0.0:${PORT}/metrics`);
});