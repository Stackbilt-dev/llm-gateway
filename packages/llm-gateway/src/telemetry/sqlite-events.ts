import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { dirname } from "node:path";
import { GatewayRequestEvent } from "../types.js";

// Scaffold transport that persists JSONL to the configured sqlite path location.
// Replace this with real SQLite table inserts in Phase 2.
export class SQLiteEventSink {
  private readonly jsonlPath: string;

  constructor(filePath: string) {
    const absPath = path.resolve(filePath);
    mkdirSync(dirname(absPath), { recursive: true });
    this.jsonlPath = `${absPath}.jsonl`;
  }

  write(event: GatewayRequestEvent): void {
    appendFileSync(this.jsonlPath, `${JSON.stringify(event)}\n`, "utf8");
  }
}
