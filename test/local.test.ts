import { rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FsByteStore, LocalStore, PlainBlobStore, collect } from '../src/index.js';
import { tempDir } from './helpers.js';

const HELLO = 'bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4';

async function* pieces(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield Buffer.from(part);
}

describe('LocalStore', () => {
  it('writes the file, records it, and queues it for each tier', async () => {
    const root = await tempDir();
    const store = new LocalStore({ root, tiers: ['r2'] });
    expect(await store.put(pieces('hello ', 'world\n'))).toEqual({ cid: HELLO, size: 12 });
    expect(store.index.blob(HELLO)).toMatchObject({ size: 12, codec: 0x55 });
    expect(store.index.replicas(HELLO).map(r => [r.tier, r.state])).toEqual([['r2', 'pending']]);
    expect(Buffer.from(await collect((await store.get(HELLO))!.stream)).toString()).toBe('hello world\n');
    store.close();
  });

  it('records nothing when a write is rejected', async () => {
    const store = new LocalStore({ root: await tempDir(), tiers: ['r2'] });
    const other = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
    await expect(store.put(Buffer.from('hello world\n'), { expect: other })).rejects.toMatchObject({ code: 'integrity' });
    expect([...store.index.cids()]).toEqual([]);
    store.close();
  });

  it('scans in files written without an index row', async () => {
    const root = await tempDir();
    // As if a process crashed after renaming the file but before recording it.
    await new PlainBlobStore(new FsByteStore(root)).put(Buffer.from('hello world\n'));
    await mkdir(join(root, 'objects', 'zz'), { recursive: true });
    await writeFile(join(root, 'objects', 'zz', 'notacid1zz1'), 'stray');

    const store = new LocalStore({ root, tiers: ['r2'] });
    expect(await store.scan()).toEqual({ added: 1, missing: [] });
    expect(store.index.blob(HELLO)?.size).toBe(12);
    expect(store.index.replicas(HELLO)[0]?.state).toBe('pending');
    expect(await store.scan()).toEqual({ added: 0, missing: [] });
    store.close();
  });

  it('queues known blobs for a newly added tier on scan', async () => {
    const root = await tempDir();
    const before = new LocalStore({ root, tiers: ['r2'] });
    await before.put(Buffer.from('hello world\n'));
    before.close();

    const after = new LocalStore({ root, tiers: ['r2', 's3'] });
    await after.scan();
    expect(after.index.replicas(HELLO).map(r => r.tier)).toEqual(['r2', 's3']);
    after.close();
  });

  it('reports index rows whose file is gone without removing them', async () => {
    const root = await tempDir();
    const store = new LocalStore({ root });
    await store.put(Buffer.from('hello world\n'));
    await rm(store.files.path(HELLO));
    expect(await store.scan()).toEqual({ added: 0, missing: [HELLO] });
    expect(store.index.blob(HELLO)).toBeDefined();
    store.close();
  });
});
