# CDN Simulator

A distributed CDN system built for my DC (Distributed Computing) lab project. It simulates how a real Content Delivery Network routes user requests to the nearest edge server based on geographic location and server load.

---

## What it does

- Client request goes to the Traffic Manager
- TM figures out where the client is (GeoIP) and picks the best edge server
- Edge serves the file from cache (HIT) or fetches from origin (MISS)
- Real-time dashboard shows live routing, node status, cache hits/misses

## Architecture

```
Client → Traffic Manager → Edge Server (A/B/C) → Origin Server
                    ↘ Socket.io ↗
                   Frontend Dashboard
```

- **Origin Server** — stores actual files, acts as source of truth
- **Edge Servers** (3 nodes) — cache files close to users; Node A (US), B (EU), C (Asia)
- **Traffic Manager** — load balancer + GeoIP router + metrics broadcaster
- **Frontend** — real-time map showing live request routing

## Load Balancing

Uses **Weighted Probabilistic Geo Routing with Request Momentum**.

Each node has a weight based on geographic proximity to the client:
- Nearest node → base weight 4
- Second → base weight 2  
- Farthest → base weight 1

Weight decreases as node gets busy:
```
weight = geo_base / (1 + active_connections + recent_requests × 0.4)
```

"Momentum" prevents all requests going to one node even when requests finish fast (cache hits). It decays every 2 seconds so routing rebalances automatically when load is low.

## Tech Stack

| Component | Tech |
|-----------|------|
| Origin Server | Python + Flask |
| Edge Servers | Python + Flask |
| Traffic Manager | Node.js + Express + Socket.io |
| Frontend | Next.js + React Flow + Zustand |
| GeoIP | geoip-lite |

## Running Locally

**1. Start Origin Server**
```bash
cd OriginServer
python server.py
```

**2. Start 3 Edge Servers** (separate terminals)
```bash
cd EdgeServer
python server.py 3001
python server.py 3002
python server.py 3003
```

**3. Start Traffic Manager**
```bash
cd TrafficManager
node server.js
```

**4. Start Frontend**
```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:3000`

## Environment Variables

**TrafficManager/.env**
```
EDGE_URL_A=http://127.0.0.1:3001
EDGE_URL_B=http://127.0.0.1:3002
EDGE_URL_C=http://127.0.0.1:3003
LOCAL_MOCK_IP=103.21.244.0
```

Change `LOCAL_MOCK_IP` to test routing from different regions:
- `103.21.244.0` → India (routes to Edge C)
- `5.145.0.0` → Germany (routes to Edge B)
- `8.8.8.8` → USA (routes to Edge A)

**EdgeServer/.env**
```
NODE_NAME=C
ORIGIN_URL=http://127.0.0.1
```