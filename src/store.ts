import type { Codec } from './cid.js';

/** A byte range: `start` inclusive, `end` exclusive. Omit `end` to read to the end. */
export interface ByteRange {
  start: number;
  end?: number;
}

/**
 * Opaque bytes by key, with ranged reads. Memory, the filesystem, and S3/R2
 * implement this. It never hashes or interprets what it holds; BlobStore and,
 * later, EncryptedStore decide the keys and check the bytes.
 */
export interface ByteStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string, range?: ByteRange): Promise<Uint8Array | undefined>;
  size(key: string): Promise<number | undefined>;
}

/** How much of a read was checked against its CID. */
export type Verification = 'full' | 'none';

export interface BlobRead {
  bytes: Uint8Array;
  /** Total size of the blob, whatever range was read. */
  size: number;
  verified: Verification;
}

/** Blobs by DASL CID. */
export interface BlobStore {
  put(bytes: Uint8Array, options?: { codec?: Codec }): Promise<{ cid: string; size: number }>;
  get(cid: string, range?: ByteRange): Promise<BlobRead | undefined>;
  size(cid: string): Promise<number | undefined>;
}
