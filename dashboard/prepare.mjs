import { mkdir, copyFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const SRC = resolve('..', 'data', 'sector.json');
const DEST = resolve('public', 'sector.json');

try {
  const s = await stat(SRC);
  await mkdir('public', { recursive: true });
  await copyFile(SRC, DEST);
  console.log(`✓ copied sector.json (${s.size} bytes) → public/`);
} catch (e) {
  console.error(`⚠ could not copy sector.json from ${SRC}: ${e.message}`);
  console.error('  build will continue but dashboard may show "Loading…" indefinitely');
}
