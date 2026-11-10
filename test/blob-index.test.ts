import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BlobIndex } from '../src/index.js';
import { tempDir } from './helpers.js';

const A = 'bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4';
const B = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
const RAW = 0x55;
const retry = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 3000 };

function open(path = ':memory:') {
  return new BlobIndex(path, retry);
}

describe('BlobIndex', () => {
  it('records a blob once and queues it for each tier', () => {
    const index = open();
    index.add({ cid: A, size: 12, codec: RAW }, ['r2', 's3'], 100);
    index.add({ cid: A, size: 999, codec: RAW }, ['r2'], 200);
    expect(index.blob(A)).toEqual({ cid: A, size: 12, codec: RAW, addedAt: 100, lastReadAt: null });
    expect(index.replicas(A).map(r => [r.tier, r.state])).toEqual([
      ['r2', 'pending'],
      ['s3', 'pending'],
    ]);
    expect(index.blob(B)).toBeUndefined();
  });

  it('claims due replicas oldest first, and only once', () => {
    const index = open();
    index.add({ cid: B, size: 0, codec: RAW }, ['r2'], 200);
    index.add({ cid: A, size: 12, codec: RAW }, ['r2'], 100);
    expect(index.claim('r2', 1, 300).map(r => r.cid)).toEqual([A]);
    expect(index.claim('r2', 10, 300).map(r => r.cid)).toEqual([B]);
    expect(index.claim('r2', 10, 300)).toEqual([]);
    expect(index.claim('s3', 10, 300)).toEqual([]);
  });

  it('never hands one replica to two connections', async () => {
    const path = join(await tempDir(), 'porter-index.sqlite');
    const first = open(path);
    const second = open(path);
    for (let i = 0; i < 50; i++) first.add({ cid: `bafkreitest${String(i).padStart(4, '0')}`, size: i, codec: RAW }, ['r2'], i);
    const claimed = [];
    for (let round = 0; round < 10; round++) {
      claimed.push(...first.claim('r2', 3, 1000), ...second.claim('r2', 4, 1000));
    }
    const cids = claimed.map(r => r.cid);
    expect(new Set(cids).size).toBe(cids.length);
    expect(cids).toHaveLength(50);
    first.close();
    second.close();
  });

  it('backs off after failures and gives up at the limit', () => {
    const index = open();
    index.add({ cid: A, size: 12, codec: RAW }, ['r2'], 0);
    index.claim('r2', 1, 0);
    expect(index.markFailed(A, 'r2', 'timeout', 0)).toMatchObject({ state: 'pending', attempts: 1, nextAttemptAt: 1000, lastError: 'timeout' });
    expect(index.claim('r2', 1, 999)).toEqual([]);
    expect(index.claim('r2', 1, 1000)).toHaveLength(1);
    expect(index.markFailed(A, 'r2', 'timeout', 1000)).toMatchObject({ state: 'pending', attempts: 2, nextAttemptAt: 3000 });
    index.claim('r2', 1, 3000);
    expect(index.markFailed(A, 'r2', '403 Forbidden', 3000)).toMatchObject({ state: 'failed', attempts: 3, nextAttemptAt: null });
    expect(index.claim('r2', 1, 1e12)).toEqual([]);

    expect(index.retryFailed('r2', 4000)).toBe(1);
    expect(index.replicas(A)[0]).toMatchObject({ state: 'pending', attempts: 0, lastError: '403 Forbidden' });
  });

  it('moves replicas through uploaded to verified', () => {
    const index = open();
    index.add({ cid: A, size: 12, codec: RAW }, ['r2'], 0);
    index.claim('r2', 1, 0);
    index.markUploaded(A, 'r2', 1);
    expect(index.replicas(A)[0]!.state).toBe('uploaded');
    index.markVerified(A, 'r2', 2);
    expect(index.replicas(A)[0]).toMatchObject({ state: 'verified', updatedAt: 2 });
    expect(() => index.markVerified(B, 'r2')).toThrow();
  });

  it('puts replicas left uploading back in the queue', () => {
    const index = open();
    index.add({ cid: A, size: 12, codec: RAW }, ['r2'], 0);
    index.claim('r2', 1, 0);
    expect(index.resetUploading()).toBe(1);
    expect(index.claim('r2', 1, 0)).toHaveLength(1);
  });

  it('counts blobs and bytes per tier and state', () => {
    const index = open();
    index.add({ cid: A, size: 12, codec: RAW }, ['r2'], 0);
    index.add({ cid: B, size: 30, codec: RAW }, ['r2'], 1);
    index.claim('r2', 1, 2);
    index.markUploaded(A, 'r2', 3);
    expect(index.counts()).toEqual([
      { tier: 'r2', state: 'pending', blobs: 1, bytes: 30 },
      { tier: 'r2', state: 'uploaded', blobs: 1, bytes: 12 },
    ]);
  });

  it('updates read times at most once per interval', () => {
    const index = open();
    index.add({ cid: A, size: 12, codec: RAW }, [], 0);
    const hour = 60 * 60 * 1000;
    expect(index.touch(A, 1000)).toBe(true);
    expect(index.touch(A, 1000 + hour - 1)).toBe(false);
    expect(index.blob(A)?.lastReadAt).toBe(1000);
    expect(index.touch(A, 1000 + hour)).toBe(true);
    expect(index.blob(A)?.lastReadAt).toBe(1000 + hour);
    expect(index.touch(B, 1000)).toBe(false);
  });

  it('opens a fresh index from two processes at once', async () => {
    const { execFile } = await import('node:child_process');
    const path = join(await tempDir(), 'porter-index.sqlite');
    const script = `import { BlobIndex } from ${JSON.stringify(new URL('../dist/src/index.js', import.meta.url).href)}; new BlobIndex(process.argv[1]).close();`;
    const open = () =>
      new Promise<number | null>(resolve => {
        const child = execFile(process.execPath, ['--input-type=module', '-e', script, path]);
        child.on('exit', code => resolve(code));
      });
    expect(await Promise.all([open(), open(), open(), open()])).toEqual([0, 0, 0, 0]);
  });

  it('keeps its contents across reopening', async () => {
    const path = join(await tempDir(), 'porter-index.sqlite');
    const first = open(path);
    first.add({ cid: A, size: 12, codec: RAW }, ['r2'], 0);
    first.close();
    const second = open(path);
    expect(second.blob(A)?.size).toBe(12);
    second.close();
  });
});
