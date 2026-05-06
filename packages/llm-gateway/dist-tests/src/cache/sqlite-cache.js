import { mkdirSync } from "node:fs";
import path from "node:path";
import { dirname } from "node:path";
// SQLite-backed behavior is intentionally deferred while the MVP scaffold is bootstrapped.
// This class preserves interface boundaries so storage can be swapped to real SQLite next.
export class SQLiteCache {
    filePath;
    prefixCache = new Map();
    responseCache = new Map();
    constructor(filePath) {
        this.filePath = filePath;
        const absPath = path.resolve(filePath);
        mkdirSync(dirname(absPath), { recursive: true });
    }
    getPrefix(key) {
        return this.prefixCache.get(key);
    }
    setPrefix(key, value) {
        this.prefixCache.set(key, value);
    }
    getResponse(key) {
        return this.responseCache.get(key);
    }
    setResponse(key, value) {
        this.responseCache.set(key, value);
    }
}
