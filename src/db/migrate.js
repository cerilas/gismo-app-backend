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

-- ─────────────────────────────────────────────
-- USERS TABLE
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name       TEXT,
  email           TEXT UNIQUE,
  phone           TEXT UNIQUE,
  password_hash   TEXT,
  google_id       TEXT UNIQUE,
  apple_id        TEXT UNIQUE,
  avatar_url      TEXT,
  phone_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  auth_provider   TEXT NOT NULL DEFAULT 'phone_email',
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_login_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_id TEXT UNIQUE;

CREATE INDEX IF NOT EXISTS idx_users_email
  ON users(LOWER(email));

CREATE INDEX IF NOT EXISTS idx_users_phone
  ON users(phone);

CREATE INDEX IF NOT EXISTS idx_users_google_id
  ON users(google_id);

CREATE INDEX IF NOT EXISTS idx_users_apple_id
  ON users(apple_id);

-- ─────────────────────────────────────────────
-- PHONE VERIFICATION CODES (OTP) TABLE
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS phone_verification_codes (
  id          SERIAL PRIMARY KEY,
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  phone       TEXT NOT NULL,
  code        TEXT NOT NULL,
  purpose     TEXT NOT NULL DEFAULT 'register',
  verified    BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at  TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_phone_verification_lookup
  ON phone_verification_codes(phone, code, verified);

-- ─────────────────────────────────────────────
-- CERILAS SMS SETTINGS TABLE
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sms_settings (
  id              SERIAL PRIMARY KEY,
  netgsm_usercode TEXT NOT NULL,
  netgsm_password TEXT NOT NULL,
  netgsm_header   TEXT NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

INSERT INTO sms_settings (id, netgsm_usercode, netgsm_password, netgsm_header, is_active)
VALUES (1, '8503044989', 'Dnz.24232423', 'CERILAS AS', TRUE)
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────
-- USER MEMORIES TABLE (Gismo Permanent Memory)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_memories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  device_id   TEXT,
  category    TEXT NOT NULL DEFAULT 'note',
  subject     TEXT NOT NULL,
  content     TEXT NOT NULL,
  updated_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_memories_user
  ON user_memories(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_memories_device
  ON user_memories(device_id, updated_at DESC);
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
