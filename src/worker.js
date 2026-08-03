import {
  addComment, canAccessTramite, canOperateTramite, createArea, createTramite, createUser,
  deriveTramite, findPublicTramite, getAreaUsage, getStatsFromItems, getTramiteDetail,
  getTramiteFile, listAreas, listTramites, listUsers, receiveTramite, updateArea,
  updateTramiteStatus, updateUser
} from './db.js';
import {
  authenticate, changePassword, checkLoginRateLimit, clearLoginAttempts, destroySession,
  hashPassword, login, sessionCookie
} from './auth.js';

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png']);
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png'
]);
const STATUSES = new Set(['En atención', 'Observado', 'Atendido', 'Archivado']);
const TRAYS = new Set(['todos', 'entrada', 'atencion', 'derivados', 'atendidos']);
const VISIBILITIES = new Set(['INTERNAL', 'PUBLIC']);
const DOCUMENT_TYPES = new Set(['DNI', 'CE', 'RUC']);
const API_BODY_LIMIT = 100 * 1024;

class HttpError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) {
        return withSecurityHeaders(await routeApi(request, env, url));
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof HttpError) {
        return withSecurityHeaders(json({ error: error.message, ...(error.fields ? { fields: error.fields } : {}) }, error.status));
      }
      console.error(JSON.stringify({
        level: 'error',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        method: request.method,
        path: url.pathname
      }));
      return withSecurityHeaders(json({ error: 'Ocurrió un error interno. Intente nuevamente.' }, 500));
    }
  }
};

async function routeApi(request, env, url) {
  const { method } = request;
  const { pathname } = url;

  if (method === 'GET' && pathname === '/api/health') {
    return json({ status: 'ok', service: 'mesa-partes-chinchaysuyo' });
  }

  if (method === 'POST' && pathname === '/api/tramites') {
    return submitTramite(request, env);
  }

  const publicMatch = pathname.match(/^\/api\/tramites\/([^/]+)$/);
  if (method === 'GET' && publicMatch) {
    const codigo = clean(decodeURIComponent(publicMatch[1]), 30);
    const documento = clean(url.searchParams.get('documento'), 15);
    if (!/^MP-\d{4}-\d{5}$/.test(codigo) || !/^\d{8,11}$/.test(documento)) {
      throw new HttpError(400, 'Ingrese un expediente y documento válidos.');
    }
    const tramite = await findPublicTramite(env.DB, codigo, documento);
    if (!tramite) throw new HttpError(404, 'No se encontró un expediente con esos datos.');
    return json(tramite);
  }

  if (method === 'POST' && pathname === '/api/auth/login') {
    const rate = await checkLoginRateLimit(env.DB, request);
    if (!rate.allowed) throw new HttpError(429, 'Demasiados intentos. Espere 15 minutos.');
    const body = await readJson(request);
    const username = clean(body.username, 50);
    const password = String(body.password || '').trim();
    if (!username || !password) throw new HttpError(400, 'Ingrese usuario y contraseña.');
    const result = await login(env.DB, username, password, positiveNumber(env.SESSION_HOURS, 8));
    if (!result) throw new HttpError(401, 'Credenciales incorrectas.');
    await clearLoginAttempts(env.DB, rate.ipHash);
    const maxAge = Math.max(0, Math.floor((new Date(result.expiresAt).getTime() - Date.now()) / 1000));
    return json({ user: result.user, expiresAt: result.expiresAt }, 200, {
      'Set-Cookie': sessionCookie(result.token, maxAge)
    });
  }

  const auth = await authenticate(env.DB, request);
  if (!auth) throw new HttpError(401, 'La sesión venció o debe iniciar sesión nuevamente.');
  const user = auth.user;

  if (method === 'GET' && pathname === '/api/auth/me') return json({ user });

  if (method === 'POST' && pathname === '/api/auth/logout') {
    await destroySession(env.DB, auth.token);
    return new Response(null, { status: 204, headers: { 'Set-Cookie': sessionCookie('', 0) } });
  }

  if (method === 'POST' && pathname === '/api/auth/change-password') {
    const body = await readJson(request);
    const currentPassword = String(body.currentPassword || '');
    const newPassword = String(body.newPassword || '');
    if (newPassword.length < 12 || newPassword.length > 128) {
      throw new HttpError(400, 'La nueva contraseña debe tener entre 12 y 128 caracteres.');
    }
    const changed = await changePassword(env.DB, user.id, currentPassword, newPassword);
    if (!changed) throw new HttpError(400, 'La contraseña actual es incorrecta.');
    return new Response(null, { status: 204, headers: { 'Set-Cookie': sessionCookie('', 0) } });
  }

  if (method === 'GET' && pathname === '/api/admin/tramites') {
    const search = clean(url.searchParams.get('search'), 100);
    const bandeja = clean(url.searchParams.get('bandeja'), 20) || 'todos';
    if (!TRAYS.has(bandeja)) throw new HttpError(400, 'Bandeja inválida.');
    const allItems = await listTramites(env.DB, { search, bandeja: 'todos', user });
    const items = bandeja === 'todos' ? allItems : await listTramites(env.DB, { search, bandeja, user });
    return json({ items, stats: getStatsFromItems(allItems, user) });
  }

  if (method === 'GET' && pathname === '/api/admin/areas') {
    const includeInactive = user.role === 'ADMIN' && url.searchParams.get('all') === '1';
    return json({ items: await listAreas(env.DB, includeInactive) });
  }

  if (pathname === '/api/admin/users') {
    requireAdmin(user);
    if (method === 'GET') return json({ items: await listUsers(env.DB) });
    if (method === 'POST') return createOperator(request, env);
  }

  const userMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (method === 'PATCH' && userMatch) {
    requireAdmin(user);
    return editOperator(request, env, Number(userMatch[1]));
  }

  if (method === 'POST' && pathname === '/api/admin/areas') {
    requireAdmin(user);
    const body = await readJson(request);
    const nombre = clean(body.nombre, 80);
    if (nombre.length < 3) throw new HttpError(400, 'Ingrese un nombre de área válido.');
    try {
      return json({ id: await createArea(env.DB, nombre) }, 201);
    } catch (error) {
      if (isUniqueError(error)) throw new HttpError(409, 'Esa área ya existe.');
      throw error;
    }
  }

  const areaMatch = pathname.match(/^\/api\/admin\/areas\/(\d+)$/);
  if (method === 'PATCH' && areaMatch) {
    requireAdmin(user);
    return editArea(request, env, Number(areaMatch[1]));
  }

  const fileMatch = pathname.match(/^\/api\/admin\/tramites\/(\d+)\/archivo$/);
  if (method === 'GET' && fileMatch) return downloadFile(env, Number(fileMatch[1]), user);

  const actionMatch = pathname.match(/^\/api\/admin\/tramites\/(\d+)\/(derive|receive|comments)$/);
  if (method === 'POST' && actionMatch) {
    return handleCaseAction(request, env, Number(actionMatch[1]), actionMatch[2], user);
  }

  const statusMatch = pathname.match(/^\/api\/admin\/tramites\/(\d+)\/status$/);
  if (method === 'PATCH' && statusMatch) {
    return changeCaseStatus(request, env, Number(statusMatch[1]), user);
  }

  const detailMatch = pathname.match(/^\/api\/admin\/tramites\/(\d+)$/);
  if (method === 'GET' && detailMatch) {
    const item = await getTramiteDetail(env.DB, Number(detailMatch[1]), user);
    if (!item) throw new HttpError(404, 'Expediente no encontrado.');
    return json(item);
  }

  throw new HttpError(404, 'Ruta no encontrada.');
}

async function submitTramite(request, env) {
  const maximumBytes = positiveNumber(env.MAX_FILE_MB, 10) * 1024 * 1024;
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > maximumBytes + 1024 * 1024) throw new HttpError(413, `El envío supera el límite permitido.`);

  let form;
  try { form = await request.formData(); } catch { throw new HttpError(400, 'No se pudo procesar el formulario.'); }
  const data = validateTramite(Object.fromEntries(form.entries()));
  const candidate = form.get('archivo');
  const file = candidate instanceof File && candidate.name && candidate.size > 0 ? candidate : null;
  let storedFilename = null;

  if (file) {
    const extension = extensionOf(file.name);
    if (file.size > maximumBytes) throw new HttpError(400, `El archivo supera el límite de ${positiveNumber(env.MAX_FILE_MB, 10)} MB.`);
    if (!ALLOWED_EXTENSIONS.has(extension) || !ALLOWED_MIME_TYPES.has(file.type)) {
      throw new HttpError(400, 'Tipo de archivo no permitido.');
    }
    storedFilename = `${crypto.randomUUID()}${extension}`;
    await env.ARCHIVOS.put(storedFilename, file.stream(), {
      metadata: { originalFilename: file.name, mimeType: file.type, size: file.size }
    });
  }

  try {
    const result = await createTramite(env.DB, data, file ? {
      storedFilename,
      originalFilename: file.name,
      mimeType: file.type,
      size: file.size
    } : null);
    return json(result, 201);
  } catch (error) {
    if (storedFilename) await env.ARCHIVOS.delete(storedFilename);
    throw error;
  }
}

async function createOperator(request, env) {
  const body = await readJson(request);
  const username = clean(body.username, 50).replace(/\s+/g, '');
  const password = String(body.password || '').trim();
  const areaId = Number(body.areaId);
  const areas = await listAreas(env.DB);
  if (!/^[A-Za-z0-9.]{4,50}$/.test(username) || password.length < 8 || password.length > 128 || !areas.some(area => area.id === areaId)) {
    throw new HttpError(400, 'Ingrese un usuario válido, una contraseña de al menos 8 caracteres y un área activa.');
  }
  try {
    const id = await createUser(env.DB, { username, passwordHash: await hashPassword(password), role: 'OPERATOR', areaId });
    return json({ id }, 201);
  } catch (error) {
    if (isUniqueError(error)) throw new HttpError(409, 'Ese nombre de usuario ya existe.');
    throw error;
  }
}

async function editOperator(request, env, id) {
  const users = await listUsers(env.DB);
  const target = users.find(item => item.id === id);
  if (!target) throw new HttpError(404, 'Cuenta no encontrada.');
  if (target.role === 'ADMIN') throw new HttpError(403, 'La cuenta administradora se modifica desde Cambiar clave.');
  const body = await readJson(request);
  const username = clean(body.username, 50).replace(/\s+/g, '');
  const areaId = Number(body.areaId);
  const active = Boolean(body.active);
  const password = String(body.password || '').trim();
  const areas = await listAreas(env.DB);
  if (!/^[A-Za-z0-9.]{4,50}$/.test(username) || !areas.some(area => area.id === areaId) || (password && password.length < 8)) {
    throw new HttpError(400, 'Revise el usuario, área y contraseña.');
  }
  try {
    await updateUser(env.DB, id, {
      username,
      role: 'OPERATOR',
      areaId,
      active,
      passwordHash: password ? await hashPassword(password) : null
    });
    return json({ id });
  } catch (error) {
    if (isUniqueError(error)) throw new HttpError(409, 'Ese nombre de usuario ya existe.');
    throw error;
  }
}

async function editArea(request, env, id) {
  const current = (await listAreas(env.DB, true)).find(area => area.id === id);
  if (!current) throw new HttpError(404, 'Área no encontrada.');
  const body = await readJson(request);
  const nombre = clean(body.nombre, 80);
  const activa = Boolean(body.activa);
  if (current.nombre === 'Mesa de Partes' && (!activa || nombre !== current.nombre)) {
    throw new HttpError(400, 'Mesa de Partes es un área obligatoria y no puede modificarse.');
  }
  const usage = await getAreaUsage(env.DB, id);
  if (!activa && (usage.users > 0 || usage.tramites > 0)) {
    throw new HttpError(400, 'Reasigne primero las cuentas y expedientes de esta área.');
  }
  if (nombre.length < 3) throw new HttpError(400, 'Ingrese un nombre de área válido.');
  try {
    await updateArea(env.DB, id, { nombre, activa });
    return json({ id });
  } catch (error) {
    if (isUniqueError(error)) throw new HttpError(409, 'Esa área ya existe.');
    throw error;
  }
}

async function handleCaseAction(request, env, id, action, user) {
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Expediente inválido.');
  if (!await canOperateTramite(env.DB, id, user)) throw new HttpError(403, 'Este expediente no se encuentra en su área.');

  if (action === 'receive') {
    const result = await receiveTramite(env.DB, id, user.id);
    if (!result) throw new HttpError(400, 'Este expediente no tiene una derivación pendiente de recepción.');
    return json(result);
  }

  const body = await readJson(request);
  if (action === 'derive') {
    const destinationAreaId = Number(body.destinationAreaId);
    const comentario = clean(body.comentario, 500);
    const visibility = clean(body.visibility, 20) || 'INTERNAL';
    if (!Number.isInteger(destinationAreaId) || !comentario || !VISIBILITIES.has(visibility)) {
      throw new HttpError(400, 'Seleccione un área e ingrese el motivo de la derivación.');
    }
    const result = await deriveTramite(env.DB, id, destinationAreaId, comentario, visibility, user.id);
    if (!result) throw new HttpError(400, 'No se pudo derivar. Verifique que el destino sea diferente al área actual.');
    return json(result, 201);
  }

  const mensaje = clean(body.mensaje, 500);
  const visibility = clean(body.visibility, 20) || 'INTERNAL';
  if (!mensaje || !VISIBILITIES.has(visibility)) throw new HttpError(400, 'Ingrese un comentario válido.');
  const result = await addComment(env.DB, id, mensaje, visibility, user.id);
  if (!result) throw new HttpError(404, 'Expediente no encontrado.');
  return json(result, 201);
}

async function changeCaseStatus(request, env, id, user) {
  const body = await readJson(request);
  const estado = clean(body.estado, 30);
  const nota = clean(body.nota, 500);
  if (!Number.isInteger(id) || id < 1 || !STATUSES.has(estado)) throw new HttpError(400, 'Datos de actualización inválidos.');
  if (!await canOperateTramite(env.DB, id, user)) throw new HttpError(403, 'Este expediente no se encuentra en su área.');
  const result = await updateTramiteStatus(env.DB, id, estado, nota, user.id);
  if (!result) throw new HttpError(404, 'Expediente no encontrado.');
  return json(result);
}

async function downloadFile(env, id, user) {
  if (!await canAccessTramite(env.DB, id, user)) throw new HttpError(403, 'No tiene acceso a este expediente.');
  const file = await getTramiteFile(env.DB, id);
  if (!file?.storedFilename) throw new HttpError(404, 'Este trámite no tiene un archivo adjunto.');
  const value = await env.ARCHIVOS.get(file.storedFilename, { type: 'stream' });
  if (!value) throw new HttpError(404, 'El archivo no está disponible.');
  const original = file.originalFilename || 'archivo';
  const fallback = original.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return new Response(value, {
    headers: {
      'Content-Type': file.mimeType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(original)}`,
      'Cache-Control': 'private, no-store'
    }
  });
}

function validateTramite(body) {
  const data = {
    nombre: clean(body.nombre, 120),
    tipoDocumento: clean(body.tipoDocumento, 10),
    documento: clean(body.documento, 15),
    correo: clean(body.correo, 150).toLowerCase(),
    telefono: clean(body.telefono, 15),
    tipo: clean(body.tipo, 80),
    area: clean(body.area, 80),
    asunto: clean(body.asunto, 120),
    descripcion: clean(body.descripcion, 600)
  };
  const fields = {};
  if (data.nombre.length < 3) fields.nombre = 'Ingrese nombres y apellidos.';
  if (!DOCUMENT_TYPES.has(data.tipoDocumento)) fields.tipoDocumento = 'Tipo de documento inválido.';
  if (!/^\d{8,11}$/.test(data.documento)) fields.documento = 'Ingrese entre 8 y 11 dígitos.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.correo)) fields.correo = 'Correo electrónico inválido.';
  if (!/^\d{9}$/.test(data.telefono)) fields.telefono = 'Ingrese un teléfono de 9 dígitos.';
  if (!data.tipo) fields.tipo = 'Seleccione el tipo de trámite.';
  if (!data.area) fields.area = 'Seleccione el área de destino.';
  if (data.asunto.length < 5) fields.asunto = 'El asunto debe tener al menos 5 caracteres.';
  if (data.descripcion.length < 10) fields.descripcion = 'La descripción debe tener al menos 10 caracteres.';
  if (Object.keys(fields).length) throw new HttpError(400, 'Revise los datos ingresados.', fields);
  return data;
}

async function readJson(request) {
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > API_BODY_LIMIT) throw new HttpError(413, 'La solicitud es demasiado grande.');
  try { return await request.json(); } catch { throw new HttpError(400, 'La solicitud no contiene JSON válido.'); }
}

function requireAdmin(user) {
  if (user.role !== 'ADMIN') throw new HttpError(403, 'Acceso exclusivo del administrador general.');
}

function json(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function clean(value, maxLength) {
  return String(value || '').trim().replace(/[\u0000-\u001F\u007F]/g, '').slice(0, maxLength);
}

function extensionOf(filename) {
  const cleanName = String(filename).replace(/\\/g, '/').split('/').pop();
  const index = cleanName.lastIndexOf('.');
  return index >= 0 ? cleanName.slice(index).toLowerCase() : '';
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function isUniqueError(error) {
  return /UNIQUE constraint failed/i.test(String(error?.message || error));
}
