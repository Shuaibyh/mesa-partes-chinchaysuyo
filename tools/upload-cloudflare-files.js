import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const target = process.argv.includes('--remote') ? '--remote' : process.argv.includes('--local') ? '--local' : null;
if (!target) throw new Error('Indique un destino explícito: --local o --remote.');

const manifestPath = resolve('migration-data/files.json');
if (!existsSync(manifestPath)) throw new Error('Primero ejecute: npm.cmd run cloudflare:seed');
const { files = [] } = JSON.parse(readFileSync(manifestPath, 'utf8'));
const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
let uploaded = 0;

for (const file of files) {
  if (!file.exists || !existsSync(file.source)) throw new Error(`Falta el adjunto de ${file.codigo}: ${file.source}`);
  const metadata = JSON.stringify({
    originalFilename: file.originalFilename,
    mimeType: file.mimeType,
    size: file.size
  });
  const result = spawnSync(command, [
    'wrangler', 'kv', 'key', 'put', file.storedFilename,
    '--binding', 'ARCHIVOS', '--path', file.source, '--metadata', metadata, target
  ], { cwd: resolve('.'), stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`No se pudo subir el adjunto de ${file.codigo}.`);
  uploaded += 1;
}

console.log(`Adjuntos cargados en ${target.slice(2)}: ${uploaded}`);
