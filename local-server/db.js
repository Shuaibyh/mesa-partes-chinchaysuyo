import './config.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const databasePath = resolve(process.env.DATABASE_PATH || 'data/mesa-partes.db');
mkdirSync(dirname(databasePath), { recursive: true });

export const db = new DatabaseSync(databasePath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS sequences (year INTEGER PRIMARY KEY, last_value INTEGER NOT NULL DEFAULT 0) STRICT;
  CREATE TABLE IF NOT EXISTS tramites (
    id INTEGER PRIMARY KEY,
    codigo TEXT NOT NULL UNIQUE,
    nombre TEXT NOT NULL,
    tipo_documento TEXT NOT NULL,
    documento TEXT NOT NULL,
    correo TEXT NOT NULL,
    telefono TEXT NOT NULL,
    tipo TEXT NOT NULL,
    area TEXT NOT NULL,
    asunto TEXT NOT NULL,
    descripcion TEXT NOT NULL,
    stored_filename TEXT,
    original_filename TEXT,
    mime_type TEXT,
    file_size INTEGER,
    estado TEXT NOT NULL DEFAULT 'Recibido' CHECK (estado IN ('Recibido', 'En revisión', 'Atendido', 'Observado')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS historial (
    id INTEGER PRIMARY KEY,
    tramite_id INTEGER NOT NULL REFERENCES tramites(id) ON DELETE CASCADE,
    estado TEXT NOT NULL,
    nota TEXT NOT NULL DEFAULT '',
    changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS areas (
    id INTEGER PRIMARY KEY,
    nombre TEXT NOT NULL UNIQUE COLLATE NOCASE,
    activa INTEGER NOT NULL DEFAULT 1 CHECK (activa IN (0, 1)),
    created_at TEXT NOT NULL
  ) STRICT;
`);

for (const area of ['Mesa de Partes', 'Dirección', 'Secretaría', 'Administración', 'Coordinación académica', 'Tutoría']) {
  db.prepare('INSERT INTO areas (nombre, created_at) VALUES (?, ?) ON CONFLICT(nombre) DO NOTHING').run(area, new Date().toISOString());
}

function ensureColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

ensureColumn('users', 'role', "TEXT NOT NULL DEFAULT 'ADMIN'");
ensureColumn('users', 'area_id', 'INTEGER REFERENCES areas(id)');
ensureColumn('users', 'active', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('tramites', 'workflow_status', "TEXT NOT NULL DEFAULT 'Recibido por Mesa de Partes'");
ensureColumn('tramites', 'current_area_id', 'INTEGER REFERENCES areas(id)');

db.exec(`
  CREATE TABLE IF NOT EXISTS derivaciones (
    id INTEGER PRIMARY KEY,
    tramite_id INTEGER NOT NULL REFERENCES tramites(id) ON DELETE CASCADE,
    origin_area_id INTEGER NOT NULL REFERENCES areas(id),
    destination_area_id INTEGER NOT NULL REFERENCES areas(id),
    sent_by INTEGER NOT NULL REFERENCES users(id),
    received_by INTEGER REFERENCES users(id),
    comentario TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'INTERNAL' CHECK (visibility IN ('INTERNAL', 'PUBLIC')),
    sent_at TEXT NOT NULL,
    received_at TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS comentarios (
    id INTEGER PRIMARY KEY,
    tramite_id INTEGER NOT NULL REFERENCES tramites(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    mensaje TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK (visibility IN ('INTERNAL', 'PUBLIC')),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_tramites_documento ON tramites(documento);
  CREATE INDEX IF NOT EXISTS idx_tramites_estado ON tramites(estado);
  CREATE INDEX IF NOT EXISTS idx_tramites_workflow ON tramites(workflow_status);
  CREATE INDEX IF NOT EXISTS idx_tramites_created_at ON tramites(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_historial_tramite ON historial(tramite_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_derivaciones_tramite ON derivaciones(tramite_id, sent_at);
  CREATE INDEX IF NOT EXISTS idx_comentarios_tramite ON comentarios(tramite_id, created_at);
`);

const mesaPartesId = Number(db.prepare("SELECT id FROM areas WHERE nombre = 'Mesa de Partes'").get().id);
db.prepare('UPDATE tramites SET current_area_id = ? WHERE current_area_id IS NULL').run(mesaPartesId);

const legacyStatus = (workflowStatus) => {
  if (workflowStatus === 'Atendido' || workflowStatus === 'Archivado') return 'Atendido';
  if (workflowStatus === 'Observado') return 'Observado';
  if (workflowStatus === 'Recibido por Mesa de Partes') return 'Recibido';
  return 'En revisión';
};

export function createTramite(data, file) {
  const now = new Date().toISOString();
  const year = new Date().getFullYear();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO sequences (year, last_value) VALUES (?, 0) ON CONFLICT(year) DO NOTHING').run(year);
    db.prepare('UPDATE sequences SET last_value = last_value + 1 WHERE year = ?').run(year);
    const { last_value: sequence } = db.prepare('SELECT last_value FROM sequences WHERE year = ?').get(year);
    const codigo = `MP-${year}-${String(sequence).padStart(5, '0')}`;
    const result = db.prepare(`
      INSERT INTO tramites (
        codigo, nombre, tipo_documento, documento, correo, telefono, tipo, area, asunto, descripcion,
        stored_filename, original_filename, mime_type, file_size, estado, workflow_status,
        current_area_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Recibido', 'Recibido por Mesa de Partes', ?, ?, ?)
    `).run(
      codigo, data.nombre, data.tipoDocumento, data.documento, data.correo, data.telefono,
      data.tipo, data.area, data.asunto, data.descripcion, file?.filename || null,
      file?.originalname || null, file?.mimetype || null, file?.size || null, mesaPartesId, now, now
    );
    db.prepare('INSERT INTO historial (tramite_id, estado, nota, created_at) VALUES (?, ?, ?, ?)')
      .run(result.lastInsertRowid, 'Recibido por Mesa de Partes', 'Documento registrado en la mesa de partes virtual.', now);
    db.exec('COMMIT');
    return { id: Number(result.lastInsertRowid), codigo, estado: 'Recibido por Mesa de Partes', createdAt: now };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function findPublicTramite(codigo, documento) {
  const tramite = db.prepare(`
    SELECT t.id, t.codigo, t.nombre, t.tipo_documento AS tipoDocumento, t.documento, t.tipo,
           t.area, t.asunto, t.original_filename AS archivo, t.workflow_status AS estado,
           a.nombre AS ubicacion, t.created_at AS createdAt, t.updated_at AS updatedAt
    FROM tramites t LEFT JOIN areas a ON a.id = t.current_area_id
    WHERE t.codigo = ? COLLATE NOCASE AND t.documento = ?
  `).get(codigo, documento);
  if (!tramite) return null;
  tramite.historial = db.prepare(`
    SELECT estado, nota, created_at AS createdAt FROM historial
    WHERE tramite_id = ? ORDER BY created_at ASC, id ASC
  `).all(tramite.id);
  tramite.comentarios = db.prepare(`
    SELECT mensaje, created_at AS createdAt FROM comentarios
    WHERE tramite_id = ? AND visibility = 'PUBLIC' ORDER BY created_at ASC, id ASC
  `).all(tramite.id);
  delete tramite.id;
  return tramite;
}

export function listAreas(includeInactive = false) {
  return db.prepare(`
    SELECT id, nombre, activa FROM areas
    WHERE (? = 1 OR activa = 1)
    ORDER BY CASE WHEN nombre = ? THEN 0 ELSE 1 END, nombre
  `).all(includeInactive ? 1 : 0, 'Mesa de Partes');
}

export function canAccessTramite(id, user = { role: 'ADMIN' }) {
  if (user.role === 'ADMIN') return Boolean(db.prepare('SELECT id FROM tramites WHERE id = ?').get(id));
  if (!user.areaId) return false;
  return Boolean(db.prepare(`
    SELECT t.id FROM tramites t WHERE t.id = ? AND (
      t.current_area_id = ? OR (? = 1 AND EXISTS (
        SELECT 1 FROM derivaciones d WHERE d.tramite_id = t.id AND d.origin_area_id = ?
      ))
    )
  `).get(id, user.areaId, user.area === 'Mesa de Partes' ? 1 : 0, user.areaId));
}

export function canOperateTramite(id, user = { role: 'ADMIN' }) {
  if (user.role === 'ADMIN') return false;
  if (!user.areaId) return false;
  return Boolean(db.prepare('SELECT id FROM tramites WHERE id = ? AND current_area_id = ?').get(id, user.areaId));
}

export function listTramites({ search = '', bandeja = 'todos', user = { role: 'ADMIN', areaId: null } } = {}) {
  const term = `%${search}%`;
  const isMesaPartes = user.area === 'Mesa de Partes';
  const items = db.prepare(`
    SELECT t.id, t.codigo, t.nombre, t.tipo_documento AS tipoDocumento, t.documento, t.correo,
           t.telefono, t.tipo, t.area, t.asunto, t.descripcion, t.original_filename AS archivo,
           t.file_size AS fileSize, t.workflow_status AS estado, a.nombre AS ubicacion,
           t.current_area_id AS currentAreaId, t.created_at AS createdAt, t.updated_at AS updatedAt,
           EXISTS (SELECT 1 FROM derivaciones any_route WHERE any_route.tramite_id = t.id) AS hasDerivation,
           EXISTS (SELECT 1 FROM derivaciones sent_route WHERE sent_route.tramite_id = t.id AND sent_route.origin_area_id = ?) AS sentByArea
    FROM tramites t LEFT JOIN areas a ON a.id = t.current_area_id
    WHERE (? = '' OR t.codigo LIKE ? OR t.nombre LIKE ? OR t.documento LIKE ? OR t.asunto LIKE ?)
      AND (? = 'ADMIN' OR (? IS NOT NULL AND (
        t.current_area_id = ? OR (? = 1 AND EXISTS (
          SELECT 1 FROM derivaciones access_route WHERE access_route.tramite_id = t.id AND access_route.origin_area_id = ?
        ))
      )))
    ORDER BY t.updated_at DESC LIMIT 500
  `).all(
    user.areaId, search, term, term, term, term,
    user.role, user.areaId, user.areaId, isMesaPartes ? 1 : 0, user.areaId
  );
  const isCurrent = item => user.role === 'ADMIN' || item.currentAreaId === user.areaId;
  if (bandeja === 'entrada') return items.filter(item => isCurrent(item) && ['Recibido por Mesa de Partes', 'Derivado', 'Recibido por área'].includes(item.estado));
  if (bandeja === 'atencion') return items.filter(item => isCurrent(item) && ['En atención', 'Observado'].includes(item.estado));
  if (bandeja === 'derivados') return items.filter(item => user.role === 'ADMIN' ? item.hasDerivation : isMesaPartes && item.sentByArea);
  if (bandeja === 'atendidos') return items.filter(item => isCurrent(item) && ['Atendido', 'Archivado'].includes(item.estado));
  return items;
}

export function getTramiteDetail(id, user = { role: 'ADMIN', areaId: null }) {
  if (!canAccessTramite(id, user)) return null;
  const tramite = db.prepare(`
    SELECT t.id, t.codigo, t.nombre, t.tipo_documento AS tipoDocumento, t.documento, t.correo,
           t.telefono, t.tipo, t.area AS areaSolicitada, t.asunto, t.descripcion,
           t.original_filename AS archivo, t.workflow_status AS estado, t.current_area_id AS currentAreaId,
           a.nombre AS ubicacion, t.created_at AS createdAt, t.updated_at AS updatedAt
    FROM tramites t LEFT JOIN areas a ON a.id = t.current_area_id WHERE t.id = ?
  `).get(id);
  if (!tramite) return null;
  tramite.derivaciones = db.prepare(`
    SELECT d.id, origin.nombre AS origen, destination.nombre AS destino,
           sender.username AS enviadoPor, receiver.username AS recibidoPor,
           d.comentario, d.visibility, d.sent_at AS sentAt, d.received_at AS receivedAt
    FROM derivaciones d
    JOIN areas origin ON origin.id = d.origin_area_id
    JOIN areas destination ON destination.id = d.destination_area_id
    JOIN users sender ON sender.id = d.sent_by
    LEFT JOIN users receiver ON receiver.id = d.received_by
    WHERE d.tramite_id = ? ORDER BY d.sent_at ASC, d.id ASC
  `).all(id);
  tramite.comentarios = db.prepare(`
    SELECT c.id, c.mensaje, c.visibility, u.username AS autor, c.created_at AS createdAt
    FROM comentarios c JOIN users u ON u.id = c.user_id
    WHERE c.tramite_id = ? ORDER BY c.created_at ASC, c.id ASC
  `).all(id);
  tramite.historial = db.prepare(`
    SELECT h.estado, h.nota, u.username AS usuario, h.created_at AS createdAt
    FROM historial h LEFT JOIN users u ON u.id = h.changed_by
    WHERE h.tramite_id = ? ORDER BY h.created_at ASC, h.id ASC
  `).all(id);
  tramite.pendingReception = Boolean(db.prepare(`
    SELECT id FROM derivaciones WHERE tramite_id = ? AND destination_area_id = ? AND received_at IS NULL
    ORDER BY sent_at DESC LIMIT 1
  `).get(id, tramite.currentAreaId));
  tramite.canOperate = canOperateTramite(id, user);
  return tramite;
}

export function deriveTramite(id, destinationAreaId, comentario, visibility, userId) {
  const now = new Date().toISOString();
  const tramite = db.prepare('SELECT current_area_id AS currentAreaId FROM tramites WHERE id = ?').get(id);
  const destination = db.prepare('SELECT id FROM areas WHERE id = ? AND activa = 1').get(destinationAreaId);
  if (!tramite || !destination || tramite.currentAreaId === destinationAreaId) return null;
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = db.prepare(`
      INSERT INTO derivaciones (tramite_id, origin_area_id, destination_area_id, sent_by, comentario, visibility, sent_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, tramite.currentAreaId, destinationAreaId, userId, comentario, visibility, now);
    db.prepare("UPDATE tramites SET current_area_id = ?, workflow_status = 'Derivado', estado = 'En revisión', updated_at = ? WHERE id = ?")
      .run(destinationAreaId, now, id);
    db.prepare('INSERT INTO historial (tramite_id, estado, nota, changed_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'Derivado', 'El expediente fue derivado a otra área.', userId, now);
    db.exec('COMMIT');
    return { id: Number(result.lastInsertRowid), estado: 'Derivado', updatedAt: now };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function receiveTramite(id, userId) {
  const tramite = db.prepare('SELECT current_area_id AS currentAreaId FROM tramites WHERE id = ?').get(id);
  if (!tramite) return null;
  const pending = db.prepare(`
    SELECT id FROM derivaciones WHERE tramite_id = ? AND destination_area_id = ? AND received_at IS NULL
    ORDER BY sent_at DESC, id DESC LIMIT 1
  `).get(id, tramite.currentAreaId);
  if (!pending) return null;
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE derivaciones SET received_by = ?, received_at = ? WHERE id = ?').run(userId, now, pending.id);
    db.prepare("UPDATE tramites SET workflow_status = 'Recibido por área', estado = 'En revisión', updated_at = ? WHERE id = ?").run(now, id);
    db.prepare('INSERT INTO historial (tramite_id, estado, nota, changed_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'Recibido por área', 'El área destinataria confirmó la recepción.', userId, now);
    db.exec('COMMIT');
    return { id, estado: 'Recibido por área', updatedAt: now };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function addComment(id, mensaje, visibility, userId) {
  if (!db.prepare('SELECT id FROM tramites WHERE id = ?').get(id)) return null;
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO comentarios (tramite_id, user_id, mensaje, visibility, created_at) VALUES (?, ?, ?, ?, ?)
  `).run(id, userId, mensaje, visibility, now);
  db.prepare('UPDATE tramites SET updated_at = ? WHERE id = ?').run(now, id);
  return { id: Number(result.lastInsertRowid), createdAt: now };
}

export function updateTramiteStatus(id, workflowStatus, nota, userId) {
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = db.prepare('UPDATE tramites SET estado = ?, workflow_status = ?, updated_at = ? WHERE id = ?')
      .run(legacyStatus(workflowStatus), workflowStatus, now, id);
    if (result.changes === 0) {
      db.exec('ROLLBACK');
      return null;
    }
    db.prepare('INSERT INTO historial (tramite_id, estado, nota, changed_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, workflowStatus, nota || `Estado actualizado a ${workflowStatus}.`, userId, now);
    db.exec('COMMIT');
    return { id, estado: workflowStatus, updatedAt: now };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function getTramiteFile(id) {
  return db.prepare('SELECT stored_filename AS storedFilename, original_filename AS originalFilename, mime_type AS mimeType FROM tramites WHERE id = ?').get(id);
}

export function getStats(user = { role: 'ADMIN', areaId: null }) {
  return {
    total: listTramites({ user, bandeja: 'todos' }).length,
    entrada: listTramites({ user, bandeja: 'entrada' }).length,
    enAtencion: listTramites({ user, bandeja: 'atencion' }).length,
    derivados: listTramites({ user, bandeja: 'derivados' }).length,
    atendidos: listTramites({ user, bandeja: 'atendidos' }).length
  };
}

export function listUsers() {
  return db.prepare(`
    SELECT u.id, u.username, u.role, u.area_id AS areaId, a.nombre AS area, u.active,
           u.created_at AS createdAt
    FROM users u LEFT JOIN areas a ON a.id = u.area_id
    ORDER BY CASE WHEN u.role = 'ADMIN' THEN 0 ELSE 1 END, a.nombre, u.username
  `).all();
}

export function createUser({ username, passwordHash, role, areaId }) {
  const result = db.prepare(`
    INSERT INTO users (username, password_hash, role, area_id, active, created_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(username, passwordHash, role, areaId, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function updateUser(id, { username, role, areaId, active, passwordHash }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = db.prepare(`
      UPDATE users SET username = ?, role = ?, area_id = ?, active = ? WHERE id = ?
    `).run(username, role, areaId, active ? 1 : 0, id);
    if (!result.changes) {
      db.exec('ROLLBACK');
      return false;
    }
    if (passwordHash) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function createArea(nombre) {
  const result = db.prepare('INSERT INTO areas (nombre, activa, created_at) VALUES (?, 1, ?)').run(nombre, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function updateArea(id, { nombre, activa }) {
  const result = db.prepare('UPDATE areas SET nombre = ?, activa = ? WHERE id = ?').run(nombre, activa ? 1 : 0, id);
  return Boolean(result.changes);
}

export function getAreaUsage(id) {
  return {
    users: Number(db.prepare("SELECT COUNT(*) AS total FROM users WHERE area_id = ? AND active = 1").get(id).total),
    tramites: Number(db.prepare('SELECT COUNT(*) AS total FROM tramites WHERE current_area_id = ?').get(id).total)
  };
}
