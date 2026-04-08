from flask import Flask, send_from_directory, request, jsonify
import os
import time
import requests
from datetime import datetime

app = Flask(__name__)

CONTENT_DIR = "content"

# Edge purge endpoints
EDGE_NODES = [
    "http://192.168.236.181:3001",
    "http://192.168.236.181:3002",
    "http://192.168.236.181:3003"
]

os.makedirs(CONTENT_DIR, exist_ok=True)

# Store metadata (for versioning/debugging)
file_metadata = {}

# -------------------------------
# GET FILE (with version support)
# -------------------------------
@app.route("/content/<filename>", methods=["GET"])
def get_file(filename):
    version = request.args.get("v", "1")  # default version

    file_path = os.path.join(CONTENT_DIR, filename)
    print(f"[ORIGIN] Request for {filename} (v={version})")

    if not os.path.exists(file_path):
        return "File not found", 404

    # Simulate slow backbone
    time.sleep(2)

    response = send_from_directory(CONTENT_DIR, filename)
    response.headers["X-Version"] = version
    response.headers["X-Origin"] = "true"

    return response


# -------------------------------
# PURGE FUNCTION (with retry)
# -------------------------------
def purge_file(filename, retries=2):
    failed = []

    for edge in EDGE_NODES:
        try:
            print(f"[PURGE] Sending purge to {edge}")
            requests.delete(f"{edge}/cache/{filename}", timeout=3)
        except Exception as e:
            print(f"[ERROR] Failed purge on {edge}: {e}")
            failed.append(edge)

    # Retry failed edges
    if retries > 0 and failed:
        print(f"[RETRY] Retrying failed purges...")
        time.sleep(1)
        for edge in failed:
            try:
                requests.delete(f"{edge}/cache/{filename}", timeout=3)
            except Exception as e:
                print(f"[FINAL FAIL] {edge}: {e}")


# -------------------------------
# UPLOAD / UPDATE FILE
# -------------------------------
@app.route("/content/<filename>", methods=["PUT"])
def upload_file(filename):
    file_path = os.path.join(CONTENT_DIR, filename)

    with open(file_path, "wb") as f:
        f.write(request.data)

    # Update metadata
    file_metadata[filename] = {
        "last_updated": str(datetime.now()),
        "size": len(request.data)
    }

    print(f"[ORIGIN] Updated {filename}")

    # Trigger purge
    purge_file(filename)

    return jsonify({
        "message": "File updated",
        "metadata": file_metadata[filename]
    }), 200


# -------------------------------
# METRICS (for debugging)
# -------------------------------
@app.route("/metrics", methods=["GET"])
def metrics():
    return jsonify({
        "total_files": len(file_metadata),
        "files": file_metadata
    })


# -------------------------------
# HEALTH CHECK
# -------------------------------
@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "healthy"})


# -------------------------------
# RUN SERVER
# -------------------------------
if __name__ == "__main__":
    app.run(host='0.0.0.0', port=5000, debug=True)