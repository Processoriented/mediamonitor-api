import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, sqlitePath } from "../config.js";

export type Db = Database.Database;

export function openDb(): Db {
  const cfg = loadConfig();
  const filePath = sqlitePath(cfg);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

