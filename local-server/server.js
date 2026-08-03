import './config.js';
import express from 'express';
import multer from 'multer';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  addComment, canAccessTramite, canOperateTramite, createArea, createTramite, createUser,
  deriveTramite, findPublicTramite, getAreaUsage, getStats, getTramiteDetail, getTramiteFile,
  listAreas, listTramites, listUsers, receiveTramite, updateArea, updateTramiteStatus, updateUser
} from './db.js';
import { changePassword, destroySession, ensureAdmin, hashPassword, login, requireAuth, sessionCookie } from './auth.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const uploadDirectory = resolve(process.env.UPLOAD_PATH || 'uploads');
const maxFileSize = Number(process.env.MAX_FILE_MB || 10) * 1024 * 1024;
const allowedExtensions = new Set(['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png']);
const allowedMimeTypes = new Set(['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/jpeg', 'image/png']);
const statuses = new Set(['En atención', 'Observado', 'Atendido', 'Archivado']);
const trays = new Set(['todos', 'entrada', 'atencion', 'derivados', 'atendidos']);
const visibilities = new Set(['INTERNAL', 'PUBLIC']);
const documentTypes = new Set(['DNI', 'CE', 'RUC']);
mkdirSync(uploadDirectory, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDirectory,
    filename: (_req, file, callback) => callback(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: maxFileSize, files: 1 },
  fileFilter: (_req, file, callback) => {
    const valid = allowedExtensions.has(extname(file.originalname).toLowerCase()) && allowedMimeTypes.has(file.mimetype);
    callback(valid ? null : new Error('Tipo de archivo no permitido.'), valid);
  }
});

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use(express.static(resolve('public'), { extensions: ['html'], maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));

const attempts = new Map();
function loginRateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const current = attempts.get(key) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (now > current.resetAt) Object.assign(current, { count: 0, resetAt: now + 15 * 60 * 1000 });
  current.count += 1;
  attempts.set(key, current);
  if (current.count > 10) return res.status(429).json({ error: 'Demasiados intentos. Espere 15 minutos.' });
  next();
}

function requireAdminRole(req, res, next) {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Acceso exclusivo del administrador general.' });
  next();
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'mesa-partes-chinchaysuyo' }));

app.post('/api/tramites', upload.single('archivo'), (req, res, next) => {
  try {
    const data = validateTramite(req.body);
    const result = createTramite(data, req.file);
    res.status(201).json(result);
  } catch (error) {
    if (req.file?.path) safeDelete(req.file.path);
    if (error.status) return res.status(error.status).json({ error: error.message, fields: error.fields });
    next(error);
  }
});

app.get('/api/tramites/:codigo', (req, res) => {
  const codigo = clean(req.params.codigo, 30);
  const documento = clean(req.query.documento, 15);
  if (!/^MP-\d{4}-\d{5}$/.test(codigo) || !/^\d{8,11}$/.test(documento)) {
    return res.status(400).json({ error: 'Ingrese un expediente y documento válidos.' });
  }
  const tramite = findPublicTramite(codigo, documento);
  if (!tramite) return res.status(404).json({ error: 'No se encontró un expediente con esos datos.' });
  res.json(tramite);
});

app.post('/api/auth/login', loginRateLimit, async (req, res, next) => {
  try {
    const username = clean(req.body?.username, 50);
    const password = String(req.body?.password || '').trim();
    if (!username || !password) return res.status(400).json({ error: 'Ingrese usuario y contraseña.' });
    const result = await login(username, password);
    if (!result) return res.status(401).json({ error: 'Credenciales incorrectas.' });
    attempts.delete(req.ip);
    const maxAge = Math.max(0, Math.floor((new Date(result.expiresAt).getTime() - Date.now()) / 1000));
    res.setHeader('Set-Cookie', sessionCookie(result.token, maxAge));
    res.json({ user: result.user, expiresAt: result.expiresAt });
  } catch (error) { next(error); }
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));
app.post('/api/auth/logout', requireAuth, (req, res) => {
  destroySession(req.sessionToken);
  res.setHeader('Set-Cookie', sessionCookie('', 0));
  res.status(204).end();
});

app.post('/api/auth/change-password', requireAuth, async (req, res, next) => {
  try {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    if (newPassword.length < 12 || newPassword.length > 128) {
      return res.status(400).json({ error: 'La nueva contraseña debe tener entre 12 y 128 caracteres.' });
    }
    const changed = await changePassword(req.user.id, currentPassword, newPassword);
    if (!changed) return res.status(400).json({ error: 'La contraseña actual es incorrecta.' });
    res.setHeader('Set-Cookie', sessionCookie('', 0));
    res.status(204).end();
  } catch (error) { next(error); }
});

app.get('/api/admin/tramites', requireAuth, (req, res) => {
  const search = clean(req.query.search, 100);
  const bandeja = clean(req.query.bandeja, 20) || 'todos';
  if (!trays.has(bandeja)) return res.status(400).json({ error: 'Bandeja inválida.' });
  res.json({ items: listTramites({ search, bandeja, user: req.user }), stats: getStats(req.user) });
});

app.get('/api/admin/areas', requireAuth, (req, res) => {
  const includeInactive = req.user.role === 'ADMIN' && req.query.all === '1';
  res.json({ items: listAreas(includeInactive) });
});

app.get('/api/admin/users', requireAuth, requireAdminRole, (_req, res) => res.json({ items: listUsers() }));

app.post('/api/admin/users', requireAuth, requireAdminRole, async (req, res, next) => {
  try {
    const username = clean(req.body?.username, 50).replace(/\s+/g, '');
    const password = String(req.body?.password || '').trim();
    const areaId = Number(req.body?.areaId);
    if (!/^[A-Za-z0-9.]{4,50}$/.test(username) || password.length < 8 || password.length > 128 || !listAreas().some(area => area.id === areaId)) {
      return res.status(400).json({ error: 'Ingrese un usuario válido, una contraseña de al menos 8 caracteres y un área activa.' });
    }
    const id = createUser({ username, passwordHash: await hashPassword(password), role: 'OPERATOR', areaId });
    res.status(201).json({ id });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error: 'Ese nombre de usuario ya existe.' });
    next(error);
  }
});

app.patch('/api/admin/users/:id', requireAuth, requireAdminRole, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const target = listUsers().find(user => user.id === id);
    if (!target) return res.status(404).json({ error: 'Cuenta no encontrada.' });
    if (target.role === 'ADMIN') return res.status(403).json({ error: 'La cuenta administradora se modifica desde Cambiar clave.' });
    const username = clean(req.body?.username, 50).replace(/\s+/g, '');
    const areaId = Number(req.body?.areaId);
    const active = Boolean(req.body?.active);
    const password = String(req.body?.password || '').trim();
    if (!/^[A-Za-z0-9.]{4,50}$/.test(username) || !listAreas().some(area => area.id === areaId) || (password && password.length < 8)) {
      return res.status(400).json({ error: 'Revise el usuario, área y contraseña.' });
    }
    const passwordHash = password ? await hashPassword(password) : null;
    updateUser(id, { username, role: 'OPERATOR', areaId, active, passwordHash });
    res.json({ id });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error: 'Ese nombre de usuario ya existe.' });
    next(error);
  }
});

app.post('/api/admin/areas', requireAuth, requireAdminRole, (req, res, next) => {
  try {
    const nombre = clean(req.body?.nombre, 80);
    if (nombre.length < 3) return res.status(400).json({ error: 'Ingrese un nombre de área válido.' });
    res.status(201).json({ id: createArea(nombre) });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error: 'Esa área ya existe.' });
    next(error);
  }
});

app.patch('/api/admin/areas/:id', requireAuth, requireAdminRole, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const current = listAreas(true).find(area => area.id === id);
    if (!current) return res.status(404).json({ error: 'Área no encontrada.' });
    const nombre = clean(req.body?.nombre, 80);
    const activa = Boolean(req.body?.activa);
    if (current.nombre === 'Mesa de Partes' && (!activa || nombre !== current.nombre)) {
      return res.status(400).json({ error: 'Mesa de Partes es un área obligatoria y no puede modificarse.' });
    }
    const usage = getAreaUsage(id);
    if (!activa && (usage.users > 0 || usage.tramites > 0)) {
      return res.status(400).json({ error: 'Reasigne primero las cuentas y expedientes de esta área.' });
    }
    if (nombre.length < 3) return res.status(400).json({ error: 'Ingrese un nombre de área válido.' });
    updateArea(id, { nombre, activa });
    res.json({ id });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error: 'Esa área ya existe.' });
    next(error);
  }
});

app.get('/api/admin/tramites/:id', requireAuth, (req, res) => {
  const item = getTramiteDetail(Number(req.params.id), req.user);
  if (!item) return res.status(404).json({ error: 'Expediente no encontrado.' });
  res.json(item);
});

app.post('/api/admin/tramites/:id/derive', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const destinationAreaId = Number(req.body?.destinationAreaId);
  const comentario = clean(req.body?.comentario, 500);
  const visibility = clean(req.body?.visibility, 20) || 'INTERNAL';
  if (!Number.isInteger(id) || !Number.isInteger(destinationAreaId) || !comentario || !visibilities.has(visibility)) {
    return res.status(400).json({ error: 'Seleccione un área e ingrese el motivo de la derivación.' });
  }
  if (!canOperateTramite(id, req.user)) return res.status(403).json({ error: 'Este expediente no se encuentra en su área.' });
  const result = deriveTramite(id, destinationAreaId, comentario, visibility, req.user.id);
  if (!result) return res.status(400).json({ error: 'No se pudo derivar. Verifique que el destino sea diferente al área actual.' });
  res.status(201).json(result);
});

app.post('/api/admin/tramites/:id/receive', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!canOperateTramite(id, req.user)) return res.status(403).json({ error: 'Este expediente no se encuentra en su área.' });
  const result = receiveTramite(id, req.user.id);
  if (!result) return res.status(400).json({ error: 'Este expediente no tiene una derivación pendiente de recepción.' });
  res.json(result);
});

app.post('/api/admin/tramites/:id/comments', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const mensaje = clean(req.body?.mensaje, 500);
  const visibility = clean(req.body?.visibility, 20) || 'INTERNAL';
  if (!mensaje || !visibilities.has(visibility)) return res.status(400).json({ error: 'Ingrese un comentario válido.' });
  if (!canOperateTramite(id, req.user)) return res.status(403).json({ error: 'Este expediente no se encuentra en su área.' });
  const result = addComment(id, mensaje, visibility, req.user.id);
  if (!result) return res.status(404).json({ error: 'Expediente no encontrado.' });
  res.status(201).json(result);
});

app.patch('/api/admin/tramites/:id/status', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const estado = clean(req.body?.estado, 30);
  const nota = clean(req.body?.nota, 500);
  if (!Number.isInteger(id) || id < 1 || !statuses.has(estado)) return res.status(400).json({ error: 'Datos de actualización inválidos.' });
  if (!canOperateTramite(id, req.user)) return res.status(403).json({ error: 'Este expediente no se encuentra en su área.' });
  const result = updateTramiteStatus(id, estado, nota, req.user.id);
  if (!result) return res.status(404).json({ error: 'Expediente no encontrado.' });
  res.json(result);
});

app.get('/api/admin/tramites/:id/archivo', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!canAccessTramite(id, req.user)) return res.status(403).json({ error: 'No tiene acceso a este expediente.' });
  const file = getTramiteFile(id);
  if (!file?.storedFilename) return res.status(404).json({ error: 'Este trámite no tiene un archivo adjunto.' });
  const path = join(uploadDirectory, basename(file.storedFilename));
  if (!existsSync(path)) return res.status(404).json({ error: 'El archivo no está disponible.' });
  res.type(file.mimeType || 'application/octet-stream');
  res.download(path, file.originalFilename);
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));
app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE' ? `El archivo supera el límite de ${process.env.MAX_FILE_MB || 10} MB.` : 'No se pudo procesar el archivo.';
    return res.status(400).json({ error: message });
  }
  if (error.message === 'Tipo de archivo no permitido.') return res.status(400).json({ error: error.message });
  console.error(error);
  res.status(500).json({ error: 'Ocurrió un error interno. Intente nuevamente.' });
});

const initialAdmin = await ensureAdmin();
app.listen(port, () => {
  console.log(`Mesa de Partes disponible en http://localhost:${port}`);
  if (initialAdmin) {
    console.log('Credenciales administrativas iniciales:');
    console.log(`  Usuario: ${initialAdmin.username}`);
    console.log(`  Contraseña: ${initialAdmin.password}`);
    if (initialAdmin.generated) console.log('  Guarde esta contraseña: no volverá a mostrarse.');
  }
});

function validateTramite(body) {
  const data = {
    nombre: clean(body.nombre, 120), tipoDocumento: clean(body.tipoDocumento, 10),
    documento: clean(body.documento, 15), correo: clean(body.correo, 150).toLowerCase(),
    telefono: clean(body.telefono, 15), tipo: clean(body.tipo, 80), area: clean(body.area, 80),
    asunto: clean(body.asunto, 120), descripcion: clean(body.descripcion, 600)
  };
  const fields = {};
  if (data.nombre.length < 3) fields.nombre = 'Ingrese nombres y apellidos.';
  if (!documentTypes.has(data.tipoDocumento)) fields.tipoDocumento = 'Tipo de documento inválido.';
  if (!/^\d{8,11}$/.test(data.documento)) fields.documento = 'Ingrese entre 8 y 11 dígitos.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.correo)) fields.correo = 'Correo electrónico inválido.';
  if (!/^\d{9}$/.test(data.telefono)) fields.telefono = 'Ingrese un teléfono de 9 dígitos.';
  if (!data.tipo) fields.tipo = 'Seleccione el tipo de trámite.';
  if (!data.area) fields.area = 'Seleccione el área de destino.';
  if (data.asunto.length < 5) fields.asunto = 'El asunto debe tener al menos 5 caracteres.';
  if (data.descripcion.length < 10) fields.descripcion = 'La descripción debe tener al menos 10 caracteres.';
  if (Object.keys(fields).length) throw Object.assign(new Error('Revise los datos ingresados.'), { status: 400, fields });
  return data;
}

function clean(value, maxLength) {
  return String(value || '').trim().replace(/[\u0000-\u001F\u007F]/g, '').slice(0, maxLength);
}

function safeDelete(path) {
  try { unlinkSync(path); } catch { /* Nothing to remove. */ }
}
