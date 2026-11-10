import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AwsClient } from 'aws4fetch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IntegrityError, S3ByteStore, collect, type S3Options } from '../src/index.js';
import { byteStoreContract } from './contract.js';

// Runs S3ByteStore against a real S3 server: a real bucket when S3_ENDPOINT,
// S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET (and S3_REGION) are set, otherwise
// versitygw from the nix dev shell. Skipped when neither is available,
// unless PORTER_REQUIRE_S3_CONFORMANCE is set.
// Against a real bucket, everything is written under a random prefix and
// deleted afterwards.

const remote = process.env.S3_ENDPOINT
  ? {
      endpoint: process.env.S3_ENDPOINT,
      bucket: process.env.S3_BUCKET!,
      region: process.env.S3_REGION ?? 'auto',
      accessKeyId: process.env.S3_ACCESS_KEY!,
      secretAccessKey: process.env.S3_SECRET_KEY!,
    }
  : undefined;
const versitygw = !remote && spawnSync('versitygw', ['--version']).status === 0;
const target = remote ? `remote ${remote.endpoint}` : 'versitygw';
// CI sets this so a missing versitygw fails the run instead of skipping the suite.
if (process.env.PORTER_REQUIRE_S3_CONFORMANCE && !remote && !versitygw) {
  throw new Error('PORTER_REQUIRE_S3_CONFORMANCE is set but versitygw is not on PATH');
}
const MiB = 1024 * 1024;

let config: Omit<S3Options, 'prefix'>;
let server: ChildProcess | undefined;
// Not tempDir(): that's removed after each test, and the bucket must outlive them.
let serverRoot: string | undefined;
const runPrefix = `porter-test-${randomUUID()}/`;
let stores = 0;
const make = () => new S3ByteStore({ ...config, prefix: `${runPrefix}${stores++}/`, partSize: 5 * MiB });

describe.skipIf(!remote && !versitygw)(`S3 conformance (${target})`, () => {
  beforeAll(async () => {
    if (remote) {
      config = remote;
      return;
    }
    const port = 20000 + Math.floor(Math.random() * 20000);
    config = { endpoint: `http://127.0.0.1:${port}`, bucket: 'porter-test', region: 'us-east-1', accessKeyId: 'test', secretAccessKey: 'test-secret' };
    server = spawn('versitygw', ['--port', `127.0.0.1:${port}`, '--access', config.accessKeyId, '--secret', config.secretAccessKey, 'posix', (serverRoot = await mkdtemp(join(tmpdir(), 'porter-vgw-')))], { stdio: 'ignore' });
    const client = new AwsClient({ ...config, service: 's3' });
    const empty = createHash('sha256').digest('hex');
    for (let i = 0; ; i++) {
      try {
        const made = await client.fetch(`${config.endpoint}/${config.bucket}`, { method: 'PUT', headers: { 'x-amz-content-sha256': empty } });
        if (made.ok) break;
      } catch (error) {
        if (i > 50) throw error;
      }
      await sleep(100);
    }
  }, 30_000);

  afterAll(async () => {
    server?.kill();
    if (serverRoot) await rm(serverRoot, { recursive: true, force: true });
    if (!remote) return;
    const client = new AwsClient({ ...config, service: 's3' });
    const empty = createHash('sha256').digest('hex');
    for await (const key of allKeys(client, runPrefix)) {
      await client.fetch(`${config.endpoint}/${config.bucket}/${encodeURIComponent(key)}`, { method: 'DELETE', headers: { 'x-amz-content-sha256': empty } });
    }
  }, 60_000);

  byteStoreContract(target, async () => make());

  it('rejects a single upload whose bytes do not match the hint', async () => {
    const s3 = make();
    const original = createHash('sha256').update('original').digest();
    await expect(s3.put('keytamper', Buffer.from('tampered'), { sha256: original })).rejects.toThrow(IntegrityError);
    expect(await s3.size('keytamper')).toBeUndefined();
  });

  it('round-trips a multipart upload', async () => {
    const s3 = make();
    const bytes = randomBytes(11 * MiB);
    await s3.put('keylarge1', bytes, { sha256: createHash('sha256').update(bytes).digest() });
    expect(await s3.size('keylarge1')).toBe(bytes.length);
    expect(Buffer.from(await collect((await s3.read('keylarge1'))!)).equals(bytes)).toBe(true);
    expect(Buffer.from(await collect((await s3.read('keylarge1', { start: 5 * MiB - 2, end: 5 * MiB + 2 }))!))).toEqual(bytes.subarray(5 * MiB - 2, 5 * MiB + 2));
  }, 120_000);
});

async function* allKeys(client: AwsClient, prefix: string): AsyncIterable<string> {
  const empty = createHash('sha256').digest('hex');
  let token: string | undefined;
  do {
    const query = new URLSearchParams({ 'list-type': '2', prefix });
    if (token) query.set('continuation-token', token);
    const xml = await (await client.fetch(`${config.endpoint}/${config.bucket}?${query}`, { headers: { 'x-amz-content-sha256': empty } })).text();
    for (const [, key] of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) yield key!;
    token = /<IsTruncated>true</.test(xml) ? xml.match(/<NextContinuationToken>([^<]*)</)?.[1] : undefined;
  } while (token);
}
