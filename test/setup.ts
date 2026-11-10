import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';

// Every test gets its own Chronicle directories, so nothing reads or writes
// the real ~/.config/chronicle or Chronicle's data directory. Processes a
// test starts (porter, porter serve) inherit them.
let dir: string | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'porter-chronicle-'));
  process.env.CHRONICLE_CONFIG_DIR = join(dir, 'config');
  process.env.CHRONICLE_DATA_DIR = join(dir, 'data');
});
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
