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

  it('never queues known blobs for a newly added tier on scan', async () => {
    const root = await tempDir();
    const before = new LocalStore({ root, tiers: ['r2'] });
    await before.put(Buffer.from('hello world\n'));
    before.close();

    const after = new LocalStore({ root, tiers: ['r2', 's3'] });
    expect(await after.scan()).toEqual({ added: 0, missing: [] });
    expect(after.index.replicas(HELLO).map(r => r.tier)).toEqual(['r2']);
    after.close();
  });

  it('records when a blob is read, but not on every read', async () => {
    const store = new LocalStore({ root: await tempDir() });
    await store.put(Buffer.from('hello world\n'));
    expect(store.index.blob(HELLO)?.lastReadAt).toBeNull();
    await store.get(HELLO, { start: 0, end: 5 });
    const first = store.index.blob(HELLO)!.lastReadAt!;
    expect(first).toBeGreaterThan(0);
    expect(store.index.touch(HELLO, first + 1000)).toBe(false);
    expect(store.index.blob(HELLO)?.lastReadAt).toBe(first);
    store.close();
  });

  it('does not record reads of blobs it does not hold', async () => {
    const store = new LocalStore({ root: await tempDir() });
    expect(await store.get(HELLO)).toBeUndefined();
    expect(store.index.blob(HELLO)).toBeUndefined();
    store.close();
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
