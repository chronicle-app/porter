import { execFile } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { Porter } from '../src/index.js';
import { parseSize } from '../src/cli.js';
import { tempDir } from './helpers.js';

const run = promisify(execFile);
const BIN = join(import.meta.dirname, '..', 'bin', 'porter.js');
const KEYS = { PORTER_ACCESS_KEY_ID: 'test-id', PORTER_SECRET_ACCESS_KEY: 'test-secret' };

/** Run porter with no terminal and no forced color; never throws. */
async function porter(args: string[], env: Record<string, string> = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['FORCE_COLOR', 'NO_COLOR', 'PORTER_ACCESS_KEY_ID', 'PORTER_SECRET_ACCESS_KEY'].includes(key)));
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], { env: { ...clean, ...env } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}
async function json(args: string[], env?: Record<string, string>) {
  const result = await porter([...args, '--json'], env);
  return { ...result, data: JSON.parse(result.stdout) };
}

describe('porter CLI', () => {
  it('prints help', async () => {
    const { code, stdout } = await porter(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('porter COMMAND');
  });

  it.each([
    [['remote', 'add', '--help'], 'porter remote add NAME ENDPOINT'],
    [['help', 'remote', 'backfill'], '--max-size SIZE'],
    [['status', '-h'], 'Usage: porter status'],
  ])('prints help for one command: %j', async (args, expected) => {
    const { code, stdout } = await porter(args);
    expect(code).toBe(0);
    expect(stdout).toContain(expected);
    expect(stdout).not.toContain('Commands:');
  });

  it('refuses help for a command that does not exist', async () => {
    const { code, data } = await json(['help', 'bogus']);
    expect(code).toBe(2);
    expect(data.error.code).toBe('usage');
  });

  it('prints a file’s CID', async () => {
    const home = await tempDir();
    await writeFile(join(home, 'hello.txt'), 'hello world\n');
    const { data } = await json(['cid', join(home, 'hello.txt')]);
    expect(data).toMatchObject({ command: 'cid', cid: 'bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4' });
  });

  it('adds, lists, and removes a remote, keeping its keys apart', async () => {
    const home = await tempDir();
    const added = await json(['remote', 'add', 'r2', 'https://example.r2.cloudflarestorage.com', '--bucket', 'archive', '--home', home], KEYS);
    expect(added.code).toBe(0);
    expect(added.data.remote).toMatchObject({ name: 'r2', bucket: 'archive', region: 'auto', newBlobs: 'all' });

    const listed = await json(['remote', 'list', '--home', home]);
    expect(listed.data.remotes).toEqual([expect.objectContaining({ name: 'r2', keys: true })]);
    expect(await readFile(join(home, 'porter-config.json'), 'utf8')).not.toContain('test-secret');
    expect((await stat(join(process.env.CHRONICLE_CONFIG_DIR!, 'porter-credentials.json'))).mode & 0o777).toBe(0o600);

    expect((await json(['remote', 'remove', 'r2', '--home', home])).code).toBe(0);
    expect((await json(['remote', 'list', '--home', home])).data.remotes).toEqual([]);
    expect(await readFile(join(process.env.CHRONICLE_CONFIG_DIR!, 'porter-credentials.json'), 'utf8')).not.toContain('test-secret');
  });

  it('adds a remote that takes no new blobs', async () => {
    const home = await tempDir();
    const { data } = await json(['remote', 'add', 'cold', 'https://example.com', '--bucket', 'b', '--no-new', '--home', home], KEYS);
    expect(data.remote.newBlobs).toBe('none');
  });

  it('backfills only when asked, planning first', async () => {
    const home = await tempDir();
    const before = await Porter.open({ root: home });
    await before.local.put(Buffer.from('small'));
    await before.local.put(Buffer.alloc(2000, 1));
    before.close();

    const added = await json(['remote', 'add', 'r2', 'https://example.com', '--bucket', 'b', '--home', home], KEYS);
    expect(added.data.unqueued).toEqual({ blobs: 2, bytes: 2005 });

    const plan = await json(['remote', 'backfill', 'r2', '--plan', '--max-size', '1k', '--home', home]);
    expect(plan.data).toMatchObject({ plan: true, blobs: 1, bytes: 5 });
    const status = await json(['status', '--home', home]);
    expect(status.data.remotes[0].states).toEqual({});

    expect((await json(['remote', 'backfill', 'r2', '--home', home])).data).toMatchObject({ plan: false, blobs: 2, bytes: 2005 });
    const after = await json(['status', '--home', home]);
    expect(after.data).toMatchObject({ blobs: 2, bytes: 2005 });
    expect(after.data.remotes[0]).toMatchObject({ name: 'r2', keys: true, states: { pending: { blobs: 2, bytes: 2005 } }, unqueued: { blobs: 0 } });
  });

  it.each([
    ['an unknown command', ['bogus'], 2, 'usage', 'porter --help'],
    ['a missing argument', ['remote', 'add', 'r2'], 2, 'usage', 'porter remote add --help'],
    ['a bad size', ['remote', 'backfill', 'r2', '--max-size', 'huge'], 2, 'usage', undefined],
    ['an unknown remote', ['retry', 'nowhere'], 1, 'unknown-remote', 'porter remote list'],
  ])('reports %s with its code and a next step', async (_, args, exitCode, code, command) => {
    const home = await tempDir();
    const { code: exit, data } = await json([...args, '--home', home]);
    expect(exit).toBe(exitCode);
    expect(data.error).toMatchObject({ code, exitCode });
    if (command) expect(data.error.hint).toContain(command);
  });

  it('refuses to add a remote without keys when it can’t ask', async () => {
    const home = await tempDir();
    const { code, data } = await json(['remote', 'add', 'r2', 'https://example.com', '--bucket', 'b', '--home', home]);
    expect(code).toBe(1);
    expect(data.error).toMatchObject({ code: 'keys-missing', hint: expect.stringContaining('PORTER_ACCESS_KEY_ID') });
    expect((await json(['remote', 'list', '--home', home])).data.remotes).toEqual([]);
  });

  it('refuses a duplicate remote, pointing at remove', async () => {
    const home = await tempDir();
    await json(['remote', 'add', 'r2', 'https://example.com', '--bucket', 'b', '--home', home], KEYS);
    const { data } = await json(['remote', 'add', 'r2', 'https://example.com', '--bucket', 'b', '--home', home], KEYS);
    expect(data.error).toMatchObject({ code: 'remote-exists', hint: expect.stringContaining('porter remote remove r2') });
  });

  it('prints no escape codes or SQLite warnings into a pipe', async () => {
    const home = await tempDir();
    await json(['remote', 'add', 'r2', 'https://example.com', '--bucket', 'b', '--home', home], KEYS);
    for (const args of [['status'], ['remote', 'list'], ['bogus']]) {
      const { stdout, stderr } = await porter([...args, '--home', home]);
      expect(stdout + stderr).not.toMatch(/\x1b\[/);
      expect(stderr).not.toContain('ExperimentalWarning');
    }
  });
});

describe('parseSize', () => {
  it.each([
    ['500', 500],
    ['1k', 1000],
    ['50MB', 50_000_000],
    ['1.5GB', 1_500_000_000],
    ['2 tb', 2_000_000_000_000],
  ])('reads %s', (text, expected) => {
    expect(parseSize(text)).toBe(expected);
  });
});
