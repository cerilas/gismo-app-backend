const { WebSocket, WebSocketServer } = require('ws');
const pool = require('../db/pool');

const VALID_COMMANDS = new Set(['F', 'B', 'L', 'R', 'S', 'A']);
const appClients = new Set();
const robotClients = new Map();
const robotLastSeenAt = new Map();
const robotBattery = new Map();
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
  const liveBattery = robotBattery.get(robotId);
  const rawPercent = liveBattery ? liveBattery.battery_percent : row.battery_percent;
  const rawVoltage = liveBattery ? liveBattery.battery_voltage : row.battery_voltage;
  const validPercent = rawPercent !== null && rawPercent !== undefined && Number(rawPercent) > 0
    ? Number(rawPercent)
    : null;
  const validVoltage = rawVoltage !== null && rawVoltage !== undefined && Number(rawVoltage) >= 5.0
    ? Number(rawVoltage)
    : null;
  return {
    id: robotId,
    name: row.name,
    last_ip: row.last_ip,
    is_online: isRobotOnline(robotId),
    battery_percent: validPercent,
    battery_voltage: validVoltage,
    raw_battery_voltage: liveBattery?.raw_battery_voltage ?? null,
    raw_battery_percent: liveBattery?.raw_battery_percent ?? null,
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
    `SELECT id, name, last_ip, is_online, battery_percent, battery_voltage, last_seen, created_at
     FROM robots
     ORDER BY created_at DESC`
  );
  return rows.map(normalizeRobot);
}

async function fetchRobot(robotId) {
  const normalizedRobotId = normalizeRobotId(robotId);
  const { rows } = await pool.query(
    `SELECT id, name, last_ip, is_online, battery_percent, battery_voltage, last_seen, created_at
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

async function markRobotOnline(robotId, isOnline, lastIp = null, batteryPercent = null, batteryVoltage = null) {
  const normalizedRobotId = normalizeRobotId(robotId);
  const { rows } = await pool.query(
    `UPDATE robots
     SET
       is_online = $2,
       last_ip = COALESCE($3, last_ip),
       battery_percent = COALESCE($4, battery_percent),
       battery_voltage = COALESCE($5, battery_voltage),
       last_seen = NOW()
     WHERE id = $1
     RETURNING id, name, last_ip, is_online, battery_percent, battery_voltage, last_seen, created_at`,
    [normalizedRobotId, isOnline, lastIp, batteryPercent, batteryVoltage]
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

  const robotSocket = robotClients.get(normalizedRobotId);
  if (!isRobotOnline(normalizedRobotId) || !robotSocket || robotSocket.readyState !== WebSocket.OPEN) {
    throw new Error('Robot is not connected');
  }

  if (normalizedCommand === 'A') {
    const commandPayload = {
      id: null,
      robot_id: normalizedRobotId,
      command: 'RESET_WIFI',
      created_at: new Date().toISOString(),
    };

    const didSendAPCommand = safeSend(robotSocket, {
      type: 'command',
      ...commandPayload,
    });

    if (!didSendAPCommand) {
      throw new Error('Robot is not connected');
    }

    console.log(`AP mode command sent to robot ${normalizedRobotId}`);
    return commandPayload;
  }

  // ── Gerçek zamanlı motor komutu ──
  // Komut, HİÇBİR await'ten önce robota senkron olarak iletilir. Böylece:
  //  • Uygulamadan gelen komutlar robota tam olarak geldiği sırada ulaşır
  //    (önceden her komut DB sorgularını beklediği için kısa "L" → "S" darbelerinde
  //     "S", "L"den önce varabiliyor ve robot dönmeye devam edebiliyordu).
  //  • DB gecikmesi motor gecikmesine eklenmez (yüz takibi için kritik).
  const createdAt = new Date().toISOString();
  const didSend = safeSend(robotSocket, {
    type: 'command',
    id: null,
    command: normalizedCommand,
    created_at: createdAt,
  });

  if (!didSend) {
    throw new Error('Robot is not connected');
  }

  // Geçmiş kaydı arka planda, robot başına sıralı olarak yazılır (pool taşmasını önler).
  // WebSocket ile teslim edildiği için executed = TRUE; eski REST polling yolu tekrar çalıştırmaz.
  logCommandAsync(normalizedRobotId, normalizedCommand);

  return {
    id: null,
    robot_id: normalizedRobotId,
    command: normalizedCommand,
    created_at: createdAt,
  };
}

const commandLogChains = new Map();

function logCommandAsync(robotId, command) {
  const previous = commandLogChains.get(robotId) || Promise.resolve();
  const next = previous
    .then(() => pool.query(
      `INSERT INTO commands (robot_id, command, executed, executed_at)
       VALUES ($1, $2, TRUE, NOW())`,
      [robotId, command]
    ))
    .catch((err) => {
      console.error(`Command log failed (robot=${robotId} command=${command}):`, err.message);
    });
  commandLogChains.set(robotId, next);
  next.finally(() => {
    if (commandLogChains.get(robotId) === next) {
      commandLogChains.delete(robotId);
    }
  });
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
         RETURNING id, name, last_ip, is_online, battery_percent, battery_voltage, last_seen, created_at`,
        [normalizedRobotId, name.trim()]
      )
    : await pool.query(
        `INSERT INTO robots (name)
         VALUES ($1)
         RETURNING id, name, last_ip, is_online, battery_percent, battery_voltage, last_seen, created_at`,
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

  robotBattery.delete(normalizedRobotId);
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
          const hasPercentField = message.battery_percent !== undefined && message.battery_percent !== null;
          const hasVoltageField = message.battery_voltage !== undefined && message.battery_voltage !== null;
          const rawPercent = hasPercentField ? Number(message.battery_percent) : NaN;
          const rawVoltage = hasVoltageField ? Number(message.battery_voltage) : NaN;

          const prev = robotBattery.get(robotId) || {
            samples: [],
            ema_percent: null,
            battery_percent: null,
            battery_voltage: null,
            raw_battery_percent: null,
            raw_battery_voltage: null,
          };

          if (Number.isFinite(rawPercent)) {
            prev.raw_battery_percent = Math.round(rawPercent);
          }
          if (Number.isFinite(rawVoltage)) {
            prev.raw_battery_voltage = Number(rawVoltage.toFixed(3));
          }

          let stablePercent = null;
          let stableVoltage = null;

          const isPlausibleReading = Number.isFinite(rawPercent)
            && rawPercent > 0
            && rawPercent <= 100
            && (!Number.isFinite(rawVoltage) || (rawVoltage >= 5.0 && rawVoltage <= 9.5));

          if (isPlausibleReading) {
            const clampedPct = Math.max(1, Math.min(100, Math.round(rawPercent)));
            prev.samples.push({
              pct: clampedPct,
              v: Number.isFinite(rawVoltage) ? rawVoltage : null,
            });
            if (prev.samples.length > 5) {
              prev.samples.shift();
            }

            const sortedPct = prev.samples.map((s) => s.pct).sort((a, b) => a - b);
            const medianPct = sortedPct[Math.floor(sortedPct.length / 2)];
            const spread = sortedPct[sortedPct.length - 1] - sortedPct[0];

            // Eğer son örnekler aşırı dalgalanıyorsa (>35% sıçrama) henüz stabil kabul etme
            if (spread <= 35) {
              prev.ema_percent = prev.ema_percent !== null
                ? prev.ema_percent * 0.65 + medianPct * 0.35
                : medianPct;
              const roundedEma = Math.round(prev.ema_percent);
              // Küçük dalgalanmaları bastır (histerezis)
              if (prev.battery_percent !== null && Math.abs(prev.ema_percent - prev.battery_percent) < 1.4) {
                stablePercent = prev.battery_percent;
              } else {
                stablePercent = roundedEma;
              }

              const validVoltages = prev.samples.map((s) => s.v).filter((v) => v !== null).sort((a, b) => a - b);
              if (validVoltages.length > 0) {
                const medianV = validVoltages[Math.floor(validVoltages.length / 2)];
                stableVoltage = prev.battery_voltage !== null
                  ? Number((prev.battery_voltage * 0.65 + medianV * 0.35).toFixed(2))
                  : Number(medianV.toFixed(2));
              }
            }
          } else if (hasPercentField && rawPercent <= 0) {
            // 0 veya geçersiz okuma geliyorsa geçmiş örnekleri sıfırla ve pil gösterme
            prev.samples = [];
            prev.ema_percent = null;
            prev.battery_percent = null;
            prev.battery_voltage = null;
          }

          if (stablePercent !== null) {
            prev.battery_percent = stablePercent;
          }
          if (stableVoltage !== null) {
            prev.battery_voltage = stableVoltage;
          }
          robotBattery.set(robotId, prev);

          await markRobotOnline(
            robotId,
            message.is_online !== false,
            message.last_ip || null,
            prev.battery_percent,
            prev.battery_voltage
          );
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
