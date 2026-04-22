from flask import Flask, send_from_directory, request, jsonify
import os
import time
import requests
from datetime import datetime
from dotenv import load_dotenv
load_dotenv()

app = Flask(__name__)

CONTENT_DIR = "content"

# Edge purge endpoints — full URLs from env (local: http://127.0.0.1:3001, deployed: https://xyz.hf.space)
EDGE_NODES = [url for url in [os.getenv("EDGE_URL_A"), os.getenv("EDGE_URL_B"), os.getenv("EDGE_URL_C")] if url]

os.makedirs(CONTENT_DIR, exist_ok=True)

file_metadata = {}


@app.route("/content/<filename>", methods=["GET"])
def get_file(filename):
    version = request.args.get("v", "1")
    file_path = os.path.join(CONTENT_DIR, filename)
    print(f"[ORIGIN] Request for {filename} (v={version})")

    if not os.path.exists(file_path):
        return "File not found", 404

    # Backbone delay: proportional to file size (simulates disk I/O + WAN transfer).
    # Base = 50ms overhead + 1ms per KB, capped at 3s for very large files.
    file_size_bytes = os.path.getsize(file_path)
    file_size_kb = file_size_bytes / 1024
    backbone_delay = min(0.05 + (file_size_kb * 0.001), 3.0)
    time.sleep(backbone_delay)

    response = send_from_directory(CONTENT_DIR, filename)
    response.headers["X-Version"] = version
    response.headers["X-Origin"] = "true"
    response.headers["X-Backbone-Delay-Ms"] = str(round(backbone_delay * 1000))
    response.headers["Content-Length"] = str(file_size_bytes)
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Expose-Headers"] = "X-Version, X-Origin, X-Backbone-Delay-Ms"
    return response


def purge_file(filename, retries=2):
    """Propagate cache invalidation to all edge nodes when a file is updated."""
    failed = []
    for edge in EDGE_NODES:
        try:
            print(f"[PURGE] Sending purge to {edge}")
            requests.delete(f"{edge}/cache/{filename}", timeout=3)
        except Exception as e:
            print(f"[ERROR] Failed purge on {edge}: {e}")
            failed.append(edge)

    if retries > 0 and failed:
        print(f"[RETRY] Retrying failed purges...")
        time.sleep(1)
        for edge in failed:
            try:
                requests.delete(f"{edge}/cache/{filename}", timeout=3)
            except Exception as e:
                print(f"[FINAL FAIL] {edge}: {e}")


@app.route("/content/<filename>", methods=["PUT"])
def upload_file(filename):
    file_path = os.path.join(CONTENT_DIR, filename)
    with open(file_path, "wb") as f:
        f.write(request.data)

    file_metadata[filename] = {
        "last_updated": str(datetime.now()),
        "size": len(request.data)
    }
    print(f"[ORIGIN] Updated {filename}")
    purge_file(filename)

    return jsonify({
        "message": "File updated",
        "metadata": file_metadata[filename]
    }), 200


@app.route("/metrics", methods=["GET"])
def metrics():
    # Count actual files on disk — accurate even after restart
    try:
        disk_files = os.listdir(CONTENT_DIR)
    except Exception:
        disk_files = []
    response = jsonify({
        "total_files": len(disk_files),
        "files": {f: file_metadata.get(f, {"note": "pre-existing"}) for f in disk_files}
    })
    response.headers['Access-Control-Allow-Origin'] = '*'
    return response


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "healthy"})


if __name__ == "__main__":
    app.run(host='0.0.0.0', port=5000, debug=False, threaded=True)
