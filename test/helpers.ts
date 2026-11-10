import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

/** A fresh directory under the OS temp dir, removed after each test. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'porter-test-'));
  dirs.push(dir);
  return dir;
}
