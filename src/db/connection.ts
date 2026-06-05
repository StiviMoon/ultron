// ── ULTRON v8 — SQLite connection + sqlite-vec ────────────────────────────────

import Database, { type Database as DatabaseType } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { SCHEMA_SQL, VEC_SCHEMA_SQL } from "./schema.js";
import { runMigrations } from "./migrate.js";
import { log } from "../lib/logger.js";

const ULTRON_DIR = process.env.ULTRON_DIR ?? join(homedir(), ".ultron");
const DB_PATH = process.env.ULTRON_DB_PATH ?? join(ULTRON_DIR, "ultron.db");

let vecEnabled = false;

function initDb(): DatabaseType {
  mkdirSync(ULTRON_DIR, { recursive: true });
  const db = new Database(DB_PATH);

  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  // Load sqlite-vec extension. If unavailable, ULTRON still runs in keyword-only mode.
  try {
    sqliteVec.load(db);
    db.exec(VEC_SCHEMA_SQL);
    vecEnabled = true;
    const { v } = db.prepare("SELECT vec_version() AS v").get() as { v: string };
    log.info("sqlite-vec loaded", { version: v });
  } catch (e) {
    vecEnabled = false;
    log.warn("sqlite-vec unavailable — semantic search disabled", { error: String(e) });
  }

  db.exec(SCHEMA_SQL);
  runMigrations(db);

  return db;
}

export const db = initDb();
export const uuid = randomUUID;
export const isVecEnabled = (): boolean => vecEnabled;
