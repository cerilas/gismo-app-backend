const express = require('express');
const pool    = require('../db/pool');

const router = express.Router();

// GET /api/memories?user_id=...&device_id=...
router.get('/', async (req, res) => {
  try {
    const userId   = (req.query.user_id || '').trim() || null;
    const deviceId = (req.query.device_id || '').trim() || null;

    if (!userId && !deviceId) {
      return res.json({ memories: [] });
    }

    let result;
    if (userId) {
      // Strictly isolate memories per authenticated user_id
      result = await pool.query(
        `SELECT * FROM user_memories
         WHERE user_id::text = $1
         ORDER BY updated_at DESC
         LIMIT 200`,
        [userId]
      );
    } else {
      result = await pool.query(
        `SELECT * FROM user_memories
         WHERE device_id = $1 AND user_id IS NULL
         ORDER BY updated_at DESC
         LIMIT 200`,
        [deviceId]
      );
    }

    return res.json({ memories: result.rows });
  } catch (err) {
    console.error('[Memories] GET error:', err.message);
    return res.status(500).json({ error: 'Hafıza kayıtları alınamadı.' });
  }
});

// POST /api/memories
router.post('/', async (req, res) => {
  try {
    const {
      user_id,
      device_id,
      category = 'note',
      subject,
      content,
    } = req.body || {};

    const cleanSubject = String(subject || '').trim();
    const cleanContent = String(content || '').trim();
    const cleanCategory = ['owner', 'person', 'topic', 'note'].includes(category)
      ? category
      : 'note';

    if (!cleanSubject || !cleanContent) {
      return res.status(400).json({ error: 'subject ve content zorunludur.' });
    }

    const validUserId =
      user_id && /^[0-9a-fA-F-]{36}$/.test(String(user_id).trim())
        ? String(user_id).trim()
        : null;
    const cleanDeviceId = device_id ? String(device_id).trim() : null;

    // Check if an existing memory with the same category + subject exists
    let existing = { rows: [] };
    if (validUserId) {
      existing = await pool.query(
        `SELECT id FROM user_memories
         WHERE user_id = $1 AND category = $2 AND LOWER(subject) = LOWER($3)
         LIMIT 1`,
        [validUserId, cleanCategory, cleanSubject]
      );
    } else if (cleanDeviceId) {
      existing = await pool.query(
        `SELECT id FROM user_memories
         WHERE device_id = $1 AND category = $2 AND LOWER(subject) = LOWER($3)
         LIMIT 1`,
        [cleanDeviceId, cleanCategory, cleanSubject]
      );
    }

    let saved;
    if (existing.rows.length > 0) {
      const updated = await pool.query(
        `UPDATE user_memories
         SET content = $1, user_id = COALESCE($2, user_id), device_id = COALESCE($3, device_id), updated_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [cleanContent, validUserId, cleanDeviceId, existing.rows[0].id]
      );
      saved = updated.rows[0];
    } else {
      const inserted = await pool.query(
        `INSERT INTO user_memories (user_id, device_id, category, subject, content, updated_at, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         RETURNING *`,
        [validUserId, cleanDeviceId, cleanCategory, cleanSubject, cleanContent]
      );
      saved = inserted.rows[0];
    }

    return res.status(201).json({ success: true, memory: saved });
  } catch (err) {
    console.error('[Memories] POST error:', err.message);
    return res.status(500).json({ error: 'Hafıza kaydedilemedi.' });
  }
});

// DELETE /api/memories
router.delete('/', async (req, res) => {
  try {
    const { id, query, user_id, device_id } = req.body || req.query || {};
    if (id && /^[0-9a-fA-F-]{36}$/.test(String(id).trim())) {
      await pool.query('DELETE FROM user_memories WHERE id = $1', [String(id).trim()]);
      return res.json({ success: true });
    }
    if (query) {
      const q = `%${String(query).trim().toLowerCase()}%`;
      if (user_id && /^[0-9a-fA-F-]{36}$/.test(String(user_id).trim())) {
        await pool.query(
          `DELETE FROM user_memories
           WHERE user_id = $1 AND (LOWER(subject) LIKE $2 OR LOWER(content) LIKE $2)`,
          [String(user_id).trim(), q]
        );
      } else if (device_id) {
        await pool.query(
          `DELETE FROM user_memories
           WHERE device_id = $1 AND (LOWER(subject) LIKE $2 OR LOWER(content) LIKE $2)`,
          [String(device_id).trim(), q]
        );
      }
      return res.json({ success: true });
    }
    return res.status(400).json({ error: 'id veya query gereklidir.' });
  } catch (err) {
    console.error('[Memories] DELETE error:', err.message);
    return res.status(500).json({ error: 'Hafıza silinemedi.' });
  }
});

module.exports = router;
