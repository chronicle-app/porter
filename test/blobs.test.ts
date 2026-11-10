import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CODEC_DCBOR, CODEC_RAW, createSync, toString } from '@atcute/cid';
import { FsByteStore, IntegrityError, MemoryByteStore, PlainBlobStore, collect, type StagingByteStore } from '../src/index.js';
import { tempDir } from './helpers.js';

const HELLO = 'bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4';

const backends: [string, () => Promise<StagingByteStore>][] = [
  ['memory', async () => new MemoryByteStore()],
  ['filesystem', async () => new FsByteStore(await tempDir())],
];

async function* split(bytes: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

describe.each(backends)('PlainBlobStore over %s', (_, make) => {
  it('stores bytes under their CID and verifies full reads', async () => {
    const blobs = new PlainBlobStore(await make());
    expect(await blobs.put(Buffer.from('hello world\n'))).toEqual({ cid: HELLO, size: 12 });
    const read = await blobs.get(HELLO);
    expect(read).toMatchObject({ size: 12, verified: 'full' });
    expect(Buffer.from(await collect(read!.stream)).toString()).toBe('hello world\n');
    expect(await blobs.size(HELLO)).toBe(12);
  });

  it('hashes a stream while writing it once', async () => {
    const blobs = new PlainBlobStore(await make());
    const bytes = randomBytes(3 * 1024 * 1024 + 17);
    const { cid, size } = await blobs.put(split(bytes, 64 * 1024));
    expect(cid).toBe(toString(createSync(CODEC_RAW, bytes)));
    expect(size).toBe(bytes.length);
    expect(Buffer.from(await collect((await blobs.get(cid))!.stream)).equals(bytes)).toBe(true);
  });

  it('serves ranges without claiming to verify them', async () => {
    const blobs = new PlainBlobStore(await make());
    await blobs.put(Buffer.from('hello world\n'));
    const read = await blobs.get(HELLO, { start: 6, end: 11 });
    expect(read).toMatchObject({ size: 12, verified: 'none' });
    expect(Buffer.from(await collect(read!.stream)).toString()).toBe('world');
  });

  it('treats a range covering the whole blob as a full read', async () => {
    const blobs = new PlainBlobStore(await make());
    await blobs.put(Buffer.from('hello world\n'));
    expect(await blobs.get(HELLO, { start: 0, end: 12 })).toMatchObject({ verified: 'full' });
  });

  it('labels DRISL blobs with the DRISL codec', async () => {
    const blobs = new PlainBlobStore(await make());
    const { cid } = await blobs.put(Buffer.from('hello world\n'), { codec: CODEC_DCBOR });
    expect(cid.startsWith('bafyrei')).toBe(true);
  });

  it('discards a write that does not match the expected CID', async () => {
    const store = await make();
    const blobs = new PlainBlobStore(store);
    const other = toString(createSync(CODEC_RAW, Buffer.from('something else')));
    await expect(blobs.put(split(Buffer.from('hello world\n'), 4), { expect: other })).rejects.toMatchObject({ code: 'integrity' });
    expect(await blobs.size(HELLO)).toBeUndefined();
    expect(await blobs.size(other)).toBeUndefined();
  });

  it('returns nothing for a CID it does not hold', async () => {
    const blobs = new PlainBlobStore(await make());
    expect(await blobs.get(HELLO)).toBeUndefined();
    expect(await blobs.size(HELLO)).toBeUndefined();
  });

  it('rejects malformed CIDs', async () => {
    const blobs = new PlainBlobStore(await make());
    await expect(blobs.get('Qmnotdasl')).rejects.toMatchObject({ code: 'invalid-cid' });
  });
});

describe('PlainBlobStore integrity', () => {
  it('fails at the end of a full read when the stored bytes changed', async () => {
    const bytes = new MemoryByteStore();
    await bytes.put(HELLO, Buffer.from('tampered\n'));
    const read = await new PlainBlobStore(bytes).get(HELLO);
    await expect(collect(read!.stream)).rejects.toThrow(IntegrityError);
  });

  it('catches a file changed on disk behind the store', async () => {
    const store = new FsByteStore(await tempDir());
    const blobs = new PlainBlobStore(store);
    await blobs.put(Buffer.from('hello world\n'));
    await writeFile(store.path(HELLO), 'hello w0rld\n');
    await expect(collect((await blobs.get(HELLO))!.stream)).rejects.toMatchObject({ code: 'integrity' });
  });
});
