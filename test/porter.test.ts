import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileCredentialStore, Porter, PorterConfig, type RemoteConfig } from '../src/index.js';
import { FakeS3 } from './fake-s3.js';
import { tempDir } from './helpers.js';

const fake = new FakeS3();
let endpoint = '';
beforeAll(async () => {
  endpoint = await fake.start();
});
afterAll(() => fake.stop());

const remote = (name: string, newBlobs: 'all' | 'none' = 'all'): RemoteConfig => ({ name, endpoint, bucket: fake.bucket, region: 'auto', prefix: `${randomUUID()}/`, newBlobs });

async function configure(root: string, remotes: RemoteConfig[], withKeys = remotes.map(r => r.name)) {
  const config = await PorterConfig.load(root);
  for (const r of remotes) config.addRemote(r);
  await config.save();
  const credentials = new FileCredentialStore(root);
  for (const name of withKeys) await credentials.set(name, { accessKeyId: 'test', secretAccessKey: 'test' });
}

describe('PorterConfig', () => {
  it('saves remotes and loads them back, without secrets', async () => {
    const root = await tempDir();
    await configure(root, [remote('r2')]);
    const loaded = await PorterConfig.load(root);
    expect(loaded.remotes.map(r => r.name)).toEqual(['r2']);
    expect(await readFile(join(root, 'porter-config.json'), 'utf8')).not.toContain('accessKeyId');
  });

  it.each([
    ['a bad name', { name: 'R2!' }, 'invalid-remote'],
    ['a bad endpoint', { endpoint: 'not a url' }, 'invalid-remote'],
  ])('rejects %s', async (_, change, code) => {
    const config = await PorterConfig.load(await tempDir());
    expect(() => config.addRemote({ ...remote('r2'), ...change })).toThrow(expect.objectContaining({ code }));
  });

  it('refuses duplicate and unknown remotes', async () => {
    const config = await PorterConfig.load(await tempDir());
    config.addRemote(remote('r2'));
    expect(() => config.addRemote(remote('r2'))).toThrow(expect.objectContaining({ code: 'remote-exists' }));
    expect(() => config.removeRemote('s3')).toThrow(expect.objectContaining({ code: 'unknown-remote' }));
    config.removeRemote('r2');
    expect(config.remotes).toEqual([]);
  });
});

describe('FileCredentialStore', () => {
  it('keeps keys in a file only its owner can read', async () => {
    const root = await tempDir();
    const store = new FileCredentialStore(root);
    await store.set('r2', { accessKeyId: 'id', secretAccessKey: 'secret' });
    await store.set('s3', { accessKeyId: 'id2', secretAccessKey: 'secret2' });
    expect(await store.get('r2')).toEqual({ accessKeyId: 'id', secretAccessKey: 'secret' });
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    await store.delete('r2');
    expect(await store.get('r2')).toBeUndefined();
    expect(await store.get('s3')).toBeDefined();
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
  });
});

describe('Porter', () => {
  it('opens an empty root', async () => {
    const root = join(await tempDir(), 'fresh');
    const porter = await Porter.open({ root });
    expect(porter.remotes).toEqual([]);
    expect((await porter.local.put(Buffer.from('hello'))).size).toBe(5);
    porter.close();
  });

  it('queues new blobs for remotes set to all, and replicates them', async () => {
    const root = await tempDir();
    await configure(root, [remote('r2'), remote('cold', 'none')]);
    const porter = await Porter.open({ root });
    const { cid } = await porter.local.put(Buffer.from('hello'));
    expect(porter.local.index.replicas(cid).map(r => r.tier)).toEqual(['r2']);
    expect(await porter.replicator().runOnce()).toMatchObject({ uploaded: 1 });
    expect(await porter.remotes.find(r => r.name === 'r2')!.store.size(cid)).toBe(5);
    porter.close();
  });

  it('leaves out remotes whose keys are missing', async () => {
    const root = await tempDir();
    await configure(root, [remote('r2'), remote('s3')], ['r2']);
    const porter = await Porter.open({ root });
    expect(porter.remotes.map(r => r.name)).toEqual(['r2']);
    expect(porter.missingCredentials).toEqual(['s3']);
    porter.close();
  });

  it('backfills existing blobs only when asked, with a plan first', async () => {
    const root = await tempDir();
    const before = await Porter.open({ root });
    const small = (await before.local.put(Buffer.from('small'))).cid;
    const large = (await before.local.put(Buffer.alloc(1000, 1))).cid;
    before.close();

    await configure(root, [remote('r2')]);
    const porter = await Porter.open({ root });
    const index = porter.local.index;
    expect(index.unqueued('r2')).toEqual({ blobs: 2, bytes: 1005 });
    expect(index.backfill('r2', { maxSize: 100 }, { plan: true })).toEqual({ blobs: 1, bytes: 5 });
    expect(index.replicas(small)).toEqual([]);
    expect(index.backfill('r2', { maxSize: 100 })).toEqual({ blobs: 1, bytes: 5 });
    expect(index.replicas(small).map(r => r.state)).toEqual(['pending']);
    expect(index.replicas(large)).toEqual([]);
    expect(index.backfill('r2', { addedSince: Date.now() + 60_000 })).toEqual({ blobs: 0, bytes: 0 });
    expect(index.backfill('r2')).toEqual({ blobs: 1, bytes: 1000 });
    expect(index.unqueued('r2')).toEqual({ blobs: 0, bytes: 0 });
    porter.close();
  });
});
