import assert from 'node:assert/strict';

const baseUrl = process.env.MP_TEST_URL || 'http://127.0.0.1:8787';
const credentials = {
  admin: requiredCredentials('MP_TEST_ADMIN'),
  mesa: requiredCredentials('MP_TEST_MESA'),
  tutoria: requiredCredentials('MP_TEST_TUTORIA'),
  secretaria: requiredCredentials('MP_TEST_SECRETARIA')
};

const health = await api('/api/health');
assert.equal(health.status, 'ok');

const admin = await signIn(credentials.admin);
const mesa = await signIn(credentials.mesa);
const tutoria = await signIn(credentials.tutoria);
const secretaria = await signIn(credentials.secretaria);
assert.equal(admin.user.role, 'ADMIN');
assert.equal(mesa.user.area, 'Mesa de Partes');
assert.equal(tutoria.user.area, 'Tutoría');

const form = new FormData();
for (const [key, value] of Object.entries({
  nombre: 'Prueba Integración Cloudflare',
  tipoDocumento: 'DNI',
  documento: '12345678',
  correo: 'prueba@example.com',
  telefono: '999888777',
  tipo: 'Solicitud',
  area: 'Tutoría',
  asunto: 'Prueba completa del flujo',
  descripcion: 'Expediente temporal para verificar el flujo completo.'
})) form.set(key, value);
form.set('archivo', new File([new TextEncoder().encode('%PDF-1.4\n% smoke test')], 'prueba.pdf', { type: 'application/pdf' }));

const created = await api('/api/tramites', { method: 'POST', body: form }, 201);
assert.match(created.codigo, /^MP-\d{4}-\d{5}$/);

const mesaInbox = await api('/api/admin/tramites?bandeja=entrada', {}, 200, mesa.cookie);
const item = mesaInbox.items.find(current => current.codigo === created.codigo);
assert.ok(item, 'El FUT nuevo no llegó a Mesa de Partes.');

const areas = await api('/api/admin/areas', {}, 200, mesa.cookie);
const tutoriaArea = areas.items.find(area => area.nombre === 'Tutoría');
assert.ok(tutoriaArea);
await api(`/api/admin/tramites/${item.id}/derive`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ destinationAreaId: tutoriaArea.id, comentario: 'Derivado para atención de tutoría.', visibility: 'PUBLIC' })
}, 201, mesa.cookie);

const mesaAfter = await api('/api/admin/tramites?bandeja=entrada', {}, 200, mesa.cookie);
assert.ok(!mesaAfter.items.some(current => current.id === item.id), 'El derivado permaneció en la bandeja de entrada de Mesa de Partes.');
const mesaSent = await api('/api/admin/tramites?bandeja=derivados', {}, 200, mesa.cookie);
assert.ok(mesaSent.items.some(current => current.id === item.id));

const tutoriaInbox = await api('/api/admin/tramites?bandeja=entrada', {}, 200, tutoria.cookie);
assert.ok(tutoriaInbox.items.some(current => current.id === item.id), 'Tutoría no recibió el expediente derivado.');
const detail = await api(`/api/admin/tramites/${item.id}`, {}, 200, tutoria.cookie);
assert.equal(detail.pendingReception, true);
assert.equal(detail.canOperate, true);
await api(`/api/admin/tramites/${item.id}/receive`, { method: 'POST' }, 200, tutoria.cookie);
await api(`/api/admin/tramites/${item.id}/comments`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mensaje: 'Solicitud revisada y atendida.', visibility: 'PUBLIC' })
}, 201, tutoria.cookie);
await api(`/api/admin/tramites/${item.id}/status`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ estado: 'Atendido', nota: 'Atención terminada en la prueba.' })
}, 200, tutoria.cookie);

await api(`/api/admin/tramites/${item.id}`, {}, 404, secretaria.cookie);
const adminDetail = await api(`/api/admin/tramites/${item.id}`, {}, 200, admin.cookie);
assert.equal(adminDetail.canOperate, false);
await api(`/api/admin/tramites/${item.id}/derive`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ destinationAreaId: tutoriaArea.id, comentario: 'No permitido.', visibility: 'INTERNAL' })
}, 403, admin.cookie);

const download = await fetch(`${baseUrl}/api/admin/tramites/${item.id}/archivo`, { headers: { Cookie: tutoria.cookie } });
assert.equal(download.status, 200);
assert.ok((await download.arrayBuffer()).byteLength > 0);

const publicTracking = await api(`/api/tramites/${created.codigo}?documento=12345678`);
assert.equal(publicTracking.estado, 'Atendido');
assert.ok(publicTracking.comentarios.some(comment => comment.mensaje === 'Solicitud revisada y atendida.'));

console.log(`Prueba completa correcta: ${created.codigo}`);

async function signIn({ username, password }) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  assert.equal(response.status, 200, `No se pudo iniciar sesión con ${username}.`);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  return { ...(await response.json()), cookie };
}

async function api(path, options = {}, expectedStatus = 200, cookie) {
  const headers = new Headers(options.headers || {});
  if (cookie) headers.set('Cookie', cookie);
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = response.status === 204 ? null : await response.json();
  assert.equal(response.status, expectedStatus, `${options.method || 'GET'} ${path}: ${JSON.stringify(body)}`);
  return body;
}

function requiredCredentials(prefix) {
  const username = process.env[`${prefix}_USER`];
  const password = process.env[`${prefix}_PASSWORD`];
  if (!username || !password) throw new Error(`Faltan ${prefix}_USER y ${prefix}_PASSWORD.`);
  return { username, password };
}
