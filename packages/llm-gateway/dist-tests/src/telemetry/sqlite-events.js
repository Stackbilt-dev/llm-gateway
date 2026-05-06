import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { dirname } from "node:path";
// Scaffold transport that persists JSONL to the configured sqlite path location.
// Replace this with real SQLite table inserts in Phase 2.
export class SQLiteEventSink {
    jsonlPath;
    constructor(filePath) {
        const absPath = path.resolve(filePath);
        mkdirSync(dirname(absPath), { recursive: true });
        this.jsonlPath = `${absPath}.jsonl`;
    }
    write(event) {
        appendFileSync(this.jsonlPath, `${JSON.stringify(event)}\n`, "utf8");
    }
}
