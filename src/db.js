const legacyStatus = (workflowStatus) => {
  if (workflowStatus === 'Atendido' || workflowStatus === 'Archivado') return 'Atendido';
  if (workflowStatus === 'Observado') return 'Observado';
  if (workflowStatus === 'Recibido por Mesa de Partes') return 'Recibido';
  return 'En revisión';
};

export async function createTramite(db, data, file) {
  const now = new Date().toISOString();
  const year = new Date().getFullYear();
  const mesaPartes = await db.prepare("SELECT id FROM areas WHERE nombre = 'Mesa de Partes'").first();
  if (!mesaPartes) throw new Error('No existe el área obligatoria Mesa de Partes.');

  const sequence = await db.prepare(`
    INSERT INTO sequences (year, last_value) VALUES (?, 1)
    ON CONFLICT(year) DO UPDATE SET last_value = last_value + 1
    RETURNING last_value
  `).bind(year).first();
  const codigo = `MP-${year}-${String(sequence.last_value).padStart(5, '0')}`;

  await db.batch([
    db.prepare(`
      INSERT INTO tramites (
        codigo, nombre, tipo_documento, documento, correo, telefono, tipo, area, asunto, descripcion,
        stored_filename, original_filename, mime_type, file_size, estado, workflow_status,
        current_area_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Recibido', 'Recibido por Mesa de Partes', ?, ?, ?)
    `).bind(
      codigo, data.nombre, data.tipoDocumento, data.documento, data.correo, data.telefono,
      data.tipo, data.area, data.asunto, data.descripcion, file?.storedFilename || null,
      file?.originalFilename || null, file?.mimeType || null, file?.size || null,
      mesaPartes.id, now, now
    ),
    db.prepare(`
      INSERT INTO historial (tramite_id, estado, nota, created_at)
      SELECT id, 'Recibido por Mesa de Partes', 'Documento registrado en la mesa de partes virtual.', ?
      FROM tramites WHERE codigo = ?
    `).bind(now, codigo)
  ]);

  const created = await db.prepare('SELECT id FROM tramites WHERE codigo = ?').bind(codigo).first();
  return { id: Number(created.id), codigo, estado: 'Recibido por Mesa de Partes', createdAt: now };
}

export async function findPublicTramite(db, codigo, documento) {
  const tramite = await db.prepare(`
    SELECT t.id, t.codigo, t.nombre, t.tipo_documento AS tipoDocumento, t.documento, t.tipo,
           t.area, t.asunto, t.original_filename AS archivo, t.workflow_status AS estado,
           a.nombre AS ubicacion, t.created_at AS createdAt, t.updated_at AS updatedAt
    FROM tramites t LEFT JOIN areas a ON a.id = t.current_area_id
    WHERE t.codigo = ? COLLATE NOCASE AND t.documento = ?
  `).bind(codigo, documento).first();
  if (!tramite) return null;

  const [historial, comentarios] = await Promise.all([
    db.prepare(`
      SELECT estado, nota, created_at AS createdAt FROM historial
      WHERE tramite_id = ? ORDER BY created_at ASC, id ASC
    `).bind(tramite.id).all(),
    db.prepare(`
      SELECT mensaje, created_at AS createdAt FROM comentarios
      WHERE tramite_id = ? AND visibility = 'PUBLIC' ORDER BY created_at ASC, id ASC
    `).bind(tramite.id).all()
  ]);
  tramite.historial = historial.results;
  tramite.comentarios = comentarios.results;
  delete tramite.id;
  return tramite;
}

export async function listAreas(db, includeInactive = false) {
  const result = await db.prepare(`
    SELECT id, nombre, activa FROM areas
    WHERE (? = 1 OR activa = 1)
    ORDER BY CASE WHEN nombre = ? THEN 0 ELSE 1 END, nombre
  `).bind(includeInactive ? 1 : 0, 'Mesa de Partes').all();
  return result.results.map(area => ({ ...area, id: Number(area.id), activa: Boolean(area.activa) }));
}

export async function canAccessTramite(db, id, user) {
  if (user.role === 'ADMIN') {
    return Boolean(await db.prepare('SELECT id FROM tramites WHERE id = ?').bind(id).first());
  }
  if (!user.areaId) return false;
  const item = await db.prepare(`
    SELECT t.id FROM tramites t WHERE t.id = ? AND (
      t.current_area_id = ? OR (? = 1 AND EXISTS (
        SELECT 1 FROM derivaciones d WHERE d.tramite_id = t.id AND d.origin_area_id = ?
      ))
    )
  `).bind(id, user.areaId, user.area === 'Mesa de Partes' ? 1 : 0, user.areaId).first();
  return Boolean(item);
}

export async function canOperateTramite(db, id, user) {
  if (user.role === 'ADMIN' || !user.areaId) return false;
  return Boolean(await db.prepare(
    'SELECT id FROM tramites WHERE id = ? AND current_area_id = ?'
  ).bind(id, user.areaId).first());
}

export async function listTramites(db, { search = '', bandeja = 'todos', user } = {}) {
  const term = `%${search}%`;
  const isMesaPartes = user.area === 'Mesa de Partes';
  const result = await db.prepare(`
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
  `).bind(
    user.areaId, search, term, term, term, term,
    user.role, user.areaId, user.areaId, isMesaPartes ? 1 : 0, user.areaId
  ).all();

  const items = result.results.map(item => ({
    ...item,
    id: Number(item.id),
    currentAreaId: item.currentAreaId === null ? null : Number(item.currentAreaId),
    fileSize: item.fileSize === null ? null : Number(item.fileSize),
    hasDerivation: Boolean(item.hasDerivation),
    sentByArea: Boolean(item.sentByArea)
  }));
  const isCurrent = item => user.role === 'ADMIN' || item.currentAreaId === user.areaId;
  if (bandeja === 'entrada') return items.filter(item => isCurrent(item) && ['Recibido por Mesa de Partes', 'Derivado', 'Recibido por área'].includes(item.estado));
  if (bandeja === 'atencion') return items.filter(item => isCurrent(item) && ['En atención', 'Observado'].includes(item.estado));
  if (bandeja === 'derivados') return items.filter(item => user.role === 'ADMIN' ? item.hasDerivation : isMesaPartes && item.sentByArea);
  if (bandeja === 'atendidos') return items.filter(item => isCurrent(item) && ['Atendido', 'Archivado'].includes(item.estado));
  return items;
}

export function getStatsFromItems(items, user) {
  const isMesaPartes = user.area === 'Mesa de Partes';
  const isCurrent = item => user.role === 'ADMIN' || item.currentAreaId === user.areaId;
  return {
    total: items.length,
    entrada: items.filter(item => isCurrent(item) && ['Recibido por Mesa de Partes', 'Derivado', 'Recibido por área'].includes(item.estado)).length,
    enAtencion: items.filter(item => isCurrent(item) && ['En atención', 'Observado'].includes(item.estado)).length,
    derivados: items.filter(item => user.role === 'ADMIN' ? item.hasDerivation : isMesaPartes && item.sentByArea).length,
    atendidos: items.filter(item => isCurrent(item) && ['Atendido', 'Archivado'].includes(item.estado)).length
  };
}

export async function getTramiteDetail(db, id, user) {
  if (!await canAccessTramite(db, id, user)) return null;
  const tramite = await db.prepare(`
    SELECT t.id, t.codigo, t.nombre, t.tipo_documento AS tipoDocumento, t.documento, t.correo,
           t.telefono, t.tipo, t.area AS areaSolicitada, t.asunto, t.descripcion,
           t.original_filename AS archivo, t.workflow_status AS estado, t.current_area_id AS currentAreaId,
           a.nombre AS ubicacion, t.created_at AS createdAt, t.updated_at AS updatedAt
    FROM tramites t LEFT JOIN areas a ON a.id = t.current_area_id WHERE t.id = ?
  `).bind(id).first();
  if (!tramite) return null;

  const [derivaciones, comentarios, historial, pending] = await Promise.all([
    db.prepare(`
      SELECT d.id, origin.nombre AS origen, destination.nombre AS destino,
             sender.username AS enviadoPor, receiver.username AS recibidoPor,
             d.comentario, d.visibility, d.sent_at AS sentAt, d.received_at AS receivedAt
      FROM derivaciones d
      JOIN areas origin ON origin.id = d.origin_area_id
      JOIN areas destination ON destination.id = d.destination_area_id
      JOIN users sender ON sender.id = d.sent_by
      LEFT JOIN users receiver ON receiver.id = d.received_by
      WHERE d.tramite_id = ? ORDER BY d.sent_at ASC, d.id ASC
    `).bind(id).all(),
    db.prepare(`
      SELECT c.id, c.mensaje, c.visibility, u.username AS autor, c.created_at AS createdAt
      FROM comentarios c JOIN users u ON u.id = c.user_id
      WHERE c.tramite_id = ? ORDER BY c.created_at ASC, c.id ASC
    `).bind(id).all(),
    db.prepare(`
      SELECT h.estado, h.nota, u.username AS usuario, h.created_at AS createdAt
      FROM historial h LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.tramite_id = ? ORDER BY h.created_at ASC, h.id ASC
    `).bind(id).all(),
    db.prepare(`
      SELECT id FROM derivaciones WHERE tramite_id = ? AND destination_area_id = ? AND received_at IS NULL
      ORDER BY sent_at DESC LIMIT 1
    `).bind(id, tramite.currentAreaId).first()
  ]);

  tramite.id = Number(tramite.id);
  tramite.currentAreaId = Number(tramite.currentAreaId);
  tramite.derivaciones = derivaciones.results;
  tramite.comentarios = comentarios.results;
  tramite.historial = historial.results;
  tramite.pendingReception = Boolean(pending);
  tramite.canOperate = await canOperateTramite(db, id, user);
  return tramite;
}

export async function deriveTramite(db, id, destinationAreaId, comentario, visibility, userId) {
  const [tramite, destination] = await Promise.all([
    db.prepare('SELECT current_area_id AS currentAreaId FROM tramites WHERE id = ?').bind(id).first(),
    db.prepare('SELECT id FROM areas WHERE id = ? AND activa = 1').bind(destinationAreaId).first()
  ]);
  if (!tramite || !destination || Number(tramite.currentAreaId) === destinationAreaId) return null;
  const now = new Date().toISOString();
  const results = await db.batch([
    db.prepare(`
      INSERT INTO derivaciones (tramite_id, origin_area_id, destination_area_id, sent_by, comentario, visibility, sent_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(id, tramite.currentAreaId, destinationAreaId, userId, comentario, visibility, now),
    db.prepare("UPDATE tramites SET current_area_id = ?, workflow_status = 'Derivado', estado = 'En revisión', updated_at = ? WHERE id = ?")
      .bind(destinationAreaId, now, id),
    db.prepare('INSERT INTO historial (tramite_id, estado, nota, changed_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, 'Derivado', 'El expediente fue derivado a otra área.', userId, now)
  ]);
  return { id: Number(results[0].meta.last_row_id), estado: 'Derivado', updatedAt: now };
}

export async function receiveTramite(db, id, userId) {
  const tramite = await db.prepare('SELECT current_area_id AS currentAreaId FROM tramites WHERE id = ?').bind(id).first();
  if (!tramite) return null;
  const pending = await db.prepare(`
    SELECT id FROM derivaciones WHERE tramite_id = ? AND destination_area_id = ? AND received_at IS NULL
    ORDER BY sent_at DESC, id DESC LIMIT 1
  `).bind(id, tramite.currentAreaId).first();
  if (!pending) return null;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare('UPDATE derivaciones SET received_by = ?, received_at = ? WHERE id = ?').bind(userId, now, pending.id),
    db.prepare("UPDATE tramites SET workflow_status = 'Recibido por área', estado = 'En revisión', updated_at = ? WHERE id = ?").bind(now, id),
    db.prepare('INSERT INTO historial (tramite_id, estado, nota, changed_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, 'Recibido por área', 'El área destinataria confirmó la recepción.', userId, now)
  ]);
  return { id, estado: 'Recibido por área', updatedAt: now };
}

export async function addComment(db, id, mensaje, visibility, userId) {
  if (!await db.prepare('SELECT id FROM tramites WHERE id = ?').bind(id).first()) return null;
  const now = new Date().toISOString();
  const results = await db.batch([
    db.prepare('INSERT INTO comentarios (tramite_id, user_id, mensaje, visibility, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, userId, mensaje, visibility, now),
    db.prepare('UPDATE tramites SET updated_at = ? WHERE id = ?').bind(now, id)
  ]);
  return { id: Number(results[0].meta.last_row_id), createdAt: now };
}

export async function updateTramiteStatus(db, id, workflowStatus, nota, userId) {
  const now = new Date().toISOString();
  const results = await db.batch([
    db.prepare('UPDATE tramites SET estado = ?, workflow_status = ?, updated_at = ? WHERE id = ?')
      .bind(legacyStatus(workflowStatus), workflowStatus, now, id),
    db.prepare(`
      INSERT INTO historial (tramite_id, estado, nota, changed_by, created_at)
      SELECT id, ?, ?, ?, ? FROM tramites WHERE id = ?
    `).bind(workflowStatus, nota || `Estado actualizado a ${workflowStatus}.`, userId, now, id)
  ]);
  if (!results[0].meta.changes) return null;
  return { id, estado: workflowStatus, updatedAt: now };
}

export async function getTramiteFile(db, id) {
  return db.prepare(`
    SELECT stored_filename AS storedFilename, original_filename AS originalFilename, mime_type AS mimeType
    FROM tramites WHERE id = ?
  `).bind(id).first();
}

export async function listUsers(db) {
  const result = await db.prepare(`
    SELECT u.id, u.username, u.role, u.area_id AS areaId, a.nombre AS area, u.active,
           u.created_at AS createdAt
    FROM users u LEFT JOIN areas a ON a.id = u.area_id
    ORDER BY CASE WHEN u.role = 'ADMIN' THEN 0 ELSE 1 END, a.nombre, u.username
  `).all();
  return result.results.map(user => ({
    ...user,
    id: Number(user.id),
    areaId: user.areaId === null ? null : Number(user.areaId),
    active: Boolean(user.active)
  }));
}

export async function createUser(db, { username, passwordHash, role, areaId }) {
  const result = await db.prepare(`
    INSERT INTO users (username, password_hash, role, area_id, active, created_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `).bind(username, passwordHash, role, areaId, new Date().toISOString()).run();
  return Number(result.meta.last_row_id);
}

export async function updateUser(db, id, { username, role, areaId, active, passwordHash }) {
  const statements = [
    db.prepare('UPDATE users SET username = ?, role = ?, area_id = ?, active = ? WHERE id = ?')
      .bind(username, role, areaId, active ? 1 : 0, id)
  ];
  if (passwordHash) statements.push(db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(passwordHash, id));
  statements.push(db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id));
  const results = await db.batch(statements);
  return Boolean(results[0].meta.changes);
}

export async function createArea(db, nombre) {
  const result = await db.prepare(
    'INSERT INTO areas (nombre, activa, created_at) VALUES (?, 1, ?)'
  ).bind(nombre, new Date().toISOString()).run();
  return Number(result.meta.last_row_id);
}

export async function updateArea(db, id, { nombre, activa }) {
  const result = await db.prepare(
    'UPDATE areas SET nombre = ?, activa = ? WHERE id = ?'
  ).bind(nombre, activa ? 1 : 0, id).run();
  return Boolean(result.meta.changes);
}

export async function getAreaUsage(db, id) {
  const [users, tramites] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS total FROM users WHERE area_id = ? AND active = 1').bind(id).first(),
    db.prepare('SELECT COUNT(*) AS total FROM tramites WHERE current_area_id = ?').bind(id).first()
  ]);
  return { users: Number(users.total), tramites: Number(tramites.total) };
}
