const { WebSocket, WebSocketServer } = require('ws');
const pool = require('../db/pool');

const VALID_COMMANDS = new Set(['F', 'B', 'L', 'R', 'S', 'A']);
const appClients = new Set();
const robotClients = new Map();
const robotLastSeenAt = new Map();
const ROBOT_STALE_AFTER_MS = 5000;

function normalizeRobotId(robotId) {
  return robotId ? String(robotId).toLowerCase() : robotId;
}

function safeSend(ws, message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(message));
  return true;
}

function broadcastToApps(message) {
  for (const client of appClients) {
    safeSend(client, message);
  }
}

function normalizeRobot(row) {
  const robotId = normalizeRobotId(row.id);
  return {
    id: robotId,
    name: row.name,
    last_ip: row.last_ip,
    is_online: isRobotOnline(robotId),
    last_seen: row.last_seen,
    created_at: row.created_at,
  };
}

function isRobotOnline(robotId) {
  const normalizedRobotId = normalizeRobotId(robotId);
  const socket = robotClients.get(normalizedRobotId);
  const lastSeenAt = robotLastSeenAt.get(normalizedRobotId);
  return Boolean(
    socket
    && socket.readyState === WebSocket.OPEN
    && lastSeenAt
    && Date.now() - lastSeenAt <= ROBOT_STALE_AFTER_MS
  );
}

function touchRobot(robotId) {
  const normalizedRobotId = normalizeRobotId(robotId);
  robotLastSeenAt.set(normalizedRobotId, Date.now());
}

async function fetchRobots() {
  const { rows } = await pool.query(
    `SELECT id, name, last_ip, is_online, last_seen, created_at
     FROM robots
     ORDER BY created_at DESC`
  );
  return rows.map(normalizeRobot);
}

async function fetchRobot(robotId) {
  const normalizedRobotId = normalizeRobotId(robotId);
  const { rows } = await pool.query(
    `SELECT id, name, last_ip, is_online, last_seen, created_at
     FROM robots
     WHERE id = $1`,
    [normalizedRobotId]
  );
  return rows[0] ? normalizeRobot(rows[0]) : null;
}

async function broadcastRobot(robotId) {
  const robot = await fetchRobot(robotId);
  if (!robot) return;
  broadcastToApps({ type: 'robot_update', robot });
}

async function markRobotOnline(robotId, isOnline, lastIp = null) {
  const normalizedRobotId = normalizeRobotId(robotId);
  const { rows } = await pool.query(
    `UPDATE robots
     SET
       is_online = $2,
       last_ip = COALESCE($3, last_ip),
       last_seen = NOW()
     WHERE id = $1
     RETURNING id, name, last_ip, is_online, last_seen, created_at`,
    [normalizedRobotId, isOnline, lastIp]
  );

  if (rows[0]) {
    broadcastToApps({ type: 'robot_update', robot: normalizeRobot(rows[0]) });
  }
}

async function sendCommand(robotId, command) {
  const normalizedRobotId = normalizeRobotId(robotId);
  const normalizedCommand = command.toUpperCase();
  if (!VALID_COMMANDS.has(normalizedCommand)) {
    throw new Error(`command must be one of: ${[...VALID_COMMANDS].join(', ')}`);
  }

  await pool.query(
    `DELETE FROM commands
     WHERE robot_id = $1 AND executed = FALSE`,
    [normalizedRobotId]
  );

  const { rows } = await pool.query(
    `INSERT INTO commands (robot_id, command)
     VALUES ($1, $2)
     RETURNING *`,
    [normalizedRobotId, normalizedCommand]
  );

  const robotSocket = robotClients.get(normalizedRobotId);
  if (!isRobotOnline(normalizedRobotId) || !robotSocket || robotSocket.readyState !== WebSocket.OPEN) {
    throw new Error('Robot is not connected');
  }

  const didSend = safeSend(robotSocket, {
    type: 'command',
    id: rows[0].id,
    command: normalizedCommand,
    created_at: rows[0].created_at,
  });

  if (!didSend) {
    throw new Error('Robot is not connected');
  }

  console.log(`Command ${normalizedCommand} sent to robot ${normalizedRobotId}`);
  return rows[0];
}

async function registerRobot(name, id = null) {
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('name is required');
  }

  const normalizedRobotId = normalizeRobotId(id);
  const { rows } = id
    ? await pool.query(
        `INSERT INTO robots (id, name)
         VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, name, last_ip, is_online, last_seen, created_at`,
        [normalizedRobotId, name.trim()]
      )
    : await pool.query(
        `INSERT INTO robots (name)
         VALUES ($1)
         RETURNING id, name, last_ip, is_online, last_seen, created_at`,
        [name.trim()]
      );

  const robot = normalizeRobot(rows[0]);
  broadcastToApps({ type: 'robot_upserted', robot });
  return robot;
}

async function deleteRobot(robotId) {
  const normalizedRobotId = normalizeRobotId(robotId);
  const { rowCount } = await pool.query(
    'DELETE FROM robots WHERE id = $1',
    [normalizedRobotId]
  );

  if (rowCount === 0) {
    throw new Error('Robot not found');
  }

  const robotSocket = robotClients.get(normalizedRobotId);
  if (robotSocket) {
    robotSocket.close(1000, 'robot deleted');
  }

  broadcastToApps({ type: 'robot_deleted', robot_id: normalizedRobotId });
}

function parseMessage(raw) {
  if (Buffer.isBuffer(raw)) {
    return JSON.parse(raw.toString('utf8'));
  }
  return JSON.parse(raw);
}

function authenticate(req, url) {
  const expected = process.env.API_KEY;
  if (!expected) return true;
  return req.headers['x-api-key'] === expected || url.searchParams.get('api_key') === expected;
}

function attachWebSocketServer(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const heartbeatInterval = setInterval(() => {
    for (const client of wss.clients) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }

      client.isAlive = false;
      client.ping();
    }
  }, 30000);

  const staleRobotInterval = setInterval(async () => {
    for (const [robotId, ws] of robotClients.entries()) {
      if (!isRobotOnline(robotId)) {
        robotClients.delete(robotId);
        robotLastSeenAt.delete(robotId);
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
        }
        await markRobotOnline(robotId, false).catch((err) => {
          console.error('Robot stale offline update failed:', err.message);
        });
      }
    }
  }, 2000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
    clearInterval(staleRobotInterval);
  });

  wss.on('connection', async (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (!authenticate(req, url)) {
      safeSend(ws, { type: 'error', message: 'Invalid or missing API key' });
      ws.close(1008, 'unauthorized');
      return;
    }

    const role = url.searchParams.get('role') || 'app';
    const robotId = normalizeRobotId(url.searchParams.get('robot_id'));

    if (role === 'robot') {
      if (!robotId) {
        ws.close(1008, 'robot_id is required');
        return;
      }

      robotClients.set(robotId, ws);
      touchRobot(robotId);
      await markRobotOnline(robotId, true);
      console.log(`Robot connected: ${robotId}`);
      safeSend(ws, { type: 'connected', role: 'robot', robot_id: robotId });

      ws.on('close', async () => {
        if (robotClients.get(robotId) === ws) {
          robotClients.delete(robotId);
          robotLastSeenAt.delete(robotId);
          console.log(`Robot disconnected: ${robotId}`);
          await markRobotOnline(robotId, false).catch((err) => {
            console.error('Robot offline update failed:', err.message);
          });
        }
      });
    } else {
      appClients.add(ws);
      safeSend(ws, { type: 'connected', role: 'app' });

      ws.on('close', () => {
        appClients.delete(ws);
      });
    }

    ws.on('message', async (raw) => {
      let message;

      try {
        message = parseMessage(raw);

        switch (message.type) {
        case 'list_robots': {
          const robots = await fetchRobots();
          safeSend(ws, { type: 'robots', request_id: message.request_id, robots });
          break;
        }
        case 'register_robot': {
          const robot = await registerRobot(message.name, message.id);
          safeSend(ws, { type: 'robot_registered', request_id: message.request_id, robot });
          break;
        }
        case 'delete_robot': {
          const deletedRobotId = normalizeRobotId(message.robot_id);
          await deleteRobot(deletedRobotId);
          safeSend(ws, { type: 'robot_deleted_ack', request_id: message.request_id, robot_id: deletedRobotId });
          break;
        }
        case 'command': {
          console.log(`Command request from app: robot=${message.robot_id} command=${message.command}`);
          const command = await sendCommand(message.robot_id, message.command);
          safeSend(ws, { type: 'command_ack', request_id: message.request_id, command });
          break;
        }
        case 'status': {
          if (role !== 'robot') throw new Error('Only robot clients can send status');
          touchRobot(robotId);
          await markRobotOnline(robotId, message.is_online !== false, message.last_ip || null);
          break;
        }
        case 'command_done': {
          if (role !== 'robot') throw new Error('Only robot clients can mark commands done');
          await pool.query(
            `UPDATE commands
             SET executed = TRUE, executed_at = NOW()
             WHERE id = $1`,
            [message.command_id]
          );
          break;
        }
        case 'ping':
          safeSend(ws, { type: 'pong', request_id: message.request_id });
          break;
        default:
          throw new Error(`Unsupported message type: ${message.type}`);
        }
      } catch (err) {
        safeSend(ws, {
          type: 'error',
          request_id: message && message.request_id,
          message: err.message,
        });
      }
    });
  });

  return wss;
}

module.exports = {
  attachWebSocketServer,
  broadcastRobot,
  sendCommand,
};
