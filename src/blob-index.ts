import { DatabaseSync } from 'node:sqlite';

/** Where a blob stands with one remote tier. */
export type ReplicaState = 'pending' | 'uploading' | 'uploaded' | 'verified' | 'failed';

export interface BlobRow {
  cid: string;
  size: number;
  codec: number;
  /** Milliseconds since the epoch. */
  addedAt: number;
  /**
   * When a read of the blob last started, to within `TOUCH_INTERVAL_MS`;
   * `null` if never read. Kept so future placement rules can tell hot blobs
   * from cold ones.
   */
  lastReadAt: number | null;
}

export interface ReplicaRow {
  cid: string;
  tier: string;
  state: ReplicaState;
  attempts: number;
  /** When a pending retry becomes due, in milliseconds since the epoch. */
  nextAttemptAt: number | null;
  lastError: string | null;
  updatedAt: number;
}

export interface TierCounts {
  tier: string;
  state: ReplicaState;
  blobs: number;
  bytes: number;
}

export interface RetryPolicy {
  /** Failures before a replica is marked `failed` and left for `retry`. */
  maxAttempts: number;
  /** Delay after the first failure; it doubles with each further one. */
  baseDelayMs: number;
  maxDelayMs: number;
}

/** Reads within this long of the last recorded one don't update `lastReadAt`. */
export const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 10, baseDelayMs: 30_000, maxDelayMs: 6 * 60 * 60 * 1000 };

const MIGRATIONS = [
  `CREATE TABLE blobs (
     cid TEXT PRIMARY KEY,
     size INTEGER NOT NULL,
     codec INTEGER NOT NULL,
     added_at INTEGER NOT NULL
   ) STRICT;
   CREATE TABLE replicas (
     cid TEXT NOT NULL REFERENCES blobs (cid),
     tier TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('pending', 'uploading', 'uploaded', 'verified', 'failed')),
     attempts INTEGER NOT NULL DEFAULT 0,
     next_attempt_at INTEGER,
     last_error TEXT,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (cid, tier)
   ) STRICT;
   CREATE INDEX replicas_due ON replicas (tier, state, next_attempt_at);`,
  `ALTER TABLE blobs ADD COLUMN last_read_at INTEGER;`,
];

/**
 * What Porter knows about its blobs: size, codec, and where each stands with
 * each remote tier. The files on disk are the truth for local bytes; this is
 * an index and a replication queue on top, and `LocalStore.scan` can rebuild
 * it. Safe to open from several processes at once.
 */
export class BlobIndex {
  readonly #db: DatabaseSync;

  /** @param path The database file, created if missing. Use `:memory:` for tests. */
  constructor(
    readonly path: string,
    readonly retry: RetryPolicy = DEFAULT_RETRY,
  ) {
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;');
    this.#migrate();
  }

  close(): void {
    this.#db.close();
  }

  /**
   * Record a blob and queue it for each tier. Blobs and replicas that are
   * already recorded are left as they are.
   */
  add(blob: Pick<BlobRow, 'cid' | 'size' | 'codec'>, tiers: readonly string[], now = Date.now()): void {
    this.#transaction(() => {
      this.#db.prepare('INSERT INTO blobs (cid, size, codec, added_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').run(blob.cid, blob.size, blob.codec, now);
      const queue = this.#db.prepare("INSERT INTO replicas (cid, tier, state, updated_at) VALUES (?, ?, 'pending', ?) ON CONFLICT DO NOTHING");
      for (const tier of tiers) queue.run(blob.cid, tier, now);
    });
  }

  blob(cid: string): BlobRow | undefined {
    const row = this.#db.prepare('SELECT cid, size, codec, added_at, last_read_at FROM blobs WHERE cid = ?').get(cid);
    return row && toBlob(row);
  }

  /**
   * Note that a read of `cid` started. Only writes when the recorded time is
   * at least `TOUCH_INTERVAL_MS` old, so ranged reads of a video don't each
   * cost a write. Returns whether it wrote.
   */
  touch(cid: string, now = Date.now()): boolean {
    const result = this.#db
      .prepare('UPDATE blobs SET last_read_at = ? WHERE cid = ? AND (last_read_at IS NULL OR last_read_at <= ?)')
      .run(now, cid, now - TOUCH_INTERVAL_MS);
    return result.changes > 0;
  }

  replicas(cid: string): ReplicaRow[] {
    return this.#db.prepare('SELECT * FROM replicas WHERE cid = ? ORDER BY tier').all(cid).map(toReplica);
  }

  /**
   * Take up to `limit` due replicas for `tier`, oldest blobs first, and mark
   * them `uploading`. One statement does both, so two processes never claim
   * the same replica.
   */
  claim(tier: string, limit: number, now = Date.now()): ReplicaRow[] {
    return this.#db
      .prepare(
        `UPDATE replicas SET state = 'uploading', updated_at = :now
         WHERE (cid, tier) IN (
           SELECT r.cid, r.tier FROM replicas r JOIN blobs b USING (cid)
           WHERE r.tier = :tier AND r.state = 'pending' AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= :now)
           ORDER BY b.added_at, r.cid LIMIT :limit)
         RETURNING *`,
      )
      .all({ tier, limit, now })
      .map(toReplica);
  }

  markUploaded(cid: string, tier: string, now = Date.now()): void {
    this.#set(cid, tier, "state = 'uploaded', next_attempt_at = NULL, last_error = NULL", now);
  }

  markVerified(cid: string, tier: string, now = Date.now()): void {
    this.#set(cid, tier, "state = 'verified', next_attempt_at = NULL, last_error = NULL", now);
  }

  /**
   * Record a failed attempt. The replica goes back to `pending` with an
   * exponential backoff, or to `failed` once `maxAttempts` is reached.
   */
  markFailed(cid: string, tier: string, error: string, now = Date.now()): ReplicaRow {
    const { attempts } = this.#replica(cid, tier);
    const tries = attempts + 1;
    const delay = Math.min(this.retry.baseDelayMs * 2 ** (tries - 1), this.retry.maxDelayMs);
    const giveUp = tries >= this.retry.maxAttempts;
    this.#db
      .prepare('UPDATE replicas SET state = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE cid = ? AND tier = ?')
      .run(giveUp ? 'failed' : 'pending', tries, giveUp ? null : now + delay, error, now, cid, tier);
    return this.#replica(cid, tier);
  }

  /** Put `failed` replicas back in the queue with a fresh count. Returns how many. */
  retryFailed(tier?: string, now = Date.now()): number {
    const result = this.#db
      .prepare("UPDATE replicas SET state = 'pending', attempts = 0, next_attempt_at = NULL, updated_at = ? WHERE state = 'failed' AND (? IS NULL OR tier = ?)")
      .run(now, tier ?? null, tier ?? null);
    return Number(result.changes);
  }

  /**
   * Put replicas left `uploading` by a process that died back in the queue.
   * Call it only when no other process can be uploading. Returns how many.
   */
  resetUploading(now = Date.now()): number {
    return Number(this.#db.prepare("UPDATE replicas SET state = 'pending', updated_at = ? WHERE state = 'uploading'").run(now).changes);
  }

  /** Blob counts and bytes per tier and state, for status reports. */
  counts(): TierCounts[] {
    return this.#db
      .prepare('SELECT r.tier, r.state, COUNT(*) AS blobs, COALESCE(SUM(b.size), 0) AS bytes FROM replicas r JOIN blobs b USING (cid) GROUP BY r.tier, r.state ORDER BY r.tier, r.state')
      .all()
      .map(row => ({ tier: String(row.tier), state: row.state as ReplicaState, blobs: Number(row.blobs), bytes: Number(row.bytes) }));
  }

  /** Every recorded CID, in no particular order. */
  *cids(): Iterable<string> {
    for (const row of this.#db.prepare('SELECT cid FROM blobs').iterate()) yield String(row.cid);
  }

  #replica(cid: string, tier: string): ReplicaRow {
    const row = this.#db.prepare('SELECT * FROM replicas WHERE cid = ? AND tier = ?').get(cid, tier);
    if (!row) throw new Error(`No replica of ${cid} for tier ${tier}`);
    return toReplica(row);
  }

  #set(cid: string, tier: string, assignments: string, now: number): void {
    const result = this.#db.prepare(`UPDATE replicas SET ${assignments}, updated_at = ? WHERE cid = ? AND tier = ?`).run(now, cid, tier);
    if (result.changes === 0) throw new Error(`No replica of ${cid} for tier ${tier}`);
  }

  #transaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #migrate(): void {
    this.#transaction(() => {
      const { user_version: version } = this.#db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (version > MIGRATIONS.length) throw new Error(`Index ${this.path} is from a newer Porter (schema ${version})`);
      for (let i = version; i < MIGRATIONS.length; i++) this.#db.exec(MIGRATIONS[i]!);
      this.#db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
    });
  }
}

type Row = Record<string, unknown>;

function toBlob(row: Row): BlobRow {
  return {
    cid: String(row.cid),
    size: Number(row.size),
    codec: Number(row.codec),
    addedAt: Number(row.added_at),
    lastReadAt: row.last_read_at === null ? null : Number(row.last_read_at),
  };
}

function toReplica(row: Row): ReplicaRow {
  return {
    cid: String(row.cid),
    tier: String(row.tier),
    state: row.state as ReplicaState,
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at === null ? null : Number(row.next_attempt_at),
    lastError: row.last_error === null ? null : String(row.last_error),
    updatedAt: Number(row.updated_at),
  };
}
