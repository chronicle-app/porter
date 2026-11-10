import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Access, FileCredentialStore, Porter, PorterConfig, runningServe, serve, type RunningServe, type ServeEvent } from '../src/index.js';
import { FakeS3 } from './fake-s3.js';
import { tempDir } from './helpers.js';

const fake = new FakeS3();
let endpoint = '';
beforeAll(async () => {
  endpoint = await fake.start();
});
afterAll(() => fake.stop());

const running: RunningServe[] = [];
afterEach(async () => {
  fake.fail = () => undefined;
  await Promise.all(running.splice(0).map(r => r.stop()));
});

async function withRemote(root: string) {
  const config = await PorterConfig.load(root);
  config.addRemote({ name: 'r2', endpoint, bucket: fake.bucket, region: 'auto', prefix: `${randomUUID()}/`, newBlobs: 'all' });
  await config.save();
  await new FileCredentialStore(root).set('r2', { accessKeyId: 'test', secretAccessKey: 'test' });
}

async function start(root: string, options: Parameters<typeof serve>[0] = {}) {
  const events: ServeEvent[] = [];
  const r = await serve({ root, port: 0, intervalMs: 20, onEvent: e => events.push(e), ...options });
  running.push(r);
  return { r, events };
}

async function until(check: () => boolean | Promise<boolean>, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await sleep(20);
  }
}

describe('serve', () => {
  it('takes the lock, says where it is, and cleans up on stop', async () => {
    const root = await tempDir();
    const { r, events } = await start(root);
    expect(events[0]).toMatchObject({ kind: 'started', url: r.url, pid: process.pid });
    expect((await readFile(join(root, 'porter-serve.lock'), 'utf8')).trim()).toBe(String(process.pid));
    expect(await runningServe(root)).toMatchObject({ pid: process.pid, url: r.url });

    expect(await r.stop()).toBe('stopped');
    await expect(stat(join(root, 'porter-serve.lock'))).rejects.toThrow();
    expect(await runningServe(root)).toBeUndefined();
  });

  it('refuses a second server for the same root, saying where the first is', async () => {
    const root = await tempDir();
    const { r } = await start(root);
    const error = await serve({ root, port: 0 }).catch(e => e);
    expect(error).toMatchObject({ code: 'already-serving', hint: expect.stringContaining(r.url) });
  });

  it('takes over a lock left by a process that died', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'porter-serve.lock'), '999999');
    const { r } = await start(root);
    expect(r.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('reports a port in use', async () => {
    const root = await tempDir();
    const { r } = await start(root);
    const port = Number(new URL(r.url).port);
    const error = await serve({ root: await tempDir(), port }).catch(e => e);
    expect(error).toMatchObject({ code: 'port-in-use', hint: expect.stringContaining('--port') });
  });

  it('uploads blobs written by another process and serves them', async () => {
    const root = await tempDir();
    await withRemote(root);
    const { r, events } = await start(root);

    const writer = await Porter.open({ root });
    const { cid } = await writer.local.put(Buffer.from('hello from another process'));
    await until(() => writer.local.index.replicas(cid)[0]?.state === 'verified');
    writer.close();
    expect(events).toContainEqual({ kind: 'replication', event: expect.objectContaining({ kind: 'uploaded', cid, remote: 'r2' }) });

    const { token } = await Access.load(root);
    const res = await fetch(`${r.url}/.well-known/rasl/${cid}`, { headers: { authorization: `Bearer ${token}` } });
    expect(await res.text()).toBe('hello from another process');
  });

  it('queues uploads interrupted by a crash again on start', async () => {
    const root = await tempDir();
    await withRemote(root);
    const before = await Porter.open({ root });
    const { cid } = await before.local.put(Buffer.from('interrupted'));
    before.local.index.claim('r2', 1);
    before.close();

    const { r, events } = await start(root);
    expect(events).toContainEqual({ kind: 'recovered', uploads: 1 });
    await until(() => r.porter.local.index.replicas(cid)[0]?.state === 'verified');
  });

  it('stops when idle, but not while uploads are waiting', async () => {
    const root = await tempDir();
    await withRemote(root);
    const writer = await Porter.open({ root });
    await writer.local.put(Buffer.from('waiting'));
    writer.close();

    fake.fail = () => 503;
    const { r, events } = await start(root, { idleExitMs: 50 });
    await until(() => events.some(e => e.kind === 'replication' && e.event.kind === 'remote-paused'));
    await sleep(200);
    expect(events.some(e => e.kind === 'stopping')).toBe(false);
    expect((await runningServe(root))?.pauses).toHaveProperty('r2');

    await r.stop();
    fake.fail = () => undefined;
    const idle = await start(await tempDir(), { idleExitMs: 50 });
    expect(await idle.r.done).toBe('idle');
    expect(idle.events.at(-1)).toEqual({ kind: 'stopping', reason: 'idle' });
  });
});

describe('porter serve', () => {
  const BIN = join(import.meta.dirname, '..', 'bin', 'porter.js');
  const env = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !['FORCE_COLOR', 'NO_COLOR'].includes(key)));

  function launch(args: string[]) {
    const child = spawn(process.execPath, [BIN, 'serve', '--port', '0', ...args], { env: env() });
    let stderr = '';
    child.stderr.on('data', chunk => (stderr += chunk));
    const exit = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
    return { child, exit, stderr: () => stderr };
  }

  it('stops cleanly on SIGTERM', async () => {
    const home = await tempDir();
    const { child, exit, stderr } = launch(['--home', home]);
    await until(async () => !!(await runningServe(home)));
    child.kill('SIGTERM');
    expect(await exit).toBe(0);
    expect(stderr()).toContain('Serving http://127.0.0.1:');
    expect(stderr()).toContain('Stopping');
    await expect(stat(join(home, 'porter-serve.lock'))).rejects.toThrow();
  });

  it('exits on its own with --idle-exit', async () => {
    const home = await tempDir();
    const { exit, stderr } = launch(['--home', home, '--idle-exit', '100ms', '--interval', '50ms']);
    expect(await exit).toBe(0);
    expect(stderr()).toContain('nothing to do');
  });

  it('shows in porter status while it runs', async () => {
    const home = await tempDir();
    const { child, exit } = launch(['--home', home]);
    await until(async () => !!(await runningServe(home)));
    const status = await new Promise<string>(resolve => {
      const s = spawn(process.execPath, [BIN, 'status', '--json', '--home', home], { env: env() });
      let out = '';
      s.stdout.on('data', c => (out += c));
      s.on('exit', () => resolve(out));
    });
    expect(JSON.parse(status).serving).toMatchObject({ pid: child.pid, url: expect.stringMatching(/^http:/) });
    child.kill('SIGTERM');
    await exit;
  });
});
