import { describe, expect, it } from 'vitest';
import { IntegrityError, MemoryByteStore, PlainBlobStore } from '../src/index.js';

const HELLO = 'bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4';

describe('PlainBlobStore over memory', () => {
  it('stores bytes under their CID and verifies full reads', async () => {
    const blobs = new PlainBlobStore(new MemoryByteStore());
    expect(await blobs.put(Buffer.from('hello world\n'))).toEqual({ cid: HELLO, size: 12 });
    const read = await blobs.get(HELLO);
    expect(Buffer.from(read!.bytes).toString()).toBe('hello world\n');
    expect(read).toMatchObject({ size: 12, verified: 'full' });
    expect(await blobs.size(HELLO)).toBe(12);
  });

  it('serves ranges without claiming to verify them', async () => {
    const blobs = new PlainBlobStore(new MemoryByteStore());
    await blobs.put(Buffer.from('hello world\n'));
    const read = await blobs.get(HELLO, { start: 6, end: 11 });
    expect(Buffer.from(read!.bytes).toString()).toBe('world');
    expect(read).toMatchObject({ size: 12, verified: 'none' });
  });

  it('returns nothing for a CID it does not hold', async () => {
    const blobs = new PlainBlobStore(new MemoryByteStore());
    expect(await blobs.get(HELLO)).toBeUndefined();
    expect(await blobs.size(HELLO)).toBeUndefined();
  });

  it('rejects stored bytes that no longer match their CID', async () => {
    const bytes = new MemoryByteStore();
    await bytes.put(HELLO, Buffer.from('tampered\n'));
    await expect(new PlainBlobStore(bytes).get(HELLO)).rejects.toThrow(IntegrityError);
  });
});
