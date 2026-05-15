const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { sendCommand } = require('../ws/hub');

// Valid command characters
const VALID_COMMANDS = new Set(['F', 'B', 'L', 'R', 'S']);

// ─────────────────────────────────────────────
// POST /api/commands — Send a command (from iOS)
// Body: { robot_id: UUID, command: 'F'|'B'|'L'|'R'|'S' }
// ─────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { robot_id, command } = req.body;

  if (!robot_id) {
    return res.status(400).json({ error: 'Validation error', message: 'robot_id is required' });
  }
  if (!command || !VALID_COMMANDS.has(command.toUpperCase())) {
    return res.status(400).json({
      error: 'Validation error',
      message: `command must be one of: ${[...VALID_COMMANDS].join(', ')}`
    });
  }

  try {
    const data = await sendCommand(robot_id, command);
    res.status(201).json({ success: true, data });
  } catch (err) {
    console.error('POST /commands error:', err.message);
    // Handle FK violation (robot not found)
    if (err.code === '23503') {
      return res.status(404).json({ error: 'Not found', message: 'Robot not found' });
    }
    res.status(500).json({ error: 'Database error', message: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/commands/pending/:robotId
// Returns the oldest unexecuted command for this robot.
// Called by ESP32 via polling (every ~100ms).
// ─────────────────────────────────────────────
router.get('/pending/:robotId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, command, created_at
       FROM commands
       WHERE robot_id = $1
         AND executed = FALSE
       ORDER BY created_at ASC
       LIMIT 1`,
      [req.params.robotId]
    );

    if (rows.length === 0) {
      // No pending command → robot should stop
      return res.json({ success: true, data: null, command: null });
    }

    res.json({ success: true, data: rows[0], command: rows[0].command });
  } catch (err) {
    console.error('GET /commands/pending/:id error:', err.message);
    res.status(500).json({ error: 'Database error', message: err.message });
  }
});

// ─────────────────────────────────────────────
// PUT /api/commands/:id/done
// Mark command as executed (called by ESP32 after running the command).
// ─────────────────────────────────────────────
router.put('/:id/done', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE commands
       SET executed = TRUE, executed_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Not found', message: 'Command not found' });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('PUT /commands/:id/done error:', err.message);
    res.status(500).json({ error: 'Database error', message: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/commands/history/:robotId
// Recent command history for iOS display.
// ─────────────────────────────────────────────
router.get('/history/:robotId', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  try {
    const { rows } = await pool.query(
      `SELECT id, command, executed, created_at, executed_at
       FROM commands
       WHERE robot_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [req.params.robotId, limit]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /commands/history/:id error:', err.message);
    res.status(500).json({ error: 'Database error', message: err.message });
  }
});

module.exports = router;
