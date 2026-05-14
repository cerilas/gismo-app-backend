/**
 * Simple API Key middleware.
 * The key is set via API_KEY env var on Railway.
 * iOS app and ESP32 send it in the `x-api-key` header.
 *
 * Skip auth on /health endpoint.
 */
function requireApiKey(req, res, next) {
  // Skip health checks
  if (req.path === '/health' || req.path === '/') return next();

  const key = req.headers['x-api-key'];
  const expected = process.env.API_KEY;

  if (!expected) {
    // No key configured — allow all (dev mode)
    console.warn('⚠️  API_KEY not set — running without auth!');
    return next();
  }

  if (!key || key !== expected) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or missing API key' });
  }

  next();
}

module.exports = { requireApiKey };
