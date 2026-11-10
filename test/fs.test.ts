import { readdir, utimes, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FsByteStore } from '../src/index.js';
import { tempDir } from './helpers.js';

const HELLO = 'bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4';

describe('FsByteStore', () => {
  it('shards files by the two characters before the last', async () => {
    const store = new FsByteStore(await tempDir());
    await store.put(HELLO, Buffer.from('hello world\n'));
    expect(store.path(HELLO)).toBe(join(store.root, 'objects', 'ei', HELLO));
    expect(await readdir(join(store.root, 'objects', 'ei'))).toEqual([HELLO]);
  });

  it('leaves no staged files behind after commits and aborts', async () => {
    const store = new FsByteStore(await tempDir());
    await store.put(HELLO, Buffer.from('hello world\n'));
    await store.put(HELLO, Buffer.from('hello world\n'));
    const aborted = await store.stage();
    await aborted.write(Buffer.from('partial'));
    await aborted.abort();
    expect(await readdir(join(store.root, 'porter-tmp'))).toEqual([]);
  });

  it('cleans up after a source that fails mid-stream', async () => {
    const store = new FsByteStore(await tempDir());
    async function* failing() {
      yield Buffer.from('some bytes');
      throw new Error('source broke');
    }
    await expect(store.put('keybroken', failing())).rejects.toThrow('source broke');
    expect(await store.size('keybroken')).toBeUndefined();
    expect(await readdir(join(store.root, 'porter-tmp'))).toEqual([]);
  });

  it('ignores files left by a crashed write and sweeps old ones', async () => {
    const store = new FsByteStore(await tempDir());
    const temp = join(store.root, 'porter-tmp');
    await mkdir(temp, { recursive: true });
    await writeFile(join(temp, 'old'), 'crashed before rename');
    await writeFile(join(temp, 'recent'), 'maybe still writing');
    const hourAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(join(temp, 'old'), hourAgo, hourAgo);

    expect(await store.size(HELLO)).toBeUndefined();
    expect(await store.sweep()).toBe(1);
    expect(await readdir(temp)).toEqual(['recent']);
  });

  it('sweeps nothing when no write ever happened', async () => {
    expect(await new FsByteStore(await tempDir()).sweep()).toBe(0);
  });
});
