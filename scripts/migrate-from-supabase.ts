/**
 * One-time migration: Supabase → local SQLite
 * Run: npx tsx scripts/migrate-from-supabase.ts
 */
import { createClient } from "@supabase/supabase-js";
import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, "..", ".env") });

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// SQLite setup
const ULTRON_DIR = join(homedir(), ".ultron");
mkdirSync(ULTRON_DIR, { recursive: true });
const DB_PATH = join(ULTRON_DIR, "ultron.db");
const db = new Database(DB_PATH);

console.log(`Migrating from Supabase to ${DB_PATH}...\n`);

// Fetch all data from Supabase
const [
  { data: memories, error: e1 },
  { data: sessions, error: e2 },
  { data: decisions, error: e3 },
  { data: tasks, error: e4 },
] = await Promise.all([
  supabase.from("memories").select("*"),
  supabase.from("sessions").select("*"),
  supabase.from("decisions").select("*"),
  supabase.from("tasks").select("*"),
]);

if (e1 || e2 || e3 || e4) {
  console.error("Supabase errors:", { e1, e2, e3, e4 });
  process.exit(1);
}

console.log(`Found: ${memories?.length ?? 0} memories, ${sessions?.length ?? 0} sessions, ${decisions?.length ?? 0} decisions, ${tasks?.length ?? 0} tasks`);

// Import into SQLite using transactions
const importAll = db.transaction(() => {
  let counts = { memories: 0, sessions: 0, decisions: 0, tasks: 0 };

  // Memories
  const memStmt = db.prepare(
    `INSERT INTO memories (id, project, key, value, category, tool, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project, key) DO UPDATE SET
       value = excluded.value,
       category = excluded.category,
       tool = excluded.tool,
       updated_at = excluded.updated_at`
  );
  for (const m of memories ?? []) {
    memStmt.run(m.id, m.project, m.key, m.value, m.category, m.tool, m.expires_at, m.created_at, m.updated_at);
    counts.memories++;
  }

  // Sessions
  const sesStmt = db.prepare(
    `INSERT OR IGNORE INTO sessions (id, project, tool, summary, files, started_at, ended_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const s of sessions ?? []) {
    const files = Array.isArray(s.files) ? JSON.stringify(s.files) : (s.files ?? "[]");
    sesStmt.run(s.id, s.project, s.tool, s.summary, files, s.started_at, s.ended_at, s.created_at);
    counts.sessions++;
  }

  // Decisions
  const decStmt = db.prepare(
    `INSERT OR IGNORE INTO decisions (id, project, topic, choice, reason, tool, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const d of decisions ?? []) {
    decStmt.run(d.id, d.project, d.topic, d.choice, d.reason, d.tool, d.created_at);
    counts.decisions++;
  }

  // Tasks
  const taskStmt = db.prepare(
    `INSERT OR IGNORE INTO tasks (id, project, text, status, priority, tool, created_at, done_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const t of tasks ?? []) {
    taskStmt.run(t.id, t.project, t.text, t.status, t.priority, t.tool, t.created_at, t.done_at);
    counts.tasks++;
  }

  return counts;
});

const counts = importAll();
console.log("\nMigration complete:");
console.log(`  Memories:  ${counts.memories}`);
console.log(`  Sessions:  ${counts.sessions}`);
console.log(`  Decisions: ${counts.decisions}`);
console.log(`  Tasks:     ${counts.tasks}`);
console.log(`\nData saved to: ${DB_PATH}`);
