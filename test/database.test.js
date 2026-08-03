import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('persiste el flujo de derivación, recepción y comentarios', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mesa-partes-'));
  process.env.DATABASE_PATH = join(directory, 'test.db');
  const database = await import(`../local-server/db.js?test=${Date.now()}`);
  try {
    const created = database.createTramite({
      nombre: 'Persona de Prueba', tipoDocumento: 'DNI', documento: '12345678',
      correo: 'prueba@example.com', telefono: '987654321', tipo: 'Solicitud',
      area: 'Secretaría', asunto: 'Solicitud de prueba', descripcion: 'Descripción de prueba válida.'
    });
    const user = database.db.prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES ('administrador', 'salt:hash', 'ADMIN', ?)")
      .run(new Date().toISOString());

    assert.match(created.codigo, /^MP-\d{4}-00001$/);
    const publicRecord = database.findPublicTramite(created.codigo, '12345678');
    assert.equal(publicRecord.estado, 'Recibido por Mesa de Partes');
    assert.equal(publicRecord.historial.length, 1);

    const secretaria = database.listAreas().find(area => area.nombre === 'Secretaría');
    const direccion = database.listAreas().find(area => area.nombre === 'Dirección');
    const mesaPartes = database.listAreas().find(area => area.nombre === 'Mesa de Partes');
    const secretariaUser = database.db.prepare("INSERT INTO users (username, password_hash, role, area_id, created_at) VALUES ('secretaria', 'salt:hash', 'OPERATOR', ?, ?)")
      .run(secretaria.id, new Date().toISOString());
    const direccionUser = database.db.prepare("INSERT INTO users (username, password_hash, role, area_id, created_at) VALUES ('direccion', 'salt:hash', 'OPERATOR', ?, ?)")
      .run(direccion.id, new Date().toISOString());
    const mesaScope = { role: 'OPERATOR', areaId: mesaPartes.id, area: 'Mesa de Partes' };
    assert.equal(database.listTramites({ user: mesaScope, bandeja: 'entrada' }).length, 1);
    assert.equal(database.listTramites({ user: { role: 'OPERATOR', areaId: secretaria.id } }).length, 0);
    database.deriveTramite(created.id, secretaria.id, 'Atender la solicitud presentada.', 'PUBLIC', Number(user.lastInsertRowid));
    assert.equal(database.listTramites({ user: mesaScope, bandeja: 'entrada' }).length, 0);
    assert.equal(database.listTramites({ user: mesaScope, bandeja: 'derivados' }).length, 1);
    assert.equal(database.getTramiteDetail(created.id, mesaScope).canOperate, false);
    assert.equal(database.listTramites({ user: { role: 'OPERATOR', areaId: secretaria.id } }).length, 1);
    assert.equal(database.listTramites({ user: { role: 'OPERATOR', areaId: direccion.id } }).length, 0);
    assert.equal(database.getTramiteDetail(created.id, { role: 'OPERATOR', areaId: secretaria.id }).canOperate, true);
    assert.equal(database.getTramiteDetail(created.id, { role: 'OPERATOR', areaId: direccion.id }), null);
    assert.equal(database.getTramiteDetail(created.id, { role: 'ADMIN', areaId: null }).canOperate, false);
    assert.equal(database.getTramiteDetail(created.id).pendingReception, true);
    database.receiveTramite(created.id, Number(secretariaUser.lastInsertRowid));
    assert.equal(database.getTramiteDetail(created.id).pendingReception, false);
    database.addComment(created.id, 'El documento está siendo revisado.', 'PUBLIC', Number(secretariaUser.lastInsertRowid));
    database.updateTramiteStatus(created.id, 'En atención', 'Revisión iniciada.', Number(secretariaUser.lastInsertRowid));
    const updated = database.findPublicTramite(created.codigo, '12345678');
    assert.equal(updated.estado, 'En atención');
    assert.equal(updated.ubicacion, 'Secretaría');
    assert.equal(updated.comentarios.length, 1);
    assert.equal(database.getTramiteDetail(created.id).derivaciones.length, 1);
    assert.equal(database.getStats().total, 1);
    assert.equal(database.getStats().enAtencion, 1);
  } finally {
    database.db.close();
    delete process.env.DATABASE_PATH;
    rmSync(directory, { recursive: true, force: true });
  }
});
