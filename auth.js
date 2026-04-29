const crypto = require('crypto');
const { pool } = require('./db');

const SESSION_COOKIE = 'ts_session';
const SESSION_DAYS = 30;
const MAGIC_LINK_MINS = 15;

async function createMagicLink(email) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + MAGIC_LINK_MINS * 60_000);
  await pool.query(
    'INSERT INTO magic_links (email, token, expires_at) VALUES ($1, $2, $3)',
    [email, token, expiresAt]
  );
  return token;
}

async function verifyMagicLink(token) {
  const result = await pool.query(
    'UPDATE magic_links SET used = TRUE WHERE token = $1 AND expires_at > NOW() AND used = FALSE RETURNING email',
    [token]
  );
  return result.rows[0]?.email ?? null;
}

async function findOrCreateUser(email) {
  const result = await pool.query(
    `INSERT INTO users (email) VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [email]
  );
  return result.rows[0].id;
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await pool.query(
    'INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3)',
    [userId, token, expiresAt]
  );
  return { token, expiresAt };
}

async function getSessionUser(req) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const result = await pool.query(
    `SELECT u.id, u.email,
            COALESCE(array_agg(r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN user_roles r ON r.user_id = u.id
     WHERE s.token = $1 AND s.expires_at > NOW()
     GROUP BY u.id, u.email`,
    [token]
  );
  return result.rows[0] ?? null;
}

function setSessionCookie(res, token, expiresAt) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    expires: expiresAt,
    sameSite: 'lax',
    path: '/',
  });
}

function isApiRequest(req) {
  return req.path.startsWith('/api/') || (req.headers.accept || '').includes('application/json');
}

async function requireAuth(req, res, next) {
  try {
    const user = await getSessionUser(req);
    if (!user) {
      return isApiRequest(req)
        ? res.status(401).json({ error: 'Unauthorized' })
        : res.redirect('/login');
    }
    req.user = user;
    next();
  } catch (err) {
    console.error('requireAuth error:', err.message);
    res.status(500).json({ error: 'Auth error' });
  }
}

function requireRole(role) {
  return async (req, res, next) => {
    try {
      const user = await getSessionUser(req);
      if (!user) {
        return isApiRequest(req)
          ? res.status(401).json({ error: 'Unauthorized' })
          : res.redirect('/login');
      }
      req.user = user;
      if (!user.roles.includes(role)) {
        return isApiRequest(req)
          ? res.status(403).json({ error: 'Forbidden' })
          : res.status(403).send('<h2>Access denied</h2><p><a href="/login">Log in</a></p>');
      }
      next();
    } catch (err) {
      console.error('requireRole error:', err.message);
      res.status(500).json({ error: 'Auth error' });
    }
  };
}

module.exports = {
  SESSION_COOKIE,
  createMagicLink,
  verifyMagicLink,
  findOrCreateUser,
  createSession,
  getSessionUser,
  setSessionCookie,
  requireAuth,
  requireRole,
};
