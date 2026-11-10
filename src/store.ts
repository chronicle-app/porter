import type { CODEC_DCBOR, CODEC_RAW } from './cid.js';

/** A byte range: `start` inclusive, `end` exclusive. Omit `end` to read to the end. */
export interface ByteRange {
  start: number;
  end?: number;
}

/** Bytes to write: a whole buffer, or chunks from a stream such as a Node `Readable`. */
export type ByteSource = Uint8Array | AsyncIterable<Uint8Array>;

/**
 * Opaque bytes by key, with ranged reads. Memory, the filesystem, and S3/R2
 * implement this. It never hashes or interprets what it holds; `BlobStore`
 * and, later, `EncryptedStore` choose the keys and check the bytes.
 *
 * Keys are lowercase letters and digits, at least 8 characters, so they're
 * safe as file names and object keys.
 */
export interface ByteStore {
  /** Store `source` under `key`. Writing a key that already exists keeps the existing bytes. */
  put(key: string, source: ByteSource): Promise<void>;
  /** Stream the bytes under `key`, or a range of them; `undefined` if absent. */
  read(key: string, range?: ByteRange): Promise<AsyncIterable<Uint8Array> | undefined>;
  /** Size in bytes of what's under `key`; `undefined` if absent. */
  size(key: string): Promise<number | undefined>;
}

/** A write in progress whose key isn't known until all bytes have been seen. */
export interface StagedWrite {
  write(chunk: Uint8Array): Promise<void>;
  /** Make the bytes durable under `key`. If `key` already exists, the staged bytes are discarded. */
  commit(key: string): Promise<void>;
  /** Discard the staged bytes. Safe to call after a failed write or commit. */
  abort(): Promise<void>;
}

/**
 * A `ByteStore` that can accept bytes before their key is known. Local stores
 * implement this so `BlobStore.put` can hash a stream while writing it once.
 */
export interface StagingByteStore extends ByteStore {
  stage(): Promise<StagedWrite>;
}

export function isStaging(store: ByteStore): store is StagingByteStore {
  return typeof (store as Partial<StagingByteStore>).stage === 'function';
}

/** How much of a read is checked against its CID. */
export type Verification = 'full' | 'none';

export interface BlobRead {
  /**
   * The requested bytes. With `verified: 'full'`, the stream throws an
   * `IntegrityError` at the end if the bytes don't match the CID, so only
   * trust them once it has been read to the end.
   */
  stream: AsyncIterable<Uint8Array>;
  /** Total size of the blob, whatever range was read. */
  size: number;
  verified: Verification;
}

export interface PutOptions {
  /** Codec for the CID: `CODEC_RAW` (default) or `CODEC_DCBOR`. Porter doesn't check that DRISL bytes are DRISL. */
  codec?: typeof CODEC_RAW | typeof CODEC_DCBOR;
  /** The CID the caller expects. The write is discarded and an `IntegrityError` thrown if it differs. */
  expect?: string;
}

/** Blobs by DASL CID. */
export interface BlobStore {
  put(source: ByteSource, options?: PutOptions): Promise<{ cid: string; size: number }>;
  get(cid: string, range?: ByteRange): Promise<BlobRead | undefined>;
  size(cid: string): Promise<number | undefined>;
}

/** Read a stream to the end into one buffer. */
export async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function* chunks(source: ByteSource): AsyncIterable<Uint8Array> {
  if (source instanceof Uint8Array) yield source;
  else yield* source;
}

const KEY = /^[a-z0-9]{8,}$/;

/** Throws unless `key` is a valid `ByteStore` key. */
export function checkKey(key: string): void {
  if (!KEY.test(key)) throw new TypeError(`Invalid store key ${JSON.stringify(key)}`);
}
