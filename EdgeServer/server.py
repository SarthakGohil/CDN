import sys
import requests
import threading
import time # <--- ADD THIS
from flask import Flask, jsonify, Response
from cache_module import Cache

app = Flask(__name__)

# --- CONFIGURATION ---
ORIGIN_URL = "http://192.168.236.181:5000" 

# --- LOAD MANAGEMENT STATE ---
active_connections = 0
conn_lock = threading.Lock()



cache = Cache(max_size=5,ttl=60)

# --- APIs ---

@app.route('/health', methods=['GET'])
def health():
    # Traffic Manager (code1) expects JSON with 'active_connections'
    with conn_lock:
        current_active = active_connections
    return jsonify({"active_connections": current_active, "status": "healthy"}), 200

@app.route('/cache/<filename>', methods=['DELETE'])
def purge_cache(filename):
    cache.delete(filename)
    return jsonify({"status": "purged", "file": filename}), 200

@app.route('/file/<filename>', methods=['GET'])
def get_file(filename):
    global active_connections
    print(f"Received request for {filename}")
    # 1. Load Shedding Check
    with conn_lock:
        if active_connections >= 10:
            print(f"[BUSY] Rejecting {filename}")
            return "BUSY", 503
        active_connections += 1
        print(f"[IN] {filename} | Active: {active_connections}")

    try:
        # 2. Check Cache
        cached_content = cache.get(filename)

        if cached_content is not None:
            # CASE 1: CACHE HIT
            print(f"[CACHE HIT] {filename}")
            time.sleep(0.1)
            response = Response(cached_content)
            response.headers['X-Cache'] = 'HIT'
            return response

        # 3. CASE 2: CACHE MISS
        print(f"[CACHE MISS] {filename}")
        try:
            # Origin (code2) takes 2 seconds to respond, timeout set to 10s to be safe
            origin_resp = requests.get(f"{ORIGIN_URL}/content/{filename}", timeout=10)
            if origin_resp.status_code != 200:
                return "Origin file not found", origin_resp.status_code
            content = origin_resp.content
        except requests.exceptions.RequestException:
            return "Origin unreachable", 502

        # Delay is removed here because code2 handles the 2-second sleep natively
        cache.set(filename, content)

        response = Response(content)
        response.headers['X-Cache'] = 'MISS'
        return response

    finally:
        # 4. Release Connection Count
        with conn_lock:
            active_connections -= 1
            print(f"[OUT] {filename} | Active: {active_connections}")

if __name__ == '__main__':
    # Ports required by Traffic Manager: 3001, 3002, 3003
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3001
    app.run(host='0.0.0.0', port=port, threaded=True)