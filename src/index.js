require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const rateLimit = require('express-rate-limit');

const { migrate }       = require('./db/migrate');
const { requireApiKey } = require('./middleware/auth');
const robotsRouter      = require('./routes/robots');
const commandsRouter    = require('./routes/commands');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// Security Middleware
// ─────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: '*' }));  // Restrict in production if needed
app.use(express.json({ limit: '10kb' }));

// Rate limiting — 200 req/min per IP
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests', message: 'Slow down!' },
}));

// ─────────────────────────────────────────────
// Auth Middleware (all routes below)
// ─────────────────────────────────────────────
app.use(requireApiKey);

// ─────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────

// Health — no auth required (middleware skips /health)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'gismo-api',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
  });
});

app.get('/', (req, res) => {
  res.json({ message: 'Gismo Robot API 🤖', docs: '/health' });
});

app.use('/api/robots',   robotsRouter);
app.use('/api/commands', commandsRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────
async function start() {
  try {
    await migrate();           // Run DB migrations on every startup
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Gismo API running on port ${PORT}`);
      console.log(`   NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
      console.log(`   Auth: ${process.env.API_KEY ? 'enabled' : 'DISABLED (set API_KEY)'}`);
    });
  } catch (err) {
    console.error('❌ Failed to start server:', err.message);
    process.exit(1);
  }
}

start();
