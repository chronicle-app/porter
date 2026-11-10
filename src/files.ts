import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Chronicle's directories, copied from Chronicle (chronicleDataDir in
// apps/cli/src/config/dataDir.ts, chronicleConfigDir in @chronicle.app/auth)
// until they live in a shared package. Keep them in step.

/**
 * Chronicle's data directory: `CHRONICLE_DATA_DIR`, else the platform's
 * application-data directory, under "Chronicle Dev" when
 * `CHRONICLE_PROFILE=dev` so development never touches real data.
 */
export function chronicleDataDir(): string {
  if (process.env.CHRONICLE_DATA_DIR) return process.env.CHRONICLE_DATA_DIR;
  const profile = process.env.CHRONICLE_PROFILE?.toLowerCase();
  const dev = profile === 'dev' || profile === 'development';
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', dev ? 'Chronicle Dev' : 'Chronicle');
  const base = process.env.XDG_DATA_HOME || (process.platform === 'win32' && process.env.LOCALAPPDATA) || join(homedir(), '.local', 'share');
  return join(base, dev ? 'chronicle-dev' : 'chronicle');
}

/** Chronicle's config directory, where it keeps credentials: `CHRONICLE_CONFIG_DIR`, else XDG config. */
export function chronicleConfigDir(): string {
  return (
    process.env.CHRONICLE_CONFIG_DIR ||
    join(process.env.XDG_CONFIG_HOME || (process.platform === 'win32' && process.env.LOCALAPPDATA) || join(homedir(), '.config'), 'chronicle')
  );
}

/**
 * Where Porter keeps its blobs, index, settings, and server secrets unless
 * told otherwise: `porter` in Chronicle's data directory. Remote keys live
 * apart from it, in Chronicle's config directory.
 */
export function defaultRoot(): string {
  return join(chronicleDataDir(), 'porter');
}

/** Parse a JSON file, or `undefined` if it doesn't exist. */
export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Replace a JSON file in one step: write a temp file beside it with `mode`,
 * fsync, and rename over the original, so readers see the old file or the
 * new one, never half of either.
 */
export async function writeJson(path: string, value: unknown, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.porter-tmp-${randomBytes(6).toString('hex')}`);
  const file = await open(temp, 'wx', mode);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
