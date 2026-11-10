import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LocalStore,
  MemoryByteStore,
  Replicator,
  S3ByteStore,
  S3Error,
  collect,
  type ByteRange,
  type ByteSource,
  type ByteStore,
  type PutHints,
  type ReplicationEvent,
} from '../src/index.js';
import { FakeS3 } from './fake-s3.js';
import { tempDir } from './helpers.js';

/** A remote that fails the next puts with the given errors, then works. */
class FlakyStore implements ByteStore {
  readonly inner = new MemoryByteStore();
  failures: Error[] = [];
  puts = 0;
  async put(key: string, source: ByteSource, hints?: PutHints) {
    this.puts++;
    const failure = this.failures.shift();
    if (failure) {
      for await (const _ of source instanceof Uint8Array ? [source] : source);
      throw failure;
    }
    await this.inner.put(key, source, hints);
  }
  read(key: string, range?: ByteRange) {
    return this.inner.read(key, range);
  }
  size(key: string) {
    return this.inner.size(key);
  }
  keys() {
    return this.inner.keys();
  }
}

const outage = () => new S3Error('PUT failed with 503', 503, 'ServiceUnavailable');

async function setup(remotes = ['r2'], retry = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10_000 }) {
  const local = new LocalStore({ root: await tempDir(), tiers: remotes, retry });
  const stores = Object.fromEntries(remotes.map(name => [name, new FlakyStore()]));
  let now = 1_000_000;
  const events: ReplicationEvent[] = [];
  const replicator = new Replicator(
    local,
    remotes.map(name => ({ name, store: stores[name]! })),
    { clock: () => now, onEvent: event => events.push(event), pauseBaseMs: 30_000, pauseMaxMs: 120_000 },
  );
  const put = async (text: string) => (await local.put(Buffer.from(text))).cid;
  return { local, stores, replicator, events, put, advance: (ms: number) => (now += ms), state: (cid: string) => local.index.replicas(cid).map(r => r.state) };
}

describe('Replicator', () => {
  it('uploads queued blobs and marks them verified', async () => {
    const { local, stores, replicator, events, put, state } = await setup();
    const cids = await Promise.all(['one', 'two', 'three', 'four', 'five', 'six'].map(put));
    expect(await replicator.runOnce()).toEqual({ uploaded: 6, failed: 0, paused: [] });
    for (const cid of cids) {
      expect(state(cid)).toEqual(['verified']);
      expect(await stores.r2!.size(cid)).toBe(local.index.blob(cid)!.size);
    }
    expect(events.filter(e => e.kind === 'uploaded')).toHaveLength(6);
    expect(await replicator.runOnce()).toEqual({ uploaded: 0, failed: 0, paused: [] });
    local.close();
  });

  it('pauses a remote that is down without spending attempts', async () => {
    const { local, stores, replicator, events, put, advance } = await setup();
    const cid = await put('hello');
    stores.r2!.failures = [outage(), outage()];

    expect(await replicator.runOnce()).toEqual({ uploaded: 0, failed: 0, paused: ['r2'] });
    expect(local.index.replicas(cid)[0]).toMatchObject({ state: 'pending', attempts: 0 });
    expect(events.at(-1)).toMatchObject({ kind: 'remote-paused', remote: 'r2' });

    // Paused: nothing is sent until the pause is over.
    advance(29_999);
    await replicator.runOnce();
    expect(stores.r2!.puts).toBe(1);

    // The second failure doubles the pause.
    advance(1);
    await replicator.runOnce();
    expect(replicator.pausedUntil('r2')).toBe(1_000_000 + 30_000 + 60_000);

    advance(60_000);
    expect(await replicator.runOnce()).toEqual({ uploaded: 1, failed: 0, paused: [] });
    expect(replicator.pausedUntil('r2')).toBeUndefined();
    local.close();
  });

  it('treats network failures and refused credentials as the remote being down', async () => {
    const { local, stores, replicator, put } = await setup();
    const cid = await put('hello');
    stores.r2!.failures = [new TypeError('fetch failed')];
    expect((await replicator.runOnce()).paused).toEqual(['r2']);
    expect(local.index.replicas(cid)[0]!.attempts).toBe(0);

    const second = await setup();
    await second.put('hello');
    second.stores.r2!.failures = [new S3Error('PUT failed with 403', 403, 'AccessDenied')];
    expect((await second.replicator.runOnce()).paused).toEqual(['r2']);
    local.close();
    second.local.close();
  });

  it('keeps other remotes going while one is down', async () => {
    const { local, stores, replicator, put, state } = await setup(['r2', 's3']);
    const cid = await put('hello');
    stores.s3!.failures = [outage()];
    expect(await replicator.runOnce()).toEqual({ uploaded: 1, failed: 0, paused: ['s3'] });
    expect(state(cid)).toEqual(['verified', 'pending']);
    local.close();
  });

  it('counts a missing local copy against the blob and carries on', async () => {
    const { local, replicator, events, put } = await setup();
    const gone = await put('gone');
    const kept = await put('kept');
    await rm(local.files.path(gone));
    expect(await replicator.runOnce()).toEqual({ uploaded: 1, failed: 1, paused: [] });
    expect(local.index.replicas(gone)[0]).toMatchObject({ state: 'pending', attempts: 1, lastError: expect.stringContaining('No local copy') });
    expect(local.index.replicas(kept)[0]!.state).toBe('verified');
    expect(events.find(e => e.kind === 'blob-failed')).toMatchObject({ cid: gone, gaveUp: false });
    local.close();
  });

  it('gives up on a blob after its attempts run out', async () => {
    const { local, replicator, events, put, advance } = await setup();
    const cid = await put('gone');
    await rm(local.files.path(cid));
    for (let i = 0; i < 3; i++) {
      await replicator.runOnce();
      advance(10_000);
    }
    expect(local.index.replicas(cid)[0]).toMatchObject({ state: 'failed', attempts: 3 });
    expect(events.filter(e => e.kind === 'blob-failed').at(-1)).toMatchObject({ gaveUp: true });
    local.close();
  });

  it('puts uploads left in flight back in the queue on recover', async () => {
    const { local, replicator, put } = await setup();
    const cid = await put('hello');
    local.index.claim('r2', 1);
    expect(await replicator.runOnce()).toEqual({ uploaded: 0, failed: 0, paused: [] });
    expect(replicator.recover()).toBe(1);
    expect(await replicator.runOnce()).toMatchObject({ uploaded: 1 });
    expect(local.index.replicas(cid)[0]!.state).toBe('verified');
    local.close();
  });
});

describe('Replicator to S3', () => {
  const fake = new FakeS3();
  let endpoint = '';
  beforeAll(async () => {
    endpoint = await fake.start();
  });
  afterAll(() => fake.stop());

  const s3 = () => new S3ByteStore({ endpoint, bucket: fake.bucket, region: 'auto', accessKeyId: 'test', secretAccessKey: 'test', prefix: `${randomUUID()}/` });

  it('uploads blobs that read back byte for byte', async () => {
    const local = new LocalStore({ root: await tempDir(), tiers: ['r2'] });
    const remote = s3();
    const cids = [];
    for (let i = 0; i < 9; i++) cids.push((await local.put(Buffer.from(`blob ${i}`))).cid);
    expect(await new Replicator(local, [{ name: 'r2', store: remote }]).runOnce()).toMatchObject({ uploaded: 9 });
    for (const [i, cid] of cids.entries()) expect(Buffer.from(await collect((await remote.read(cid))!)).toString()).toBe(`blob ${i}`);
    local.close();
  });

  it('refuses to upload a damaged local copy', async () => {
    const local = new LocalStore({ root: await tempDir(), tiers: ['r2'] });
    const remote = s3();
    const { cid } = await local.put(Buffer.from('hello world\n'));
    await writeFile(local.files.path(cid), 'hello w0rld\n');
    const events: ReplicationEvent[] = [];
    expect(await new Replicator(local, [{ name: 'r2', store: remote }], { onEvent: e => events.push(e) }).runOnce()).toMatchObject({ uploaded: 0, failed: 1 });
    expect(await remote.size(cid)).toBeUndefined();
    expect(events[0]).toMatchObject({ kind: 'blob-failed', error: { code: 'integrity' } });
    local.close();
  });
});
