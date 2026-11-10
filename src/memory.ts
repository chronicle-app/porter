import type { ByteRange, ByteStore } from './store.js';

export class MemoryByteStore implements ByteStore {
  readonly #items = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.#items.set(key, bytes.slice());
  }

  async get(key: string, range?: ByteRange): Promise<Uint8Array | undefined> {
    const bytes = this.#items.get(key);
    if (!bytes) return undefined;
    return range ? bytes.slice(range.start, range.end) : bytes.slice();
  }

  async size(key: string): Promise<number | undefined> {
    return this.#items.get(key)?.length;
  }
}
