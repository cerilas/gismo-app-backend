# Gismo Robot Controller — Backend API

REST API for controlling ESP32-based robots over the internet.

## Stack
- **Runtime:** Node.js 18+
- **Framework:** Express.js
- **Database:** PostgreSQL (Railway)
- **Deploy:** Railway (auto-deploy from this repo)

## API Endpoints

### Health
```
GET /health
```

### Robots (iOS App → API)
```
GET    /api/robots              # List all robots
GET    /api/robots/:id          # Get single robot
POST   /api/robots              # Register robot  { name, id? }
PUT    /api/robots/:id          # Update status   { last_ip?, is_online? }
DELETE /api/robots/:id          # Remove robot
```

### Commands
```
POST /api/commands                        # Send command   { robot_id, command }
GET  /api/commands/pending/:robotId       # ESP32 polling
PUT  /api/commands/:id/done              # Mark executed
GET  /api/commands/history/:robotId      # Recent history
```

### Commands: F=Forward, B=Backward, L=Left, R=Right, S=Stop

## Authentication
All endpoints (except `/health`) require `x-api-key` header.

## Environment Variables (set in Railway Dashboard)
```
DATABASE_URL=<Railway provides automatically>
API_KEY=<your-secret-key>
PORT=<Railway provides automatically>
NODE_ENV=production
```

## ESP32 Polling Flow
```
ESP32 → GET /api/commands/pending/:robotId every 100ms
      ← { command: "F" }  or  { command: null }
ESP32 → PUT /api/commands/:id/done  (confirm execution)
ESP32 → PUT /api/robots/:id  { is_online: true, last_ip: "..." }  (heartbeat)
```
