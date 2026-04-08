import express from 'express';
import fetch from 'node-fetch';
import geoip from 'geoip-lite';

const app = express();
const PORT = 4000;

/**
 * Edge Nodes Configuration
 * Notice latency is now 0. It will be calculated dynamically!
 */
let nodes = [
    { name: "A", region: "America", url: "http://192.168.236.181:3001", latency: 0, active: 0, healthy: true },
    { name: "B", region: "Europe",  url: "http://192.168.236.181:3002", latency: 0, active: 0, healthy: true },
    { name: "C", region: "Asia",    url: "http://192.168.236.181:3003", latency: 0, active: 0, healthy: true }
];

/**
 * Sticky Session Map (Upgraded to handle expirations)
 */
const clientMap = new Map();
const STICKY_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

/**
 * Utility: Calculate Score (Lower is better)
 */
function calculateScore(node) {
    let healthPenalty = node.healthy ? 0 : 10000;
    // Score = Actual Network Latency + (Load * Penalty) + Health
    return node.latency + (node.active * 15) + healthPenalty;
}

/**
 * Utility: Get Location from IP
 */

function getClientInfo(req) {
    let clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // Handle multiple IPs (take first one)
    if (clientIp && clientIp.includes(',')) {
        clientIp = clientIp.split(',')[0].trim();
    }

    // Convert IPv6 to IPv4
    if (clientIp && clientIp.startsWith('::ffff:')) {
        clientIp = clientIp.replace('::ffff:', '');
    }

    console.log("IP:", clientIp);

    // LOCALHOST TESTING HACK
    if (!clientIp || clientIp === '127.0.0.1' || clientIp === '::1') {
        const mockIps = ['8.8.8.8', '2.17.79.255', '1.1.1.1'];
        clientIp = mockIps[Math.floor(Math.random() * mockIps.length)];
    }

    const geo = geoip.lookup(clientIp);
    console.log("Geo:", geo);

    let region = "America";
    let country = "Unknown";

    if (geo && geo.country) {
        country = geo.country;

        const europeCountries = ['GB', 'DE', 'FR', 'IT', 'ES', 'NL'];
        const asiaCountries = ['IN', 'JP', 'CN', 'KR', 'SG']; 

        if (asiaCountries.includes(country)) region = "Asia";
        else if (europeCountries.includes(country)) region = "Europe";
    }

    return { ip: clientIp, region, country };
}

/**
 * Choose Best Node
 */
function chooseNode(region, clientId) {
    const routingMap = {
        "Asia": ["C", "B", "A"],
        "Europe": ["B", "A", "C"],
        "America": ["A", "B", "C"]
    };
    
    const candidates = routingMap[region] || routingMap["America"];

    // 1. Sticky session check (with expiration)
    if (clientMap.has(clientId)) {
        const session = clientMap.get(clientId);
        
        if (Date.now() - session.timestamp < STICKY_TTL) {
            let stickyNode = nodes.find(n => n.name === session.nodeName);
            // Ensure node is still alive and not overloaded
            if (stickyNode && stickyNode.active <= 10 && stickyNode.healthy) {
                session.timestamp = Date.now(); // Renew session
                return stickyNode;
            }
        } else {
            clientMap.delete(clientId); // Clear expired session
        }
    }

    // 2. Filter healthy nodes
    let availableNodes = nodes.filter(n =>
        candidates.includes(n.name) &&
        n.active <= 10 &&
        n.healthy
    );

    if (availableNodes.length === 0) return null;

    // 3. Sort by dynamic score (Latency + Load)
    availableNodes.sort((a, b) => calculateScore(a) - calculateScore(b));
    let selected = availableNodes[0];

    // 4. Save sticky mapping
    clientMap.set(clientId, { nodeName: selected.name, timestamp: Date.now() });

    return selected;
}

/**
 * Route Request
 */
app.get('/file/:name', (req, res) => {
    const { ip, region, country } = getClientInfo(req);
    const node = chooseNode(region, ip);

    if (!node) {
        console.error(`[${new Date().toISOString()}] 🚨 503: Network Overloaded or Down`);
        return res.status(503).send("All edge nodes are busy or offline.");
    }

    console.log(`[ROUTE] IP: ${ip} (${region}/${country}) → Node ${node.name} (Latency: ${node.latency}ms)`);
    res.redirect(`${node.url}/file/${req.params.name}`);
});

/**
 * Metrics Endpoint
 */
app.get('/metrics', (req, res) => {
    res.json({
        active_sticky_sessions: clientMap.size,
        nodes: nodes.map(n => ({
            name: n.name,
            region: n.region,
            status: n.healthy ? "ONLINE" : "OFFLINE",
            active_connections: n.active,
            rtt_latency_ms: n.latency
        }))
    });
});

/**
 * Background Health Check (Dynamic Latency + Timeout)
 */
async function checkHealth() {
    for (let node of nodes) {
        const startTime = Date.now();
        
        try {
            // AbortController ensures we don't hang if an edge node freezes
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000); // 3 sec timeout

            const res = await fetch(`${node.url}/health`, { signal: controller.signal });
            clearTimeout(timeout);

            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const data = await res.json();
            const rtt = Date.now() - startTime; // Calculate actual network latency

            node.active = data.active_connections;
            node.latency = rtt;     
            
            if (!node.healthy) {
                console.log(`[HEALTH] 🟢 Node ${node.name} recovered.`);
            }
            node.healthy = true;

        } catch (err) {
            if (node.healthy) {
                console.error(`[HEALTH] 🔴 Node ${node.name} went DOWN! (${err.message})`);
            }
            node.healthy = false;
            node.active = 0;
            node.latency = 9999;
        }
    }
}

// Run health checks every 5 seconds
setInterval(checkHealth, 5000);

/**
 * Start Server
 */
app.listen(PORT,'0.0.0.0', () => {
    console.log(`🚀 Traffic Manager running on http://127.0.0.1:${PORT}`);
    console.log(`📊 View live metrics at http://127.0.0.1:${PORT}/metrics`);
});