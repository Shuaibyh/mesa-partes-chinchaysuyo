import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { db } from './db.js';

const scrypt = promisify(scryptCallback);
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const derived = await scrypt(password, salt, 64);
  const storedBuffer = Buffer.from(hash, 'hex');
  return storedBuffer.length === derived.length && timingSafeEqual(storedBuffer, derived);
}

export async function ensureAdmin() {
  const existing = db.prepare('SELECT id FROM users LIMIT 1').get();
  if (existing) return null;
  const username = process.env.ADMIN_USER || 'admin';
  const generatedPassword = randomBytes(12).toString('base64url');
  const password = process.env.ADMIN_PASSWORD || generatedPassword;
  const passwordHash = await hashPassword(password);
  db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run(username, passwordHash, new Date().toISOString());
  return { username, password, generated: !process.env.ADMIN_PASSWORD };
}

export async function login(username, password) {
  const normalizedUsername = username.replace(/\s+/g, '');
  const user = db.prepare(`
    SELECT users.id, users.username, users.password_hash AS passwordHash, users.role,
           users.area_id AS areaId, areas.nombre AS area
    FROM users LEFT JOIN areas ON areas.id = users.area_id
    WHERE REPLACE(username, ' ', '') = ? COLLATE NOCASE AND users.active = 1
  `).get(normalizedUsername);
  if (!user || !(await verifyPassword(password, user.passwordHash))) return null;
  const token = randomBytes(32).toString('base64url');
  const hours = Number(process.env.SESSION_HOURS || 8);
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(tokenHash(token), user.id, expiresAt, new Date().toISOString());
  return { token, expiresAt, user: { id: user.id, username: user.username, role: user.role, areaId: user.areaId, area: user.area } };
}

export async function changePassword(userId, currentPassword, newPassword) {
  const user = db.prepare('SELECT password_hash AS passwordHash FROM users WHERE id = ?').get(userId);
  if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) return false;
  const passwordHash = await hashPassword(newPassword);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function readCookie(header = '', name) {
  const prefix = `${name}=`;
  const part = header.split(';').map(value => value.trim()).find(value => value.startsWith(prefix));
  return part ? decodeURIComponent(part.slice(prefix.length)) : null;
}

export function requireAuth(req, res, next) {
  const token = readCookie(req.headers.cookie, 'mp_session');
  if (!token) return res.status(401).json({ error: 'Debe iniciar sesión.' });
  const session = db.prepare(`
    SELECT users.id, users.username, users.role, users.area_id AS areaId, areas.nombre AS area,
           sessions.expires_at AS expiresAt
    FROM sessions JOIN users ON users.id = sessions.user_id
    LEFT JOIN areas ON areas.id = users.area_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.active = 1
  `).get(tokenHash(token), new Date().toISOString());
  if (!session) return res.status(401).json({ error: 'La sesión venció. Inicie sesión nuevamente.' });
  req.user = { id: session.id, username: session.username, role: session.role, areaId: session.areaId, area: session.area };
  req.sessionToken = token;
  next();
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}

export function sessionCookie(token, maxAgeSeconds) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `mp_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}
