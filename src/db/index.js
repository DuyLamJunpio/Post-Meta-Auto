const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

// Tầng truy cập SQLite dùng module tích hợp node:sqlite (Node >= 22).
// Đường dẫn DB: DATABASE_PATH hoặc <root>/data/app.db.

const DEFAULT_DB_PATH = path.join(__dirname, "..", "..", "data", "app.db");
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

let db = null;

function getDatabasePath() {
  return process.env.DATABASE_PATH || DEFAULT_DB_PATH;
}

function ensureDirectory(filePath) {
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function ensureMigrationsTable(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}

function getAppliedMigrations(database) {
  const rows = database.prepare("SELECT version FROM schema_migrations").all();
  return new Set(rows.map((row) => row.version));
}

function runMigrations(database) {
  ensureMigrationsTable(database);

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return;
  }

  const applied = getAppliedMigrations(database);
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const insertMigration = database.prepare(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)"
  );

  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");

    database.exec("BEGIN");
    try {
      database.exec(sql);
      insertMigration.run(file, new Date().toISOString());
      database.exec("COMMIT");
      console.log("[DB] Đã áp dụng migration:", file);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

function initDatabase() {
  if (db) {
    return db;
  }

  const dbPath = getDatabasePath();
  ensureDirectory(dbPath);

  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  runMigrations(db);

  return db;
}

function getDb() {
  return db || initDatabase();
}

module.exports = {
  initDatabase,
  getDb,
  getDatabasePath
};
