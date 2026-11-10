import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CODEC_RAW, createSync, toString } from '@atcute/cid';
import { IntegrityError, PlainBlobStore, S3ByteStore, S3Error, collect } from '../src/index.js';
import { FakeS3 } from './fake-s3.js';

const MiB = 1024 * 1024;
const fake = new FakeS3();
let endpoint = '';
beforeAll(async () => {
  endpoint = await fake.start();
});
afterAll(() => fake.stop());
beforeEach(() => {
  fake.requests.length = 0;
  fake.fail = () => undefined;
});

const store = (options: { partSize?: number } = {}) =>
  new S3ByteStore({ endpoint, bucket: fake.bucket, region: 'auto', accessKeyId: 'test', secretAccessKey: 'test', prefix: `${randomUUID()}/`, ...options });
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();

async function* split(bytes: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

describe('S3ByteStore', () => {
  it('signs every request with the real payload hash, never UNSIGNED-PAYLOAD', async () => {
    const s3 = store();
    await s3.put('keysigned', Buffer.from('hello'));
    await s3.size('keysigned');
    await collect((await s3.read('keysigned'))!);
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const request of fake.requests) expect(request.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uploads large sources in equal parts and checks the whole', async () => {
    const s3 = store({ partSize: 5 * MiB });
    const bytes = randomBytes(11 * MiB + 3);
    await s3.put('keylarge1', split(bytes, 64 * 1024), { sha256: sha256(bytes) });
    const parts = fake.requests.filter(r => r.method === 'PUT' && r.path.includes('partNumber'));
    expect(parts).toHaveLength(3);
    expect(Buffer.from(await collect((await s3.read('keylarge1'))!)).equals(bytes)).toBe(true);
    expect(fake.openUploads).toBe(0);
  });

  it('uses one PUT for a source of exactly one part', async () => {
    const s3 = store({ partSize: 5 * MiB });
    await s3.put('keyonepart', split(randomBytes(5 * MiB), MiB));
    expect(fake.requests.filter(r => r.method === 'PUT')).toHaveLength(1);
  });

  it('rejects a single upload whose bytes do not match the hint', async () => {
    const s3 = store();
    const error = await s3.put('keytamper', Buffer.from('tampered'), { sha256: sha256(Buffer.from('original')) }).catch(e => e);
    expect(error).toBeInstanceOf(IntegrityError);
    expect(error.code).toBe('integrity');
    expect(await s3.size('keytamper')).toBeUndefined();
  });

  it('aborts a multipart upload whose bytes do not match the hint', async () => {
    const s3 = store({ partSize: 5 * MiB });
    const bytes = randomBytes(6 * MiB);
    await expect(s3.put('keytamper2', bytes, { sha256: sha256(randomBytes(6 * MiB)) })).rejects.toThrow(IntegrityError);
    expect(await s3.size('keytamper2')).toBeUndefined();
    expect(fake.openUploads).toBe(0);
  });

  it('skips the upload when the key already exists', async () => {
    const s3 = store();
    await s3.put('keyexists', Buffer.from('once'));
    fake.requests.length = 0;
    await s3.put('keyexists', Buffer.from('once'));
    expect(fake.requests.map(r => r.method)).toEqual(['HEAD']);
  });

  it('lists keys across pages, without its prefix', async () => {
    const s3 = store();
    const keys = ['keypage01', 'keypage02', 'keypage03', 'keypage04', 'keypage05'];
    for (const key of keys) await s3.put(key, Buffer.from(key));
    const listed = [];
    for await (const key of s3.keys()) listed.push(key);
    expect(listed.sort()).toEqual(keys);
    expect(fake.requests.filter(r => r.path.includes('list-type')).length).toBeGreaterThan(1);
  });

  it('explains credential failures', async () => {
    fake.fail = () => 403;
    const error = await store().size('keydenied').catch(e => e);
    expect(error).toBeInstanceOf(S3Error);
    expect(error).toMatchObject({ code: 's3', status: 403 });
    expect(error.hint).toMatch(/access key/);
  });

  it('retries server errors a little, then gives up', async () => {
    let calls = 0;
    fake.fail = () => (++calls <= 2 ? 503 : undefined);
    await store().put('keyretry1', Buffer.from('eventually'));
    expect(calls).toBeGreaterThan(2);

    fake.fail = () => 503;
    await expect(store().size('keyretry2')).rejects.toMatchObject({ status: 503 });
  });

  it('backs a PlainBlobStore end to end', async () => {
    const blobs = new PlainBlobStore(store());
    const bytes = Buffer.from('hello world\n');
    const { cid } = await blobs.put(bytes);
    expect(cid).toBe(toString(createSync(CODEC_RAW, bytes)));
    const read = await blobs.get(cid);
    expect(read?.verified).toBe('full');
    expect(Buffer.from(await collect(read!.stream)).equals(bytes)).toBe(true);
  });
});
