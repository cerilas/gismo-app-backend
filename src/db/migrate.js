const pool = require('./pool');

const MIGRATION_SQL = `
-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────────────────────────
-- ROBOTS TABLE
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS robots (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  last_ip     TEXT,
  is_online   BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen   TIMESTAMP WITH TIME ZONE,
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- COMMANDS TABLE
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commands (
  id          SERIAL PRIMARY KEY,
  robot_id    UUID NOT NULL REFERENCES robots(id) ON DELETE CASCADE,
  command     CHAR(1) NOT NULL CHECK (command IN ('F','B','L','R','S')),
  executed    BOOLEAN NOT NULL DEFAULT FALSE,
  executed_at TIMESTAMP WITH TIME ZONE,
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for fast polling
CREATE INDEX IF NOT EXISTS idx_commands_robot_pending
  ON commands(robot_id, executed)
  WHERE executed = FALSE;

CREATE INDEX IF NOT EXISTS idx_commands_robot_created
  ON commands(robot_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_robots_online
  ON robots(is_online);
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🔄 Running DB migrations...');
    await client.query(MIGRATION_SQL);
    console.log('✅ DB migrations complete');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

// Run directly: node src/db/migrate.js
if (require.main === module) {
  require('dotenv').config();
  migrate()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { migrate };
