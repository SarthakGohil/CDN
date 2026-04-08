import time
class Cache:
    def __init__(self, max_size=5, ttl=60):
        self.store = {}
        self.max_size = max_size
        self.ttl = ttl

    def get(self, key):
        if key in self.store:
            data, timestamp, last_used = self.store[key]

            # TTL check
            if time.time() - timestamp > self.ttl:
                del self.store[key]
                return None

            # Update LRU
            self.store[key] = (data, timestamp, time.time())
            return data

        return None

    def set(self, key, data):
        # If cache full → remove LRU
        if key in self.store:
            self.store[key] = (data, time.time(), time.time())
            return
        if len(self.store) >= self.max_size:
            lru_key = min(self.store.items(), key=lambda x: x[1][2])[0]
            del self.store[lru_key]

        self.store[key] = (data, time.time(), time.time())

    def delete(self, key):
        if key in self.store:
            del self.store[key]

