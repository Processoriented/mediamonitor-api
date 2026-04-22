import fs from "node:fs";
import path from "node:path";
import { openDb } from "./db.js";

type MigrationRow = {
  id: number;
  name: string;
  applied_at: string;
};

function ensureMigrationsTable() {
  const db = openDb();
  db.exec(`
    create table if not exists migrations (
      id integer primary key autoincrement,
      name text not null unique,
      applied_at text not null
    );
  `);
  db.close();
}

function appliedMigrations(dbPath: string): Set<string> {
  const db = openDb();
  const rows = db.prepare("select name from migrations order by id asc").all() as { name: string }[];
  db.close();
  return new Set(rows.map((r) => r.name));
}

export function runMigrations() {
  ensureMigrationsTable();

  const migrationsDir = path.resolve(process.cwd(), "src/db/migrations");
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const already = appliedMigrations("");
  const db = openDb();

  const insert = db.prepare("insert into migrations (name, applied_at) values (?, ?)");

  for (const file of files) {
    if (already.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      insert.run(file, new Date().toISOString());
    })();
  }

  db.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations();
}

