import { describe, expect, it } from 'vitest';
import { FsByteStore, MemoryByteStore, collect, type StagingByteStore } from '../src/index.js';
import { tempDir } from './helpers.js';

const stores: [string, () => Promise<StagingByteStore>][] = [
  ['MemoryByteStore', async () => new MemoryByteStore()],
  ['FsByteStore', async () => new FsByteStore(await tempDir())],
];

async function* pieces(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield Buffer.from(part);
}
const text = async (stream: AsyncIterable<Uint8Array> | undefined) => Buffer.from(await collect(stream!)).toString();

describe.each(stores)('%s', (_, make) => {
  it('stores buffers and streams under a key', async () => {
    const store = await make();
    await store.put('keyone11', Buffer.from('one'));
    await store.put('keytwo22', pieces('t', 'w', 'o'));
    expect(await text(await store.read('keyone11'))).toBe('one');
    expect(await text(await store.read('keytwo22'))).toBe('two');
    expect(await store.size('keytwo22')).toBe(3);
  });

  it('reads ranges with an exclusive end', async () => {
    const store = await make();
    await store.put('keyrange', Buffer.from('hello world\n'));
    expect(await text(await store.read('keyrange', { start: 6, end: 11 }))).toBe('world');
    expect(await text(await store.read('keyrange', { start: 6 }))).toBe('world\n');
    expect(await text(await store.read('keyrange', { start: 3, end: 3 }))).toBe('');
  });

  it('keeps the first bytes written under a key', async () => {
    const store = await make();
    await store.put('keysame1', Buffer.from('first'));
    await store.put('keysame1', Buffer.from('second'));
    expect(await text(await store.read('keysame1'))).toBe('first');
  });

  it('reports absent keys as undefined', async () => {
    const store = await make();
    expect(await store.read('keyabsent')).toBeUndefined();
    expect(await store.size('keyabsent')).toBeUndefined();
  });

  it('publishes staged bytes only on commit', async () => {
    const store = await make();
    const kept = await store.stage();
    await kept.write(Buffer.from('kept'));
    expect(await store.size('keystage')).toBeUndefined();
    await kept.commit('keystage');
    expect(await text(await store.read('keystage'))).toBe('kept');

    const dropped = await store.stage();
    await dropped.write(Buffer.from('dropped'));
    await dropped.abort();
    expect(await store.size('keydropped')).toBeUndefined();
  });

  it.each(['', 'short', 'UPPERCASE1', '../escape1', 'has/slash1', 'dots.in.key'])('rejects the key %j', async key => {
    const store = await make();
    await expect(store.put(key, Buffer.from('x'))).rejects.toThrow(TypeError);
  });
});
