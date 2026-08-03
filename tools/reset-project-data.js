import { DatabaseSync } from 'node:sqlite';
import {
  cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync
} from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

if (!process.argv.includes('--confirm-reset')) {
  console.error('Uso: node tools/reset-project-data.js --confirm-reset');
  process.exit(1);
}

const root = resolve('.');
const databasePath = resolve(process.env.DATABASE_PATH || 'data/mesa-partes.db');
const uploadsPath = resolve(process.env.UPLOAD_PATH || 'uploads');

function assertInsideProject(path, label) {
  const pathRelativeToRoot = relative(root, path);
  if (!pathRelativeToRoot || pathRelativeToRoot.startsWith('..') || isAbsolute(pathRelativeToRoot)) {
    throw new Error(`${label} no es una ruta segura dentro del proyecto: ${path}`);
  }
}

assertInsideProject(databasePath, 'La base de datos');
assertInsideProject(uploadsPath, 'La carpeta de adjuntos');

if (!existsSync(databasePath)) {
  throw new Error(`No existe la base de datos: ${databasePath}`);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDirectory = resolve('backups', `reinicio-${timestamp}`);
const backupDatabasePath = resolve(backupDirectory, 'mesa-partes-antes-del-reinicio.db');
const backupUploadsPath = resolve(backupDirectory, 'uploads');
assertInsideProject(backupDirectory, 'La carpeta de respaldo');
mkdirSync(backupDirectory, { recursive: true });

const db = new DatabaseSync(databasePath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000;');

const countsBefore = {};
for (const table of ['tramites', 'historial', 'derivaciones', 'comentarios', 'sessions', 'users', 'areas']) {
  countsBefore[table] = Number(db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total);
}

const escapedBackupPath = backupDatabasePath.replaceAll("'", "''");
db.exec(`VACUUM INTO '${escapedBackupPath}'`);

if (existsSync(uploadsPath)) {
  cpSync(uploadsPath, backupUploadsPath, { recursive: true });
}

const uploadedFilesBefore = existsSync(uploadsPath)
  ? readdirSync(uploadsPath, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).length
  : 0;

db.exec('BEGIN IMMEDIATE');
try {
  db.exec(`
    DELETE FROM tramites;
    DELETE FROM sequences;
    DELETE FROM sessions;
  `);
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  db.close();
  throw error;
}

db.exec('PRAGMA wal_checkpoint(TRUNCATE);');

const countsAfter = {};
for (const table of ['tramites', 'historial', 'derivaciones', 'comentarios', 'sessions', 'users', 'areas']) {
  countsAfter[table] = Number(db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total);
}
db.close();

if (existsSync(uploadsPath)) {
  rmSync(uploadsPath, { recursive: true, force: true });
}
mkdirSync(uploadsPath, { recursive: true });

const manifest = {
  createdAt: new Date().toISOString(),
  databaseBackup: backupDatabasePath,
  uploadsBackup: backupUploadsPath,
  uploadedFilesBefore,
  countsBefore,
  countsAfter
};
writeFileSync(resolve(backupDirectory, 'resumen.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({ backupDirectory, uploadedFilesBefore, countsBefore, countsAfter }, null, 2));
