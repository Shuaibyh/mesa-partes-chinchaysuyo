import '../local-server/config.js';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const databasePath = resolve(process.env.DATABASE_PATH || 'data/mesa-partes.db');
const uploadDirectory = resolve(process.env.UPLOAD_PATH || 'uploads');
const outputDirectory = resolve('migration-data');
const seedPath = resolve(outputDirectory, 'seed.sql');
const manifestPath = resolve(outputDirectory, 'files.json');
const tableOrder = ['areas', 'users', 'sequences', 'tramites', 'historial', 'derivaciones', 'comentarios'];

if (!existsSync(databasePath)) {
  throw new Error(`No existe la base SQLite local: ${databasePath}`);
}

mkdirSync(outputDirectory, { recursive: true });
const database = new DatabaseSync(databasePath, { readOnly: true });
const statements = [
  '-- Generado automáticamente desde la base SQLite local.',
  '-- No contiene sesiones ni intentos de acceso.',
  ''
];
const counts = {};

for (const table of tableOrder) {
  const exists = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists) continue;
  const columnsInfo = database.prepare(`PRAGMA table_info("${table}")`).all();
  const primaryKey = columnsInfo.find(column => column.pk)?.name;
  const rows = database.prepare(`SELECT * FROM "${table}"${primaryKey ? ` ORDER BY "${primaryKey}"` : ''}`).all();
  counts[table] = rows.length;
  for (const row of rows) {
    const columns = Object.keys(row);
    const identifiers = columns.map(column => `"${column}"`).join(', ');
    const values = columns.map(column => sqlValue(row[column])).join(', ');
    statements.push(`INSERT INTO "${table}" (${identifiers}) VALUES (${values});`);
  }
  if (rows.length) statements.push('');
}

const files = database.prepare(`
  SELECT codigo, stored_filename AS storedFilename, original_filename AS originalFilename,
         mime_type AS mimeType, file_size AS size
  FROM tramites WHERE stored_filename IS NOT NULL ORDER BY id
`).all().map(file => ({
  ...file,
  source: resolve(uploadDirectory, file.storedFilename),
  exists: existsSync(resolve(uploadDirectory, file.storedFilename))
}));

database.close();
writeFileSync(seedPath, `${statements.join('\n').trim()}\n`, 'utf8');
writeFileSync(manifestPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), files }, null, 2)}\n`, 'utf8');

console.log(`SQL creado: ${seedPath}`);
console.log(`Manifiesto de archivos: ${manifestPath}`);
console.log(`Registros: ${Object.entries(counts).map(([table, count]) => `${table}=${count}`).join(', ')}`);
console.log(`Adjuntos: ${files.length}; faltantes: ${files.filter(file => !file.exists).length}`);

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`;
  return `'${String(value).replaceAll("'", "''")}'`;
}
