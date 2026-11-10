import { createHash } from 'node:crypto';
import { createSync, equals, fromDigest, toString } from '@atcute/cid';
import { CODEC_RAW, parseCid, type Cid } from './cid.js';
import { IntegrityError } from './errors.js';
import { chunks, isStaging, type BlobRead, type BlobStore, type ByteRange, type ByteSource, type ByteStore, type PutOptions } from './store.js';

/**
 * Plaintext blobs over a `ByteStore`, keyed by CID string. Writes are hashed
 * as they stream in. Full reads are re-hashed as they stream out and fail at
 * the end on a mismatch; ranged reads trust the backing store.
 */
export class PlainBlobStore implements BlobStore {
  constructor(readonly bytes: ByteStore) {}

  async put(source: ByteSource, options: PutOptions = {}): Promise<{ cid: string; size: number }> {
    const codec = options.codec ?? CODEC_RAW;
    if (source instanceof Uint8Array) {
      const parsed = createSync(codec, source);
      const cid = toString(parsed);
      checkExpected(cid, options.expect);
      await this.bytes.put(cid, source, { sha256: parsed.digest.contents });
      return { cid, size: source.length };
    }
    if (!isStaging(this.bytes)) throw new TypeError('This store needs a whole buffer, not a stream');
    const staged = await this.bytes.stage();
    try {
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of source) {
        hash.update(chunk);
        size += chunk.length;
        await staged.write(chunk);
      }
      const cid = toString(fromDigest(codec, hash.digest()));
      checkExpected(cid, options.expect);
      await staged.commit(cid);
      return { cid, size };
    } catch (error) {
      await staged.abort();
      throw error;
    }
  }

  async get(cid: string, range?: ByteRange): Promise<BlobRead | undefined> {
    const expected = parseCid(cid);
    const size = await this.bytes.size(cid);
    if (size === undefined) return undefined;
    const whole = !range || (range.start <= 0 && (range.end ?? size) >= size);
    const stream = await this.bytes.read(cid, whole ? undefined : range);
    if (!stream) return undefined;
    if (!whole) return { stream, size, verified: 'none' };
    return { stream: verifying(stream, expected, cid), size, verified: 'full' };
  }

  async size(cid: string): Promise<number | undefined> {
    parseCid(cid);
    return this.bytes.size(cid);
  }
}

function checkExpected(cid: string, expect: string | undefined): void {
  if (expect !== undefined && !equals(parseCid(cid), parseCid(expect))) {
    throw new IntegrityError(`Bytes hash to ${cid}, not ${expect}`, 'The source changed or is not the file you meant.');
  }
}

async function* verifying(stream: AsyncIterable<Uint8Array>, expected: Cid, cid: string): AsyncIterable<Uint8Array> {
  const hash = createHash('sha256');
  for await (const chunk of chunks(stream)) {
    hash.update(chunk);
    yield chunk;
  }
  if (!hash.digest().equals(expected.digest.contents)) {
    throw new IntegrityError(`Stored bytes don't match ${cid}`, 'Restore the blob from another copy.');
  }
}
