import { join } from 'node:path';
import { BlobIndex, type RetryPolicy } from './blob-index.js';
import { PlainBlobStore } from './blobs.js';
import { CidError, parseCid } from './cid.js';
import { FsByteStore } from './fs.js';
import type { BlobRead, BlobStore, ByteRange, ByteSource, PutOptions } from './store.js';

export interface LocalStoreOptions {
  /** The directory holding blobs and the index. */
  root: string;
  /** Remote tiers every new blob is queued for. Defaults to none. */
  tiers?: readonly string[];
  retry?: RetryPolicy;
}

export interface ScanResult {
  /** Files that had no index row and now do. */
  added: number;
  /** Index rows whose file is gone. They're kept and reported, not removed. */
  missing: string[];
}

/**
 * Porter's local tier: blobs as files under `root`, with the index at
 * `root/porter-index.sqlite`. A write lands on disk first and is then
 * recorded and queued for each remote tier, so a crash in between leaves a
 * file that `scan` will pick up, never an index row without bytes.
 */
export class LocalStore implements BlobStore {
  readonly files: FsByteStore;
  readonly blobs: PlainBlobStore;
  readonly index: BlobIndex;
  readonly tiers: readonly string[];

  constructor(options: LocalStoreOptions) {
    this.files = new FsByteStore(options.root);
    this.blobs = new PlainBlobStore(this.files);
    this.index = new BlobIndex(join(options.root, 'porter-index.sqlite'), options.retry);
    this.tiers = options.tiers ?? [];
  }

  close(): void {
    this.index.close();
  }

  async put(source: ByteSource, options?: PutOptions): Promise<{ cid: string; size: number }> {
    const result = await this.blobs.put(source, options);
    this.index.add({ cid: result.cid, size: result.size, codec: parseCid(result.cid).codec }, this.tiers);
    return result;
  }

  get(cid: string, range?: ByteRange): Promise<BlobRead | undefined> {
    return this.blobs.get(cid, range);
  }

  size(cid: string): Promise<number | undefined> {
    return this.blobs.size(cid);
  }

  /**
   * Bring the index in line with the files: record files it doesn't know
   * (queued for every tier) and report rows whose file is gone. Files whose
   * names aren't DASL CIDs are ignored.
   */
  async scan(): Promise<ScanResult> {
    let added = 0;
    for await (const cid of this.files.keys()) {
      let codec: number;
      try {
        codec = parseCid(cid).codec;
      } catch (error) {
        if (error instanceof CidError) continue;
        throw error;
      }
      const known = this.index.blob(cid);
      if (known) {
        // Queues it for any tier added since it was recorded.
        this.index.add(known, this.tiers);
        continue;
      }
      const size = await this.files.size(cid);
      if (size === undefined) continue;
      this.index.add({ cid, size, codec }, this.tiers);
      added++;
    }
    const missing: string[] = [];
    for (const cid of this.index.cids()) if ((await this.files.size(cid)) === undefined) missing.push(cid);
    return { added, missing };
  }
}
