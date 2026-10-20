const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { queryOne, query, transaction } = require('../db/connection');

const REFRESH_COOKIE_OPTS = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/api/auth',
  maxAge: 7 * 24 * 60 * 60, // 7 days
});

function generateTokens(user) {
  const accessToken = jwt.sign(
    { id: user.id, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );
  // jti makes every refresh token unique even when issued in the same second
  const refreshToken = jwt.sign(
    { id: user.id, jti: crypto.randomUUID() },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: '7d' }
  );
  return { accessToken, refreshToken };
}

// bcrypt only reads the first 72 bytes — a JWT header+payload is identical for the
// first ~72 bytes across tokens, so bcrypt-hashing the full JWT made revocation
// meaningless. A refresh token is high-entropy, so a plain SHA-256 digest is enough.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

async function routes(fastify) {
  // POST /api/auth/login
  fastify.post('/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, // per IP
  }, async (request, reply) => {
    const { email, password } = request.body || {};
    if (!email || !password) {
      return reply.code(400).send({ error: 'Email and password required' });
    }

    const user = await queryOne('SELECT * FROM users WHERE email = $1', [email]);
    if (!user) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    const tokens = generateTokens(user);

    // Store refresh token digest
    await query(
      'UPDATE users SET refresh_token = $1, refresh_token_expires_at = NOW() + INTERVAL \'7 days\' WHERE id = $2',
      [hashToken(tokens.refreshToken), user.id]
    );

    // H-16: Set refresh token as HttpOnly cookie (never in the JSON body)
    reply.setCookie('refreshToken', tokens.refreshToken, REFRESH_COOKIE_OPTS());

    return {
      accessToken: tokens.accessToken,
      user: { id: user.id, username: user.username, email: user.email },
    };
  });

  // POST /api/auth/refresh
  fastify.post('/refresh', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, // per IP
  }, async (request, reply) => {
    // H-16: Accept refresh token from HttpOnly cookie or body
    const refreshToken = request.cookies?.refreshToken || (request.body || {}).refreshToken;
    if (!refreshToken) {
      return reply.code(400).send({ error: 'Refresh token required' });
    }

    let payload;
    try {
      payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    } catch {
      return reply.code(401).send({ error: 'Invalid refresh token' });
    }

    const user = await queryOne('SELECT * FROM users WHERE id = $1', [payload.id]);
    if (!user || !user.refresh_token) {
      return reply.code(401).send({ error: 'Invalid refresh token' });
    }

    // Stored expiry must still be in the future (null/expired = revoked)
    if (!user.refresh_token_expires_at || new Date(user.refresh_token_expires_at) <= new Date()) {
      return reply.code(401).send({ error: 'Invalid refresh token' });
    }

    // Old bcrypt-format rows never match a sha256 hex digest -> 401, user logs in again.
    const presentedHash = hashToken(refreshToken);
    if (!safeEqualHex(presentedHash, user.refresh_token)) {
      return reply.code(401).send({ error: 'Invalid refresh token' });
    }

    const tokens = generateTokens(user);
    // Rotate atomically: only succeeds if the stored digest is still the one presented,
    // so a replayed/concurrent refresh with the same token cannot mint a second session.
    const rotated = await query(
      `UPDATE users SET refresh_token = $1, refresh_token_expires_at = NOW() + INTERVAL '7 days'
       WHERE id = $2 AND refresh_token = $3`,
      [hashToken(tokens.refreshToken), user.id, presentedHash]
    );
    if (rotated.rowCount !== 1) {
      return reply.code(401).send({ error: 'Invalid refresh token' });
    }

    // H-16: Set refresh token as HttpOnly cookie (never in the JSON body)
    reply.setCookie('refreshToken', tokens.refreshToken, REFRESH_COOKIE_OPTS());

    return { accessToken: tokens.accessToken };
  });

  // POST /api/auth/logout — works even when the access token has already expired
  fastify.post('/logout', async (request, reply) => {
    // 1) Revoke by refresh cookie (signature checked, expiry ignored)
    const cookieToken = request.cookies?.refreshToken;
    if (cookieToken) {
      try {
        const payload = jwt.verify(cookieToken, process.env.JWT_REFRESH_SECRET, { ignoreExpiration: true });
        await query(
          'UPDATE users SET refresh_token = NULL, refresh_token_expires_at = NULL WHERE id = $1 AND refresh_token = $2',
          [payload.id, hashToken(cookieToken)]
        );
      } catch (err) {
        console.warn('[AUTH] Logout: refresh cookie not usable for revocation:', err.message);
      }
    }
    // 2) Revoke by valid access token (clears the user's stored session)
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
        await query('UPDATE users SET refresh_token = NULL, refresh_token_expires_at = NULL WHERE id = $1', [payload.id]);
      } catch (err) {
        console.warn('[AUTH] Logout: access token not usable for revocation:', err.message);
      }
    }
    // H-16: Clear HttpOnly refresh cookie
    reply.clearCookie('refreshToken', { path: '/api/auth' });
    return { success: true };
  });

  // POST /api/auth/setup — Create admin user (only if no users exist)
  fastify.post('/setup', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } }, // per IP
  }, async (request, reply) => {
    const email = process.env.ADMIN_EMAIL;
    const password = process.env.ADMIN_PASSWORD;
    if (!email || !password) {
      return reply.code(500).send({ error: 'ADMIN_EMAIL and ADMIN_PASSWORD environment variables are required for setup' });
    }
    if (password.length < 12) {
      return reply.code(400).send({ error: 'ADMIN_PASSWORD must be at least 12 characters' });
    }

    // Cheap early exit so a configured system never pays for a bcrypt hash
    const existing = await queryOne('SELECT COUNT(*)::int as count FROM users');
    if (existing.count > 0) {
      return reply.code(400).send({ error: 'Setup already complete' });
    }

    const hash = await bcrypt.hash(password, 12);

    // Atomic check-and-insert: a transaction-scoped advisory lock serialises concurrent
    // setups, and the INSERT only happens WHEN NOT EXISTS (any user).
    const user = await transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('grid_auth_setup'))");
      const { rows } = await client.query(
        `INSERT INTO users (username, email, password_hash)
         SELECT $1, $2, $3
         WHERE NOT EXISTS (SELECT 1 FROM users)
         RETURNING id, username, email`,
        ['admin', email, hash]
      );
      return rows[0] || null;
    });

    if (!user) {
      return reply.code(400).send({ error: 'Setup already complete' });
    }

    // Only an access token: the refresh token was never stored for setup, so it was unusable.
    // The admin signs in through /login to start a refreshable session.
    const tokens = generateTokens(user);
    return { accessToken: tokens.accessToken, user };
  });
}

module.exports = routes;
