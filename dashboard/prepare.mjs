import { mkdir, copyFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildFeed } from '../shared/build-feed.mjs';

const DATA_DIR = resolve('..', 'data');
const SRC = resolve(DATA_DIR, 'sector.json');
const DEST = resolve('public', 'sector.json');

await mkdir('public', { recursive: true });

// 1) Dashboard data
try {
  const s = await stat(SRC);
  await copyFile(SRC, DEST);
  console.log(`✓ copied sector.json (${s.size} bytes) → public/`);
} catch (e) {
  console.error(`⚠ could not copy sector.json from ${SRC}: ${e.message}`);
  console.error('  build will continue but dashboard may show "Loading…" indefinitely');
}

// 2) Email digest feed (movers + recent priority filings). Optional — the
//    digest degrades gracefully if this is ever missing.
try {
  const feed = await buildFeed(DATA_DIR);
  await writeFile(resolve('public', 'digest-feed.json'), JSON.stringify(feed));
  console.log(`✓ built digest-feed.json — ${feed.counts.total} items (${feed.counts.movers} movers, ${feed.counts.filings} filings), data date ${feed.dataDate}`);
} catch (e) {
  console.error(`⚠ could not build digest-feed.json: ${e.message}`);
  console.error('  the dashboard still builds; the email digest will report no items until this succeeds');
}
