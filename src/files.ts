import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Where Porter keeps its blobs, index, config, and secrets unless told
 * otherwise: the platform's application-data directory.
 */
export function defaultRoot(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Porter');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Porter');
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'porter');
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
