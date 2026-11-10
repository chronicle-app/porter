import { parseCid } from './cid.js';
import { IntegrityError } from './errors.js';
import type { LocalStore } from './local.js';
import { S3Error } from './s3.js';
import type { ByteStore } from './store.js';

/** A remote tier: a name, as used in the index, and where its bytes go. */
export interface Remote {
  name: string;
  store: ByteStore;
}

export type ReplicationEvent =
  | { kind: 'uploaded'; remote: string; cid: string; size: number }
  /** The blob failed; it's retried later unless `gaveUp`. */
  | { kind: 'blob-failed'; remote: string; cid: string; error: Error; gaveUp: boolean }
  /** The remote as a whole failed; nothing is sent to it until `until`. */
  | { kind: 'remote-paused'; remote: string; until: number; error: Error };

export interface ReplicatorOptions {
  /** Uploads in flight per remote. Defaults to 4. */
  concurrency?: number;
  /** Pause after a remote's first failure; it doubles with each one after. Defaults to 30 seconds. */
  pauseBaseMs?: number;
  /** Longest pause. Defaults to 30 minutes. */
  pauseMaxMs?: number;
  /** Called for each upload, failure, and pause. The replicator never prints. */
  onEvent?: (event: ReplicationEvent) => void;
  /** Current time in milliseconds. For tests. */
  clock?: () => number;
}

export interface ReplicationSummary {
  uploaded: number;
  failed: number;
  /** Remotes paused when the run ended. */
  paused: string[];
}

/**
 * Copies blobs from a `LocalStore` to its remotes, working through each
 * remote's queue in the index. Every upload carries the blob's SHA-256, so
 * the remote rejects a local copy that no longer matches its CID.
 *
 * Failures are sorted into two kinds. If the remote is unreachable, refuses
 * the credentials, or is overloaded, the whole remote pauses with its own
 * backoff and the blob goes back to the queue without losing an attempt. If
 * the blob itself is the problem (its local copy is missing or damaged, or
 * the remote rejects it), the blob's attempts count up toward `failed`.
 */
export class Replicator {
  readonly #local: LocalStore;
  readonly #remotes: Remote[];
  readonly #concurrency: number;
  readonly #pauseBaseMs: number;
  readonly #pauseMaxMs: number;
  readonly #emit: (event: ReplicationEvent) => void;
  readonly #clock: () => number;
  readonly #pauses = new Map<string, { until: number; failures: number }>();

  constructor(local: LocalStore, remotes: Remote[], options: ReplicatorOptions = {}) {
    this.#local = local;
    this.#remotes = remotes;
    this.#concurrency = options.concurrency ?? 4;
    this.#pauseBaseMs = options.pauseBaseMs ?? 30_000;
    this.#pauseMaxMs = options.pauseMaxMs ?? 30 * 60 * 1000;
    this.#emit = options.onEvent ?? (() => {});
    this.#clock = options.clock ?? Date.now;
  }

  /**
   * Put uploads left in flight by a process that died back in the queue.
   * Call it once at startup, and only while holding the lock that keeps
   * other replicators away from this store.
   */
  recover(): number {
    return this.#local.index.resetUploading(this.#clock());
  }

  /** When `remote` is paused until, or `undefined` if it isn't. */
  pausedUntil(remote: string): number | undefined {
    const pause = this.#pauses.get(remote);
    return pause && pause.until > this.#clock() ? pause.until : undefined;
  }

  /** Work through every remote's due uploads until none are left or the remote pauses. */
  async runOnce(): Promise<ReplicationSummary> {
    const summary: ReplicationSummary = { uploaded: 0, failed: 0, paused: [] };
    await Promise.all(this.#remotes.map(remote => this.#drain(remote, summary)));
    summary.paused = this.#remotes.map(r => r.name).filter(name => this.pausedUntil(name) !== undefined);
    return summary;
  }

  async #drain(remote: Remote, summary: ReplicationSummary): Promise<void> {
    while (this.pausedUntil(remote.name) === undefined) {
      const batch = this.#local.index.claim(remote.name, this.#concurrency, this.#clock());
      if (batch.length === 0) return;
      const outcomes = await Promise.all(batch.map(row => this.#upload(remote, row.cid)));
      for (const outcome of outcomes) {
        if (outcome === 'uploaded') summary.uploaded++;
        if (outcome === 'failed') summary.failed++;
      }
      const outage = outcomes.find((outcome): outcome is Error => outcome instanceof Error);
      if (outage) {
        this.#pause(remote.name, outage);
        return;
      }
      if (outcomes.includes('uploaded')) this.#pauses.delete(remote.name);
    }
  }

  /** Returns what happened, or the error if the remote as a whole failed. */
  async #upload(remote: Remote, cid: string): Promise<'uploaded' | 'failed' | Error> {
    const index = this.#local.index;
    try {
      const source = await this.#local.files.read(cid);
      if (!source) throw new MissingLocalCopy(cid);
      await remote.store.put(cid, source, { sha256: parseCid(cid).digest.contents });
      index.markVerified(cid, remote.name, this.#clock());
      this.#emit({ kind: 'uploaded', remote: remote.name, cid, size: index.blob(cid)?.size ?? 0 });
      return 'uploaded';
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      if (isRemoteWide(error)) {
        index.release(cid, remote.name, this.#clock());
        return error;
      }
      const row = index.markFailed(cid, remote.name, error.message, this.#clock());
      this.#emit({ kind: 'blob-failed', remote: remote.name, cid, error, gaveUp: row.state === 'failed' });
      return 'failed';
    }
  }

  #pause(remote: string, error: Error): void {
    const failures = (this.#pauses.get(remote)?.failures ?? 0) + 1;
    const until = this.#clock() + Math.min(this.#pauseBaseMs * 2 ** (failures - 1), this.#pauseMaxMs);
    this.#pauses.set(remote, { until, failures });
    this.#emit({ kind: 'remote-paused', remote, until, error });
  }
}

/** A queued blob's local file is gone. */
export class MissingLocalCopy extends IntegrityError {
  constructor(cid: string) {
    super(`No local copy of ${cid}`, 'The file was removed or moved outside Porter. Restore it from another copy.');
  }
}

/** Whether `error` means the remote is unavailable, not that this blob failed. */
function isRemoteWide(error: Error): boolean {
  if (error instanceof S3Error) return [401, 403, 408, 429].includes(error.status) || error.status >= 500;
  // fetch reports network failures (refused, reset, DNS, TLS) as TypeError('fetch failed').
  return error instanceof TypeError && error.message === 'fetch failed';
}
