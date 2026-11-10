import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalStore, ensureServe, runningServe, serve } from '../src/index.js';
import { tempDir } from './helpers.js';

const run = promisify(execFile);
const BIN = join(import.meta.dirname, '..', 'bin', 'porter.js');
const started: number[] = [];
afterEach(async () => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
});

async function withBlob(root: string) {
  const local = new LocalStore({ root });
  const { cid } = await local.put(Buffer.from('hello world\n'));
  local.close();
  return cid;
}

describe('ensureServe', () => {
  it('starts porter serve in the background and hands out working URLs', async () => {
    const root = await tempDir();
    const cid = await withBlob(root);
    const client = await ensureServe({ root, port: 0 });
    started.push(client.pid);
    expect(client.started).toBe(true);
    expect(client.pid).not.toBe(process.pid);
    expect(await (await fetch(client.urlFor(cid))).text()).toBe('hello world\n');
  });

  it('reuses a server that is already running', async () => {
    const root = await tempDir();
    const first = await ensureServe({ root, port: 0 });
    started.push(first.pid);
    const second = await ensureServe({ root, port: 0 });
    expect(second).toMatchObject({ started: false, pid: first.pid, url: first.url });
  });

  it('ends up with one server when two callers race', async () => {
    const root = await tempDir();
    const [a, b] = await Promise.all([ensureServe({ root, port: 0 }), ensureServe({ root, port: 0 })]);
    started.push(a.pid, b.pid);
    expect(a.pid).toBe(b.pid);
    expect((await runningServe(root))?.pid).toBe(a.pid);
  });

  it('uses a server running in this process', async () => {
    const root = await tempDir();
    const cid = await withBlob(root);
    const running = await serve({ root, port: 0 });
    try {
      const client = await ensureServe({ root });
      expect(client).toMatchObject({ started: false, pid: process.pid, url: running.url });
      expect(await (await fetch(client.urlFor(cid))).text()).toBe('hello world\n');
    } finally {
      await running.stop();
    }
  });

  it('says where to look when porter serve fails to start', async () => {
    const root = await tempDir();
    const blocker = await serve({ root: await tempDir(), port: 0 });
    try {
      const error = await ensureServe({ root, port: Number(new URL(blocker.url).port) }).catch(e => e);
      expect(error).toMatchObject({ code: 'serve-failed', hint: expect.stringContaining('porter-serve.log') });
      expect(error.hint).toContain('in use');
    } finally {
      await blocker.stop();
    }
  });
});

describe('porter url', () => {
  it('prints a capability URL, starting a server if needed', async () => {
    const home = await tempDir();
    const cid = await withBlob(home);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'FORCE_COLOR'));
    const { stdout } = await run(process.execPath, [BIN, 'url', cid, '--port', '0', '--ttl', '5m', '--json', '--home', home], { env });
    const result = JSON.parse(stdout);
    const server = await runningServe(home);
    if (server) started.push(server.pid);
    expect(result).toMatchObject({ started: true, server: server?.url });
    expect(await (await fetch(result.url)).text()).toBe('hello world\n');
    const exp = Number(new URL(result.url).searchParams.get('exp'));
    expect(exp * 1000 - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);
  });
});
