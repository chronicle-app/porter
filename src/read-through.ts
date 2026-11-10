import { PlainBlobStore } from './blobs.js';
import { parseCid } from './cid.js';
import type { LocalStore } from './local.js';
import type { Remote } from './replicate.js';
import type { BlobRead, ByteRange } from './store.js';

export interface SourcedRead extends BlobRead {
  /** `local`, or the name of the remote the bytes come from. */
  source: string;
}

/**
 * Reads blobs from the local store, falling back to each remote in order.
 * Full reads are checked against the CID as they stream, wherever they come
 * from. Ranged reads aren't checked, so a range from a remote trusts that
 * remote. Nothing read from a remote is written to the local store.
 */
export class ReadThrough {
  readonly #remotes: { name: string; blobs: PlainBlobStore }[];

  constructor(
    readonly local: LocalStore,
    remotes: readonly Remote[] = [],
  ) {
    this.#remotes = remotes.map(remote => ({ name: remote.name, blobs: new PlainBlobStore(remote.store) }));
  }

  /**
   * Size of the blob from the first place that has it.
   * @throws the last remote's error if none had it and a remote failed.
   */
  async size(cid: string): Promise<number | undefined> {
    parseCid(cid);
    const local = await this.local.size(cid);
    if (local !== undefined) return local;
    return this.#fromRemotes(blobs => blobs.size(cid));
  }

  /**
   * The blob, or a range of it, from the first place that has it.
   * @throws the last remote's error if none had it and a remote failed.
   */
  async get(cid: string, range?: ByteRange): Promise<SourcedRead | undefined> {
    const local = await this.local.get(cid, range);
    if (local) return { ...local, source: 'local' };
    const remote = await this.#fromRemotes(async (blobs, name) => {
      const read = await blobs.get(cid, range);
      return read && { ...read, source: name };
    });
    if (remote) this.#touch(cid);
    return remote;
  }

  async #fromRemotes<T>(read: (blobs: PlainBlobStore, name: string) => Promise<T | undefined>): Promise<T | undefined> {
    let failure: unknown;
    for (const { name, blobs } of this.#remotes) {
      try {
        const result = await read(blobs, name);
        if (result !== undefined) return result;
      } catch (error) {
        failure = error;
      }
    }
    if (failure) throw failure;
    return undefined;
  }

  #touch(cid: string): void {
    try {
      this.local.index.touch(cid);
    } catch {
      // Read times only inform future placement; never fail a read over one.
    }
  }
}
