import { cidEquals, cidForBytes, formatCid, parseCid, type Codec } from './cid.js';
import type { BlobRead, BlobStore, ByteRange, ByteStore } from './store.js';

export class IntegrityError extends Error {
  override name = 'IntegrityError';
}

/**
 * Plaintext blobs over a ByteStore, keyed by CID string. Full reads are
 * re-hashed and rejected on mismatch; ranged reads trust the backing store.
 */
export class PlainBlobStore implements BlobStore {
  constructor(readonly bytes: ByteStore) {}

  async put(bytes: Uint8Array, options: { codec?: Codec } = {}): Promise<{ cid: string; size: number }> {
    const cid = formatCid(cidForBytes(bytes, options.codec));
    if ((await this.bytes.size(cid)) === undefined) await this.bytes.put(cid, bytes);
    return { cid, size: bytes.length };
  }

  async get(cid: string, range?: ByteRange): Promise<BlobRead | undefined> {
    const expected = parseCid(cid);
    const size = await this.bytes.size(cid);
    if (size === undefined) return undefined;
    if (range && !(range.start === 0 && (range.end ?? size) >= size)) {
      const bytes = await this.bytes.get(cid, range);
      return bytes && { bytes, size, verified: 'none' };
    }
    const bytes = await this.bytes.get(cid);
    if (!bytes) return undefined;
    if (!cidEquals(cidForBytes(bytes, expected.codec), expected)) throw new IntegrityError(`Stored bytes don't match ${cid}`);
    return { bytes, size, verified: 'full' };
  }

  async size(cid: string): Promise<number | undefined> {
    parseCid(cid);
    return this.bytes.size(cid);
  }
}
