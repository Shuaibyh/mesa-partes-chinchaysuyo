let currentAdmin = null;
let filterTimer;
let loginInProgress = false;
let activeTray = 'todos';
let availableAreas = [];
let currentCaseId = null;

const normalize = (value) => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const statusClass = (status) => normalize(status).replace(/ /g, '-');
const formatDate = (iso) => new Intl.DateTimeFormat('es-PE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

async function showView(id) {
  document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === id));
  document.querySelectorAll('.nav-link').forEach(link => link.classList.toggle('active', link.dataset.view === id));
  document.querySelector('.nav').classList.remove('open');
  document.querySelector('.menu-button').setAttribute('aria-expanded', 'false');
  if (id === 'administracion') await openAdmin();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
document.querySelector('.menu-button').addEventListener('click', (event) => {
  const nav = document.querySelector('.nav');
  nav.classList.toggle('open');
  event.currentTarget.setAttribute('aria-expanded', nav.classList.contains('open'));
});

document.querySelector('[name="descripcion"]').addEventListener('input', (event) => {
  document.querySelector('.counter').textContent = `${event.target.value.length} / 600`;
});

document.querySelector('#tramite-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const file = form.elements.archivo.files[0];
  if (file && file.size > 10 * 1024 * 1024) return toast('El archivo supera el límite de 10 MB.', true);
  setLoading(true);
  try {
    const response = await fetch('/api/tramites', { method: 'POST', body: new FormData(form) });
    const result = await readResponse(response);
    document.querySelector('#new-code').textContent = result.codigo;
    document.querySelector('#success-modal').classList.add('open');
    form.reset();
    document.querySelector('.counter').textContent = '0 / 600';
  } catch (error) { toast(error.message, true); }
  finally { setLoading(false); }
});

document.querySelector('#copy-code').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(document.querySelector('#new-code').textContent);
    toast('Código copiado');
  } catch { toast('No se pudo copiar el código.', true); }
});

document.querySelector('#close-success').addEventListener('click', () => {
  const code = document.querySelector('#new-code').textContent;
  document.querySelector('#success-modal').classList.remove('open');
  document.querySelector('#codigo-consulta').value = code;
  showView('consultar');
});

document.querySelector('#consulta-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = document.querySelector('#codigo-consulta').value.trim().toUpperCase();
  const documento = document.querySelector('#documento-consulta').value.trim();
  const target = document.querySelector('#resultado-consulta');
  setLoading(true);
  try {
    const response = await fetch(`/api/tramites/${encodeURIComponent(code)}?documento=${encodeURIComponent(documento)}`);
    renderResult(await readResponse(response));
  } catch (error) {
    target.innerHTML = `<div class="not-found"><strong>No se pudo consultar</strong><br>${escapeHtml(error.message)}</div>`;
  } finally { setLoading(false); }
});

function renderResult(item) {
  const history = (item.historial || []).map(entry => `<div class="event"><strong>${escapeHtml(entry.estado)}</strong><p>${escapeHtml(entry.nota)}</p><small>${formatDate(entry.createdAt)}</small></div>`).join('');
  const comments = (item.comentarios || []).map(entry => `<div class="public-comment"><strong>Mensaje de la institución</strong><p>${escapeHtml(entry.mensaje)}</p><small>${formatDate(entry.createdAt)}</small></div>`).join('');
  document.querySelector('#resultado-consulta').innerHTML = `<article class="result-card">
    <div class="result-top"><div><small>Expediente</small><h2>${escapeHtml(item.codigo)}</h2></div><span class="badge ${statusClass(item.estado)}">${escapeHtml(item.estado)}</span></div>
    <div class="result-grid"><div><small>Solicitante</small><strong>${escapeHtml(item.nombre)}</strong></div><div><small>Fecha de registro</small><strong>${formatDate(item.createdAt)}</strong></div><div><small>Tipo de trámite</small><strong>${escapeHtml(item.tipo)}</strong></div><div><small>Ubicación actual</small><strong>${escapeHtml(item.ubicacion || item.area)}</strong></div><div><small>Asunto</small><strong>${escapeHtml(item.asunto)}</strong></div><div><small>Documento adjunto</small><strong>${escapeHtml(item.archivo || 'Sin archivo')}</strong></div></div>
    <h3 class="public-history-title">Seguimiento del trámite</h3><div class="event-list public-history">${history}</div>
    ${comments ? `<div class="public-comments">${comments}</div>` : ''}
  </article>`;
}

async function openAdmin() {
  if (!currentAdmin) {
    try {
      const response = await fetch('/api/auth/me');
      if (response.ok) currentAdmin = (await response.json()).user;
    } catch { /* The login screen remains available. */ }
  }
  toggleAdmin(Boolean(currentAdmin));
  if (currentAdmin) {
    await loadAreas();
    await renderAdmin();
  }
}

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (loginInProgress) return;
  loginInProgress = true;
  const loginForm = event.currentTarget;
  const errorBox = document.querySelector('#login-error');
  const submitButton = loginForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  errorBox.textContent = '';
  const form = new FormData(loginForm);
  setLoading(true);
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ username: form.get('username').replace(/\s+/g, ''), password: form.get('password').trim() })
    });
    const result = await readResponse(response);
    currentAdmin = result.user;
    loginForm.reset();
    toggleAdmin(true);
    await loadAreas();
    await renderAdmin();
  } catch (error) { errorBox.textContent = error.message; }
  finally {
    loginInProgress = false;
    submitButton.disabled = false;
    setLoading(false);
  }
});

document.querySelector('#logout-button').addEventListener('click', async () => {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* Close the local view regardless. */ }
  currentAdmin = null;
  toggleAdmin(false);
});

document.querySelector('#change-password-button').addEventListener('click', () => {
  document.querySelector('#password-error').textContent = '';
  document.querySelector('#password-modal').classList.add('open');
});
document.querySelector('#cancel-password').addEventListener('click', () => {
  document.querySelector('#password-modal').classList.remove('open');
  document.querySelector('#password-form').reset();
});
document.querySelector('#password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const passwordForm = event.currentTarget;
  const form = new FormData(passwordForm);
  const errorBox = document.querySelector('#password-error');
  errorBox.textContent = '';
  if (form.get('newPassword') !== form.get('confirmation')) {
    errorBox.textContent = 'Las contraseñas nuevas no coinciden.';
    return;
  }
  setLoading(true);
  try {
    const response = await fetch('/api/auth/change-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: form.get('currentPassword'), newPassword: form.get('newPassword') })
    });
    await readResponse(response);
    passwordForm.reset();
    document.querySelector('#password-modal').classList.remove('open');
    currentAdmin = null;
    toggleAdmin(false);
    toast('Contraseña actualizada. Inicie sesión nuevamente.');
  } catch (error) { errorBox.textContent = error.message; }
  finally { setLoading(false); }
});

function toggleAdmin(authenticated) {
  document.querySelector('#admin-login').classList.toggle('hidden', authenticated);
  document.querySelector('#admin-content').classList.toggle('hidden', !authenticated);
  document.querySelector('#manage-system-button').classList.toggle('hidden', !authenticated || currentAdmin.role !== 'ADMIN');
  if (authenticated) {
    const scope = currentAdmin.role === 'ADMIN' ? 'Acceso general' : currentAdmin.area || 'Área no asignada';
    document.querySelector('#session-context').textContent = `${currentAdmin.username} · ${scope}`;
  }
}

document.querySelector('#manage-system-button').addEventListener('click', openSettings);
document.querySelector('#close-settings').addEventListener('click', () => document.querySelector('#settings-modal').classList.remove('open'));

async function openSettings() {
  setLoading(true);
  try {
    const [usersResponse, areasResponse] = await Promise.all([
      fetch('/api/admin/users'), fetch('/api/admin/areas?all=1')
    ]);
    const users = (await readResponse(usersResponse)).items;
    const areas = (await readResponse(areasResponse)).items;
    renderSettings(users, areas);
    document.querySelector('#settings-modal').classList.add('open');
  } catch (error) { toast(error.message, true); }
  finally { setLoading(false); }
}

function renderSettings(users, areas) {
  const activeAreas = areas.filter(area => area.activa);
  const areaOptions = (selectedId) => activeAreas.map(area => `<option value="${area.id}" ${area.id === selectedId ? 'selected' : ''}>${escapeHtml(area.nombre)}</option>`).join('');
  const administrators = users.filter(user => user.role === 'ADMIN');
  const operators = users.filter(user => user.role === 'OPERATOR');
  document.querySelector('#settings-content').innerHTML = `
    <section class="settings-section">
      <div class="settings-section-heading"><div><h3>Cuentas del personal</h3><p>Los operadores solo ven los FUT ubicados actualmente en su área.</p></div><span class="settings-count">${operators.length} operadores</span></div>
      <div class="admin-account-summary"><strong>${administrators.map(user => escapeHtml(user.username)).join(' · ')}</strong><span>${administrators.length} administradores generales · Solo lectura de FUT</span></div>
      <form id="create-user-form" class="create-settings-form">
        <label class="field"><span>Nuevo usuario</span><input name="username" required pattern="[A-Za-z0-9.]{4,50}" placeholder="Ej. SecretariaMaria"></label>
        <label class="field"><span>Contraseña inicial</span><input name="password" required minlength="8" maxlength="128" placeholder="Mínimo 8 caracteres"></label>
        <label class="field"><span>Área</span><select name="areaId" required><option value="">Seleccionar</option>${areaOptions(null)}</select></label>
        <button class="button primary" type="submit">Crear cuenta</button>
      </form>
      <div class="settings-table-wrap"><table class="settings-table"><thead><tr><th>Usuario</th><th>Área asignada</th><th>Nueva contraseña</th><th>Activa</th><th></th></tr></thead><tbody>
        ${operators.map(user => `<tr data-user-id="${user.id}">
          <td><input class="setting-input user-name" value="${escapeHtml(user.username)}" aria-label="Usuario"></td>
          <td><select class="setting-input user-area" aria-label="Área">${areaOptions(user.areaId)}</select></td>
          <td><input class="setting-input user-password" type="password" minlength="8" placeholder="Sin cambios" aria-label="Nueva contraseña"></td>
          <td><label class="compact-check"><input class="user-active" type="checkbox" ${user.active ? 'checked' : ''}><span>${user.active ? 'Sí' : 'No'}</span></label></td>
          <td><button class="save-setting save-user" type="button">Guardar</button></td>
        </tr>`).join('')}
      </tbody></table></div>
    </section>
    <section class="settings-section">
      <div class="settings-section-heading"><div><h3>Áreas institucionales</h3><p>Mesa de Partes es obligatoria y recibe todos los FUT nuevos.</p></div><span class="settings-count">${areas.filter(area => area.activa).length} activas</span></div>
      <form id="create-area-form" class="create-area-form"><label class="field"><span>Nueva área</span><input name="nombre" required minlength="3" maxlength="80" placeholder="Nombre de la dependencia"></label><button class="button primary" type="submit">Crear área</button></form>
      <div class="area-settings-list">${areas.map(area => `<div class="area-setting" data-area-id="${area.id}" data-required="${area.nombre === 'Mesa de Partes'}"><input class="setting-input area-name" value="${escapeHtml(area.nombre)}" ${area.nombre === 'Mesa de Partes' ? 'disabled' : ''}><label class="compact-check"><input class="area-active" type="checkbox" ${area.activa ? 'checked' : ''} ${area.nombre === 'Mesa de Partes' ? 'disabled' : ''}><span>Activa</span></label><button class="save-setting save-area" type="button" ${area.nombre === 'Mesa de Partes' ? 'disabled' : ''}>Guardar</button></div>`).join('')}</div>
    </section>`;

  document.querySelector('#create-user-form').addEventListener('submit', createStaffUser);
  document.querySelector('#create-area-form').addEventListener('submit', createInstitutionArea);
  document.querySelectorAll('.save-user').forEach(button => button.addEventListener('click', () => saveStaffUser(button.closest('tr'))));
  document.querySelectorAll('.save-area').forEach(button => button.addEventListener('click', () => saveInstitutionArea(button.closest('.area-setting'))));
  document.querySelectorAll('.user-active').forEach(input => input.addEventListener('change', () => { input.nextElementSibling.textContent = input.checked ? 'Sí' : 'No'; }));
}

async function createStaffUser(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  await settingsAction('/api/admin/users', 'POST', { username: form.get('username'), password: form.get('password'), areaId: Number(form.get('areaId')) }, 'Cuenta creada');
}

async function saveStaffUser(row) {
  await settingsAction(`/api/admin/users/${row.dataset.userId}`, 'PATCH', {
    username: row.querySelector('.user-name').value,
    areaId: Number(row.querySelector('.user-area').value),
    password: row.querySelector('.user-password').value,
    active: row.querySelector('.user-active').checked
  }, 'Cuenta actualizada');
}

async function createInstitutionArea(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await settingsAction('/api/admin/areas', 'POST', { nombre: form.get('nombre') }, 'Área creada');
}

async function saveInstitutionArea(element) {
  await settingsAction(`/api/admin/areas/${element.dataset.areaId}`, 'PATCH', {
    nombre: element.querySelector('.area-name').value,
    activa: element.querySelector('.area-active').checked
  }, 'Área actualizada');
}

async function settingsAction(url, method, body, successMessage) {
  setLoading(true);
  try {
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await readResponse(response);
    toast(successMessage);
    await loadAreas();
    await openSettings();
  } catch (error) { toast(error.message, true); }
  finally { setLoading(false); }
}

async function renderAdmin() {
  const search = document.querySelector('#filtro').value.trim();
  try {
    const response = await fetch(`/api/admin/tramites?search=${encodeURIComponent(search)}&bandeja=${encodeURIComponent(activeTray)}`);
    if (response.status === 401) {
      currentAdmin = null;
      toggleAdmin(false);
      return;
    }
    const { items, stats } = await readResponse(response);
    renderStats(stats);
    renderRows(items);
  } catch (error) { toast(error.message, true); }
}

function renderStats(stats) {
  const data = [['Total de trámites', stats.total], ['Bandeja de entrada', stats.entrada], ['En atención', stats.enAtencion], ['Atendidos', stats.atendidos]];
  document.querySelector('#stats').innerHTML = data.map(([label, count]) => `<div class="stat"><small>${label}</small><strong>${count}</strong></div>`).join('');
}

function renderRows(items) {
  const body = document.querySelector('#tramites-body');
  body.innerHTML = items.map(item => `<tr>
    <td><strong>${escapeHtml(item.codigo)}</strong></td><td>${escapeHtml(item.nombre)}<small>${escapeHtml(item.tipoDocumento)} ${escapeHtml(item.documento)}</small></td>
    <td>${escapeHtml(item.tipo)}<small>${escapeHtml(item.asunto)}</small></td><td><strong>${escapeHtml(item.ubicacion || 'Mesa de Partes')}</strong><small>Área solicitada: ${escapeHtml(item.area)}</small></td>
    <td><span class="badge ${statusClass(item.estado)}">${escapeHtml(item.estado)}</span></td>
    <td>${formatDate(item.updatedAt)}</td><td><button class="open-case" data-id="${item.id}">Abrir</button></td>
  </tr>`).join('');
  document.querySelector('#empty-state').style.display = items.length ? 'none' : 'block';
  document.querySelector('.table-scroll').style.display = items.length ? 'block' : 'none';
  document.querySelectorAll('.open-case').forEach(button => button.addEventListener('click', () => openCase(Number(button.dataset.id))));
}

async function loadAreas() {
  try {
    const response = await fetch('/api/admin/areas');
    availableAreas = (await readResponse(response)).items;
  } catch (error) { toast(error.message, true); }
}

async function openCase(id) {
  currentCaseId = id;
  setLoading(true);
  try {
    const response = await fetch(`/api/admin/tramites/${id}`);
    renderCase(await readResponse(response));
    document.querySelector('#expediente-modal').classList.add('open');
  } catch (error) { toast(error.message, true); }
  finally { setLoading(false); }
}

function renderCase(item) {
  const areaOptions = availableAreas
    .filter(area => area.id !== item.currentAreaId)
    .map(area => `<option value="${area.id}">${escapeHtml(area.nombre)}</option>`).join('');
  const events = buildEvents(item);
  document.querySelector('#expediente-detail').innerHTML = `
    <header class="case-header">
      <span class="eyebrow">Expediente interno</span>
      <div class="case-title-row"><h2 id="expediente-title">${escapeHtml(item.codigo)}</h2><span class="badge ${statusClass(item.estado)}">${escapeHtml(item.estado)}</span></div>
      <div class="case-location">Ubicación actual: <strong>${escapeHtml(item.ubicacion)}</strong></div>
    </header>
    <section class="case-section">
      <h3>Datos principales</h3>
      <div class="case-grid">
        <div class="case-field"><small>Solicitante</small><strong>${escapeHtml(item.nombre)}</strong></div>
        <div class="case-field"><small>Documento</small><span>${escapeHtml(item.tipoDocumento)} ${escapeHtml(item.documento)}</span></div>
        <div class="case-field"><small>Correo</small><span>${escapeHtml(item.correo)}</span></div>
        <div class="case-field"><small>Teléfono</small><span>${escapeHtml(item.telefono)}</span></div>
        <div class="case-field"><small>Tipo</small><span>${escapeHtml(item.tipo)}</span></div>
        <div class="case-field"><small>Área solicitada</small><span>${escapeHtml(item.areaSolicitada)}</span></div>
        <div class="case-field wide"><small>Asunto</small><strong>${escapeHtml(item.asunto)}</strong></div>
        <div class="case-field wide"><small>Descripción</small><span>${escapeHtml(item.descripcion)}</span></div>
        <div class="case-field"><small>Registrado</small><span>${formatDate(item.createdAt)}</span></div>
        <div class="case-field"><small>Adjunto</small>${item.archivo ? `<a class="file-link" href="/api/admin/tramites/${item.id}/archivo">Descargar ${escapeHtml(item.archivo)}</a>` : '<span>Sin archivo</span>'}</div>
      </div>
    </section>
    <section class="case-section">
      <h3>Acciones del expediente</h3>
      ${item.pendingReception ? `<div class="receive-strip"><p>Este expediente está pendiente de recepción en <strong>${escapeHtml(item.ubicacion)}</strong>.</p><button class="button primary" id="receive-case">Confirmar recepción</button></div>` : ''}
      <div class="workflow-actions">
        <form class="workflow-form" id="derive-form"><h4>Derivar a otra área</h4><p>Envía el expediente y deja constancia del motivo.</p>
          <label class="field"><span>Área de destino</span><select name="destinationAreaId" required><option value="">Seleccionar área</option>${areaOptions}</select></label>
          <label class="field"><span>Motivo de derivación</span><textarea name="comentario" required maxlength="500" placeholder="Indique qué debe atender el área destinataria"></textarea></label>
          <div class="inline-fields"><label class="field"><span>Visibilidad</span><select name="visibility"><option value="INTERNAL">Solo personal</option><option value="PUBLIC">Visible al solicitante</option></select></label><button class="button primary" type="submit">Derivar</button></div>
        </form>
        <form class="workflow-form" id="comment-form"><h4>Agregar comentario</h4><p>Registra una actuación o respuesta en el expediente.</p>
          <label class="field"><span>Comentario</span><textarea name="mensaje" required maxlength="500" placeholder="Escriba el comentario"></textarea></label>
          <div class="inline-fields"><label class="field"><span>Visibilidad</span><select name="visibility"><option value="INTERNAL">Solo personal</option><option value="PUBLIC">Visible al solicitante</option></select></label><button class="button secondary" type="submit">Guardar</button></div>
        </form>
      </div>
      <form class="workflow-form status-action" id="status-form">
        <label class="field"><span>Avanzar estado</span><select name="estado" required><option value="En atención">En atención</option><option value="Observado">Observado</option><option value="Atendido">Atendido</option><option value="Archivado">Archivado</option></select></label>
        <label class="field"><span>Nota del cambio</span><input name="nota" maxlength="500" placeholder="Detalle opcional"></label>
        <button class="button primary" type="submit">Actualizar estado</button>
      </form>
    </section>
    <section class="case-section"><h3>Flujo y trazabilidad</h3><div class="event-list">${events || '<p class="empty-events">Todavía no hay movimientos registrados.</p>'}</div></section>`;

  if (item.canOperate) {
    document.querySelector('#derive-form').addEventListener('submit', submitDerivation);
    document.querySelector('#comment-form').addEventListener('submit', submitComment);
    document.querySelector('#status-form').addEventListener('submit', submitStatus);
    document.querySelector('#receive-case')?.addEventListener('click', receiveCase);
  } else {
    const actionsSection = document.querySelector('#derive-form').closest('.case-section');
    actionsSection.innerHTML = '<h3>Acciones del expediente</h3><p class="read-only-notice">Este expediente ya no se encuentra en su área. Puede consultar su trazabilidad, pero no modificarlo.</p>';
  }
}

function buildEvents(item) {
  const events = item.historial
    .filter(entry => !['Derivado', 'Recibido por área'].includes(entry.estado))
    .map(entry => ({ date: entry.createdAt, type: 'status', title: entry.estado, text: entry.nota, meta: entry.usuario || 'Sistema' }));
  item.derivaciones.forEach(entry => {
    events.push({ date: entry.sentAt, type: 'route', title: `${entry.origen} → ${entry.destino}`, text: entry.comentario, meta: `Derivado por ${entry.enviadoPor} · ${entry.visibility === 'PUBLIC' ? 'Público' : 'Interno'}` });
    if (entry.receivedAt) events.push({ date: entry.receivedAt, type: 'status', title: `Recibido en ${entry.destino}`, text: 'Recepción confirmada por el área.', meta: entry.recibidoPor });
  });
  item.comentarios.forEach(entry => events.push({ date: entry.createdAt, type: 'comment', title: 'Comentario', text: entry.mensaje, meta: `${entry.autor} · ${entry.visibility === 'PUBLIC' ? 'Público' : 'Interno'}` }));
  return events.sort((a, b) => new Date(a.date) - new Date(b.date)).map(event => `<div class="event ${event.type === 'comment' ? 'event-comment' : ''}"><strong>${escapeHtml(event.title)}</strong><p>${escapeHtml(event.text)}</p><small>${formatDate(event.date)} · ${escapeHtml(event.meta || '')}</small></div>`).join('');
}

async function submitDerivation(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  await caseAction(`/api/admin/tramites/${currentCaseId}/derive`, 'POST', { destinationAreaId: Number(data.get('destinationAreaId')), comentario: data.get('comentario'), visibility: data.get('visibility') }, 'Expediente derivado');
}

async function receiveCase() {
  await caseAction(`/api/admin/tramites/${currentCaseId}/receive`, 'POST', {}, 'Recepción confirmada');
}

async function submitComment(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  await caseAction(`/api/admin/tramites/${currentCaseId}/comments`, 'POST', { mensaje: data.get('mensaje'), visibility: data.get('visibility') }, 'Comentario registrado');
}

async function submitStatus(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  await caseAction(`/api/admin/tramites/${currentCaseId}/status`, 'PATCH', { estado: data.get('estado'), nota: data.get('nota') }, 'Estado actualizado');
}

async function caseAction(url, method, body, successMessage) {
  setLoading(true);
  try {
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await readResponse(response);
    toast(successMessage);
    await renderAdmin();
    await openCase(currentCaseId);
  } catch (error) { toast(error.message, true); }
  finally { setLoading(false); }
}

async function readResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'No se pudo completar la operación.');
  return data;
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}

function toast(message, isError = false) {
  const element = document.querySelector('#toast');
  element.textContent = message;
  element.style.background = isError ? 'var(--red)' : 'var(--ink)';
  element.classList.add('show');
  setTimeout(() => element.classList.remove('show'), 3000);
}

function setLoading(visible) { document.querySelector('#loading').classList.toggle('show', visible); }

document.querySelector('#filtro').addEventListener('input', () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(renderAdmin, 250);
});
document.querySelectorAll('.workflow-tab').forEach(tab => tab.addEventListener('click', () => {
  activeTray = tab.dataset.tray;
  document.querySelectorAll('.workflow-tab').forEach(item => item.classList.toggle('active', item === tab));
  renderAdmin();
}));
document.querySelector('#close-expediente').addEventListener('click', () => {
  document.querySelector('#expediente-modal').classList.remove('open');
  currentCaseId = null;
});
document.querySelector('#year').textContent = new Date().getFullYear();
