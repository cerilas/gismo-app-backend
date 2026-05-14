const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// ─────────────────────────────────────────────
// GET /api/robots — List all robots
// ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, last_ip, is_online, last_seen, created_at, switch_to_ap
       FROM robots
       ORDER BY created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /robots error:', err.message);
    res.status(500).json({ error: 'Database error', message: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/robots/:id — Get single robot
// ─────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, last_ip, is_online, last_seen, created_at, switch_to_ap
       FROM robots WHERE id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Not found', message: 'Robot not found' });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('GET /robots/:id error:', err.message);
    res.status(500).json({ error: 'Database error', message: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/robots — Register a new robot
// Body: { name: string, id?: string (UUID) }
// ─────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { name, id } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Validation error', message: 'name is required' });
  }

  try {
    let query, params;

    if (id) {
      // Client provides its own UUID (iOS generates it)
      query = `
        INSERT INTO robots (id, name)
        VALUES ($1, $2)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
        RETURNING *`;
      params = [id, name.trim()];
    } else {
      query = `
        INSERT INTO robots (name)
        VALUES ($1)
        RETURNING *`;
      params = [name.trim()];
    }

    const { rows } = await pool.query(query, params);
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('POST /robots error:', err.message);
    res.status(500).json({ error: 'Database error', message: err.message });
  }
});

// ─────────────────────────────────────────────
// PUT /api/robots/:id — Update robot status
// Body: { last_ip?: string, is_online?: boolean }
// Called by ESP32 on connect/heartbeat
// ─────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const { last_ip, is_online } = req.body;

  try {
    const { rows } = await pool.query(
      `UPDATE robots
       SET
         last_ip   = COALESCE($2, last_ip),
         is_online = COALESCE($3, is_online),
         last_seen = NOW()
       WHERE id = $1
       RETURNING *`,
      [req.params.id, last_ip ?? null, is_online ?? null]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Not found', message: 'Robot not found' });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('PUT /robots/:id error:', err.message);
    res.status(500).json({ error: 'Database error', message: err.message });
  }
});

// ─────────────────────────────────────────────
// PUT /api/robots/:id/ap_mode — Command robot to switch to AP mode
// ─────────────────────────────────────────────
router.put('/:id/ap_mode', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE robots
       SET switch_to_ap = TRUE
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Not found', message: 'Robot not found' });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('PUT /robots/:id/ap_mode error:', err.message);
    res.status(500).json({ error: 'Database error', message: err.message });
  }
});

// ─────────────────────────────────────────────
// DELETE /api/robots/:id — Remove robot
// ─────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM robots WHERE id = $1',
      [req.params.id]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Not found', message: 'Robot not found' });
    }
    res.json({ success: true, message: 'Robot deleted' });
  } catch (err) {
    console.error('DELETE /robots/:id error:', err.message);
    res.status(500).json({ error: 'Database error', message: err.message });
  }
});

module.exports = router;
