import { randomBytes } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CODEC_RAW, createSync, toString } from '@atcute/cid';
import { Access, LocalStore, MemoryByteStore, ReadThrough, parseRange, serveRasl, type RaslServer } from '../src/index.js';
import { tempDir } from './helpers.js';

const HELLO = 'bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4';
const open: { server: RaslServer; local: LocalStore }[] = [];
afterEach(async () => {
  for (const { server, local } of open.splice(0)) {
    await server.close();
    local.close();
  }
});

async function start(remote?: MemoryByteStore) {
  const root = await tempDir();
  const local = new LocalStore({ root });
  const access = await Access.load(root);
  const reader = new ReadThrough(local, remote ? [{ name: 'r2', store: remote }] : []);
  const server = await serveRasl({ reader, access });
  open.push({ server, local });
  const auth = { authorization: `Bearer ${access.token}` };
  const get = (cid: string, headers: Record<string, string> = {}, method = 'GET') =>
    fetch(`${server.url}/.well-known/rasl/${cid}`, { method, headers: { ...auth, ...headers } });
  return { root, local, access, server, get, auth };
}

/** A raw request, so tests can send any Host header. */
function raw(url: string, headers: Record<string, string>): Promise<{ status: number; body: Buffer; complete: boolean }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks), complete: res.complete }));
      res.on('error', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks), complete: false }));
      res.on('aborted', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks), complete: false }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('RASL server', () => {
  it('serves a blob as octet-stream with immutable caching', async () => {
    const { local, get } = await start();
    await local.put(Buffer.from('hello world\n'));
    const res = await get(HELLO);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello world\n');
    expect(Object.fromEntries(res.headers)).toMatchObject({
      'content-type': 'application/octet-stream',
      'content-length': '12',
      'accept-ranges': 'bytes',
      etag: `"${HELLO}"`,
      'cache-control': expect.stringContaining('immutable'),
      'x-content-type-options': 'nosniff',
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers HEAD with headers and no body', async () => {
    const { local, get } = await start();
    await local.put(Buffer.from('hello world\n'));
    const res = await get(HELLO, {}, 'HEAD');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('12');
    expect(await res.text()).toBe('');
  });

  it('serves byte ranges', async () => {
    const { local, get } = await start();
    await local.put(Buffer.from('hello world\n'));
    const middle = await get(HELLO, { range: 'bytes=6-10' });
    expect(middle.status).toBe(206);
    expect(middle.headers.get('content-range')).toBe('bytes 6-10/12');
    expect(await middle.text()).toBe('world');
    expect(await (await get(HELLO, { range: 'bytes=6-' })).text()).toBe('world\n');
    expect(await (await get(HELLO, { range: 'bytes=-6' })).text()).toBe('world\n');
    const past = await get(HELLO, { range: 'bytes=50-' });
    expect(past.status).toBe(416);
    expect(past.headers.get('content-range')).toBe('bytes */12');
  });

  it('streams large blobs intact', async () => {
    const { local, get } = await start();
    const bytes = randomBytes(5 * 1024 * 1024 + 7);
    const { cid } = await local.put(bytes);
    expect(Buffer.from(await (await get(cid)).arrayBuffer()).equals(bytes)).toBe(true);
  });

  it('records the read', async () => {
    const { local, get } = await start();
    await local.put(Buffer.from('hello world\n'));
    await (await get(HELLO, { range: 'bytes=0-0' })).text();
    expect(local.index.blob(HELLO)?.lastReadAt).not.toBeNull();
  });

  it.each([
    ['an unknown CID', 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku', 404],
    ['a string that is not a DASL CID', 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', 400],
  ])('answers %s with %i', async (_, cid, status) => {
    const { get } = await start();
    expect((await get(cid)).status).toBe(status);
  });

  it('refuses other paths and methods', async () => {
    const { server, auth, get } = await start();
    expect((await fetch(`${server.url}/`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${server.url}/.well-known/rasl/${HELLO}/extra`, { headers: auth })).status).toBe(404);
    const put = await get(HELLO, {}, 'PUT');
    expect(put.status).toBe(405);
    expect(put.headers.get('allow')).toBe('GET, HEAD');
  });

  it('requires the token or a capability', async () => {
    const { local, server } = await start();
    await local.put(Buffer.from('hello world\n'));
    const url = `${server.url}/.well-known/rasl/${HELLO}`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: 'Bearer wrong' } })).status).toBe(403);
  });

  it('accepts a capability URL for its CID only', async () => {
    const { local, server } = await start();
    await local.put(Buffer.from('hello world\n'));
    const { cid: other } = await local.put(Buffer.from('other'));
    const url = server.urlFor(HELLO);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello world\n');
    expect((await fetch(url.replace(HELLO, other))).status).toBe(403);
    expect((await fetch(url.replace(/cap=[^&]+/, 'cap=forged'))).status).toBe(403);
    expect((await fetch(url.replace(/exp=\d+/, 'exp=9999999999'))).status).toBe(403);
  });

  it('refuses an expired capability', async () => {
    const { local, server, access } = await start();
    await local.put(Buffer.from('hello world\n'));
    const { exp, cap } = access.capability(HELLO, Date.now() - 1000);
    expect((await fetch(`${server.url}/.well-known/rasl/${HELLO}?exp=${exp}&cap=${cap}`)).status).toBe(403);
  });

  it('refuses requests that name another host', async () => {
    const { local, server, auth } = await start();
    await local.put(Buffer.from('hello world\n'));
    const url = `${server.url}/.well-known/rasl/${HELLO}`;
    expect((await raw(url, { ...auth, host: 'evil.example' })).status).toBe(403);
    expect((await raw(url, { ...auth, host: `localhost:${new URL(server.url).port}` })).status).toBe(200);
  });

  it('cuts off a blob that fails its hash check', async () => {
    const { local, server, auth } = await start();
    await local.put(Buffer.from('hello world\n'));
    await writeFile(local.files.path(HELLO), 'hello w0rld\n');
    const res = await raw(`${server.url}/.well-known/rasl/${HELLO}`, { ...auth, host: new URL(server.url).host });
    expect(res.status).toBe(200);
    expect(res.complete).toBe(false);
    expect(res.body.length).toBeLessThan(12);
  });

  it('reads through to a remote when the local store lacks a blob', async () => {
    const remote = new MemoryByteStore();
    const bytes = Buffer.from('only on the remote');
    const cid = toString(createSync(CODEC_RAW, bytes));
    await remote.put(cid, bytes);
    const { local, get } = await start(remote);
    const res = await get(cid);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('only on the remote');
    expect(await (await get(cid, { range: 'bytes=5-6' })).text()).toBe('on');
    expect(await local.size(cid)).toBeUndefined();
  });

  it('keeps its secrets private and stable across restarts', async () => {
    const root = await tempDir();
    const first = await Access.load(root);
    const second = await Access.load(root);
    expect(second.token).toBe(first.token);
    expect(second.allowsCapability(HELLO, ...Object.values(first.capability(HELLO, Date.now() + 60_000)) as [string, string])).toBe(true);
    expect((await stat(join(root, 'porter-token'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, 'porter-secret'))).mode & 0o777).toBe(0o600);
    expect((await readFile(join(root, 'porter-token'), 'utf8')).trim()).toBe(first.token);
  });
});

describe('parseRange', () => {
  it.each([
    [undefined, null],
    ['bytes=0-4', { start: 0, end: 5 }],
    ['bytes=5-', { start: 5, end: 12 }],
    ['bytes=-3', { start: 9, end: 12 }],
    ['bytes=-50', { start: 0, end: 12 }],
    ['bytes=10-50', { start: 10, end: 12 }],
    ['bytes=12-', 'unsatisfiable'],
    ['bytes=-0', 'unsatisfiable'],
    ['bytes=5-2', null],
    ['bytes=0-1,4-5', null],
    ['items=0-4', null],
  ])('reads %j', (header, expected) => {
    expect(parseRange(header, 12)).toEqual(expected);
  });
});
