import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { checkKey, chunks, type ByteRange, type ByteSource, type StagedWrite, type StagingByteStore } from './store.js';

const TEMP = 'porter-tmp';
const OBJECTS = 'objects';

/**
 * A `ByteStore` in a directory. Each key is a file at
 * `objects/<two characters of the key>/<key>`, written to `porter-tmp/`
 * first, fsynced, then renamed into place, so a crash never leaves a partial
 * file under a key. Files are never modified after they're written.
 */
export class FsByteStore implements StagingByteStore {
  /** @param root The directory to keep bytes in. It's created if missing. */
  constructor(readonly root: string) {}

  /** Path of the file holding `key`, whether or not it exists. */
  path(key: string): string {
    checkKey(key);
    // The last base32 character of a CID carries only 3 bits, so shard on the two before it.
    return join(this.root, OBJECTS, key.slice(-3, -1), key);
  }

  async put(key: string, source: ByteSource): Promise<void> {
    checkKey(key);
    const staged = await this.stage();
    try {
      for await (const chunk of chunks(source)) await staged.write(chunk);
      await staged.commit(key);
    } catch (error) {
      await staged.abort();
      throw error;
    }
  }

  async stage(): Promise<StagedWrite> {
    const dir = join(this.root, TEMP);
    await mkdir(dir, { recursive: true });
    const temp = join(dir, randomBytes(12).toString('hex'));
    let file: FileHandle | undefined = await open(temp, 'wx');
    const close = async () => {
      const handle = file;
      file = undefined;
      await handle?.close();
    };
    return {
      write: async chunk => {
        if (!file) throw new Error('Staged write is closed');
        await file.write(chunk);
      },
      commit: async key => {
        const target = this.path(key);
        if (!file) throw new Error('Staged write is closed');
        await file.sync();
        await close();
        if (await exists(target)) {
          await rm(temp, { force: true });
          return;
        }
        await mkdir(join(target, '..'), { recursive: true });
        await rename(temp, target);
        await syncDir(join(target, '..'));
      },
      abort: async () => {
        await close().catch(() => {});
        await rm(temp, { force: true });
      },
    };
  }

  async read(key: string, range?: ByteRange): Promise<AsyncIterable<Uint8Array> | undefined> {
    let file: FileHandle;
    try {
      file = await open(this.path(key), 'r');
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (range?.end !== undefined && range.end <= range.start) {
      await file.close();
      return chunks(new Uint8Array());
    }
    // createReadStream's `end` is inclusive.
    return file.createReadStream({ start: range?.start, end: range?.end === undefined ? undefined : range.end - 1 });
  }

  async size(key: string): Promise<number | undefined> {
    try {
      return (await stat(this.path(key))).size;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  /** Every key with a file, in no particular order. Names that aren't valid keys are skipped. */
  async *keys(): AsyncIterable<string> {
    const objects = join(this.root, OBJECTS);
    let shards: string[];
    try {
      shards = await readdir(objects);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const shard of shards) {
      const names = await readdir(join(objects, shard)).catch(error => {
        if (isMissing(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return [];
        throw error;
      });
      for (const name of names) if (/^[a-z0-9]{8,}$/.test(name) && name.slice(-3, -1) === shard) yield name;
    }
  }

  /**
   * Remove staged files older than `olderThanMs` left by crashed writes.
   * Younger ones may belong to a write still in progress in another process.
   * @returns How many files were removed.
   */
  async sweep(olderThanMs = 60 * 60 * 1000): Promise<number> {
    const dir = join(this.root, TEMP);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (isMissing(error)) return 0;
      throw error;
    }
    let removed = 0;
    for (const name of names) {
      const path = join(dir, name);
      const info = await stat(path).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs >= olderThanMs) {
        await rm(path, { force: true });
        removed++;
      }
    }
    return removed;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function syncDir(path: string): Promise<void> {
  const dir = await open(path, 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
