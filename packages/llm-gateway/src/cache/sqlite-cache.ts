import { mkdirSync } from "node:fs";
import path from "node:path";
import { dirname } from "node:path";

// SQLite-backed behavior is intentionally deferred while the MVP scaffold is bootstrapped.
// This class preserves interface boundaries so storage can be swapped to real SQLite next.
export class SQLiteCache {
  private readonly prefixCache = new Map<string, string>();
  private readonly responseCache = new Map<string, string>();

  constructor(private readonly filePath: string) {
    const absPath = path.resolve(filePath);
    mkdirSync(dirname(absPath), { recursive: true });
  }

  getPrefix(key: string): string | undefined {
    return this.prefixCache.get(key);
  }

  setPrefix(key: string, value: string): void {
    this.prefixCache.set(key, value);
  }

  getResponse(key: string): string | undefined {
    return this.responseCache.get(key);
  }

  setResponse(key: string, value: string): void {
    this.responseCache.set(key, value);
  }
}
