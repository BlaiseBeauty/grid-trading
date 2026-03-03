const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { queryOne, query } = require('../db/connection');

function generateTokens(user) {
  const accessToken = jwt.sign(
    { id: user.id, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );
  const refreshToken = jwt.sign(
    { id: user.id },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: '7d' }
  );
  return { accessToken, refreshToken };
}

async function routes(fastify) {
  // POST /api/auth/login
  fastify.post('/login', async (request, reply) => {
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

    // Store refresh token
    const hashedRefresh = await bcrypt.hash(tokens.refreshToken, 10);
    await query(
      'UPDATE users SET refresh_token = $1, refresh_token_expires_at = NOW() + INTERVAL \'7 days\' WHERE id = $2',
      [hashedRefresh, user.id]
    );

    // H-16: Set refresh token as HttpOnly cookie
    reply.setCookie('refreshToken', tokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/auth',
      maxAge: 7 * 24 * 60 * 60, // 7 days
    });

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken, // Still return for backward compat during migration
      user: { id: user.id, username: user.username, email: user.email },
    };
  });

  // POST /api/auth/refresh
  fastify.post('/refresh', async (request, reply) => {
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

    const valid = await bcrypt.compare(refreshToken, user.refresh_token);
    if (!valid) {
      return reply.code(401).send({ error: 'Invalid refresh token' });
    }

    const tokens = generateTokens(user);
    const hashedRefresh = await bcrypt.hash(tokens.refreshToken, 10);
    await query(
      'UPDATE users SET refresh_token = $1, refresh_token_expires_at = NOW() + INTERVAL \'7 days\' WHERE id = $2',
      [hashedRefresh, user.id]
    );

    // H-16: Set refresh token as HttpOnly cookie
    reply.setCookie('refreshToken', tokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/auth',
      maxAge: 7 * 24 * 60 * 60,
    });

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  });

  // POST /api/auth/logout
  fastify.post('/logout', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
        await query('UPDATE users SET refresh_token = NULL, refresh_token_expires_at = NULL WHERE id = $1', [payload.id]);
      } catch {
        // Token invalid — still clear on best effort
      }
    }
    // H-16: Clear HttpOnly refresh cookie
    reply.clearCookie('refreshToken', { path: '/api/auth' });
    return { success: true };
  });

  // POST /api/auth/setup — Create admin user (only if no users exist)
  fastify.post('/setup', async (request, reply) => {
    const existing = await queryOne('SELECT COUNT(*)::int as count FROM users');
    if (existing.count > 0) {
      return reply.code(400).send({ error: 'Setup already complete' });
    }

    const email = process.env.ADMIN_EMAIL;
    const password = process.env.ADMIN_PASSWORD;
    if (!email || !password) {
      return reply.code(500).send({ error: 'ADMIN_EMAIL and ADMIN_PASSWORD environment variables are required for setup' });
    }
    if (password.length < 12) {
      return reply.code(400).send({ error: 'ADMIN_PASSWORD must be at least 12 characters' });
    }

    const hash = await bcrypt.hash(password, 12);

    const user = await queryOne(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email',
      ['admin', email, hash]
    );

    const tokens = generateTokens(user);
    return { ...tokens, user };
  });
}

module.exports = routes;
