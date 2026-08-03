import { scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const encoder = new TextEncoder();
const PBKDF2_ITERATIONS = 100000;

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function derivePbkdf2(password, salt, iterations = PBKDF2_ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await derivePbkdf2(password, salt);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(derived)}`;
}

export async function verifyPassword(password, storedHash) {
  if (storedHash?.startsWith('pbkdf2$')) {
    const [, iterationsText, saltText, hashText] = storedHash.split('$');
    const iterations = Number(iterationsText);
    if (!Number.isInteger(iterations) || iterations < 10000 || !saltText || !hashText) return false;
    const expected = base64UrlToBytes(hashText);
    const actual = await derivePbkdf2(password, base64UrlToBytes(saltText), iterations);
    return expected.length === actual.length && timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
  }

  const [salt, hash] = String(storedHash || '').split(':');
  if (!salt || !/^[a-f0-9]+$/i.test(hash || '') || hash.length % 2 !== 0) return false;
  const actual = await scrypt(password, salt, hash.length / 2);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function checkLoginRateLimit(db, request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipHash = await sha256(ip);
  const now = new Date();
  const resetAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
  const result = await db.prepare(`
    INSERT INTO login_attempts (ip_hash, attempt_count, reset_at) VALUES (?, 1, ?)
    ON CONFLICT(ip_hash) DO UPDATE SET
      attempt_count = CASE WHEN login_attempts.reset_at <= ? THEN 1 ELSE login_attempts.attempt_count + 1 END,
      reset_at = CASE WHEN login_attempts.reset_at <= ? THEN excluded.reset_at ELSE login_attempts.reset_at END
    RETURNING attempt_count, reset_at
  `).bind(ipHash, resetAt, now.toISOString(), now.toISOString()).first();
  return { allowed: Number(result.attempt_count) <= 10, ipHash, resetAt: result.reset_at };
}

export async function clearLoginAttempts(db, ipHash) {
  await db.prepare('DELETE FROM login_attempts WHERE ip_hash = ?').bind(ipHash).run();
}

export async function login(db, username, password, sessionHours = 8) {
  const normalizedUsername = username.replace(/\s+/g, '');
  const user = await db.prepare(`
    SELECT users.id, users.username, users.password_hash AS passwordHash, users.role,
           users.area_id AS areaId, areas.nombre AS area
    FROM users LEFT JOIN areas ON areas.id = users.area_id
    WHERE REPLACE(users.username, ' ', '') = ? COLLATE NOCASE AND users.active = 1
  `).bind(normalizedUsername).first();
  if (!user || !(await verifyPassword(password, user.passwordHash))) return null;

  if (!user.passwordHash.startsWith('pbkdf2$')) {
    const upgradedHash = await hashPassword(password);
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(upgradedHash, user.id).run();
  }

  const token = bytesToBase64Url(randomBytes(32));
  const expiresAt = new Date(Date.now() + sessionHours * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256(token), user.id, expiresAt, now)
  ]);
  return {
    token,
    expiresAt,
    user: {
      id: Number(user.id),
      username: user.username,
      role: user.role,
      areaId: user.areaId === null ? null : Number(user.areaId),
      area: user.area
    }
  };
}

function readCookie(header, name) {
  const prefix = `${name}=`;
  const part = String(header || '').split(';').map(value => value.trim()).find(value => value.startsWith(prefix));
  if (!part) return null;
  try { return decodeURIComponent(part.slice(prefix.length)); } catch { return null; }
}

export async function authenticate(db, request) {
  const token = readCookie(request.headers.get('Cookie'), 'mp_session');
  if (!token) return null;
  const session = await db.prepare(`
    SELECT users.id, users.username, users.role, users.area_id AS areaId, areas.nombre AS area,
           sessions.expires_at AS expiresAt
    FROM sessions JOIN users ON users.id = sessions.user_id
    LEFT JOIN areas ON areas.id = users.area_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.active = 1
  `).bind(await sha256(token), new Date().toISOString()).first();
  if (!session) return null;
  return {
    token,
    user: {
      id: Number(session.id),
      username: session.username,
      role: session.role,
      areaId: session.areaId === null ? null : Number(session.areaId),
      area: session.area
    }
  };
}

export async function destroySession(db, token) {
  if (token) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
}

export async function changePassword(db, userId, currentPassword, newPassword) {
  const user = await db.prepare('SELECT password_hash AS passwordHash FROM users WHERE id = ?').bind(userId).first();
  if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) return false;
  await db.batch([
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(newPassword), userId),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId)
  ]);
  return true;
}

export function sessionCookie(token, maxAgeSeconds) {
  return `mp_session=${encodeURIComponent(token)}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}
