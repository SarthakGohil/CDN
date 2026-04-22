import sys
import requests
import threading
import time
from flask import Flask, jsonify, Response
from cache_module import Cache
from dotenv import load_dotenv
import os

load_dotenv()

app = Flask(__name__)

# Local: ORIGIN_URL=http://127.0.0.1 → appends :5000
# Deployed: ORIGIN_URL=https://your-origin.hf.space → used as-is
_raw_origin = os.getenv("ORIGIN_URL", "http://127.0.0.1")
ORIGIN_URL = _raw_origin if (_raw_origin.startswith("https://") or ":" in _raw_origin.split("//")[-1]) else _raw_origin + ":5000"

active_connections = 0
conn_lock = threading.Lock()

cache_hits = 0
cache_misses = 0
metrics_lock = threading.Lock()

# max_size=20 so multiple unique users each have their own warm cache slot
cache = Cache(max_size=20, ttl=60)


@app.route('/health', methods=['GET'])
def health():
    with conn_lock:
        current_active = active_connections
    with metrics_lock:
        current_hits = cache_hits
        current_misses = cache_misses
        current_cache_size = len(cache.store)
    return jsonify({
        "active_connections": current_active,
        "status": "healthy",
        "hits": current_hits,
        "misses": current_misses,
        "cache_size": current_cache_size
    }), 200


@app.route('/cache/<filename>', methods=['DELETE'])
def purge_cache(filename):
    # Purge all per-user slots for this filename
    keys_to_delete = [k for k in list(cache.store.keys()) if k.endswith(f":{filename}")]
    for k in keys_to_delete:
        cache.delete(k)
    if not keys_to_delete:
        cache.delete(filename)
    return jsonify({"status": "purged", "file": filename}), 200


@app.route('/metrics', methods=['GET'])
def metrics():
    with metrics_lock:
        total = cache_hits + cache_misses
        hit_ratio = cache_hits / total if total > 0 else 0
        return jsonify({
            "hits": cache_hits,
            "misses": cache_misses,
            "hit_ratio": hit_ratio,
            "cache_size": len(cache.store)
        })


@app.route('/file/<filename>', methods=['GET'])
def get_file(filename):
    from flask import request as flask_request
    client_id = flask_request.args.get('clientId', 'shared')
    node_name = flask_request.args.get('nodeName', '')

    # Per-user cache key — each client gets an independent warm slot
    cache_key = f"{client_id}:{filename}"

    global active_connections
    print(f"Received request for {filename} (client={client_id})")

    # Load shedding: reject if at capacity (keeps latency predictable under burst)
    with conn_lock:
        if active_connections >= 2:
            print(f"[BUSY] Rejecting {filename} — at capacity (2 active)")
            return "BUSY", 503
        active_connections += 1
        print(f"[IN] {filename} | Active: {active_connections}")

    try:
        cached_content = cache.get(cache_key)

        if cached_content is not None:
            print(f"[CACHE HIT] {filename} for client {client_id}")
            global cache_hits
            with metrics_lock:
                cache_hits += 1

            time.sleep(0.1)  # Simulate in-memory read latency

            response = Response(cached_content)
            response.headers['X-Cache'] = 'HIT'
            response.headers['Access-Control-Allow-Origin'] = '*'
            if node_name:
                response.headers['X-Edge-Node'] = node_name
                response.headers['Access-Control-Expose-Headers'] = 'X-Cache, X-Edge-Node'
            else:
                response.headers['Access-Control-Expose-Headers'] = 'X-Cache'
            return response

        # Cache MISS — fetch from origin and populate the cache
        print(f"[CACHE MISS] {filename} for client {client_id}")
        global cache_misses
        with metrics_lock:
            cache_misses += 1
        try:
            origin_resp = requests.get(f"{ORIGIN_URL}/content/{filename}", timeout=20)
            if origin_resp.status_code != 200:
                return "Origin file not found", origin_resp.status_code
            content = origin_resp.content
        except requests.exceptions.RequestException:
            return "Origin unreachable", 502

        cache.set(cache_key, content)

        response = Response(content)
        response.headers['X-Cache'] = 'MISS'
        response.headers['Access-Control-Allow-Origin'] = '*'
        if node_name:
            response.headers['X-Edge-Node'] = node_name
            response.headers['Access-Control-Expose-Headers'] = 'X-Cache, X-Edge-Node'
        else:
            response.headers['Access-Control-Expose-Headers'] = 'X-Cache'
        return response

    finally:
        with conn_lock:
            active_connections -= 1
            print(f"[OUT] {filename} | Active: {active_connections}")


if __name__ == '__main__':
    # Port resolution: $PORT env var (HF/Railway) → argv (local) → default 3001
    port = int(os.getenv('PORT') or (sys.argv[1] if len(sys.argv) > 1 else 3001))
    print(f"[EDGE] Starting on port {port} | Node: {os.getenv('NODE_NAME', '?')} | Origin: {ORIGIN_URL}")
    app.run(host='0.0.0.0', port=port, threaded=True)