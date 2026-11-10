import { checkKey, chunks, collect, type ByteRange, type ByteSource, type StagedWrite, type StagingByteStore } from './store.js';

/** A `ByteStore` in memory, for tests and short-lived use. */
export class MemoryByteStore implements StagingByteStore {
  readonly #items = new Map<string, Uint8Array>();

  async put(key: string, source: ByteSource): Promise<void> {
    checkKey(key);
    const bytes = await collect(chunks(source));
    if (!this.#items.has(key)) this.#items.set(key, Uint8Array.from(bytes));
  }

  async stage(): Promise<StagedWrite> {
    const parts: Uint8Array[] = [];
    let open = true;
    return {
      write: async chunk => {
        if (!open) throw new Error('Staged write is closed');
        parts.push(Uint8Array.from(chunk));
      },
      commit: async key => {
        checkKey(key);
        if (!open) throw new Error('Staged write is closed');
        open = false;
        if (!this.#items.has(key)) this.#items.set(key, Buffer.concat(parts));
      },
      abort: async () => {
        open = false;
        parts.length = 0;
      },
    };
  }

  async read(key: string, range?: ByteRange): Promise<AsyncIterable<Uint8Array> | undefined> {
    checkKey(key);
    const bytes = this.#items.get(key);
    if (!bytes) return undefined;
    return chunks(range ? bytes.slice(range.start, range.end) : bytes.slice());
  }

  async size(key: string): Promise<number | undefined> {
    checkKey(key);
    return this.#items.get(key)?.length;
  }
}
