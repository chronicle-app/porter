import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Access, DEFAULT_CAPABILITY_TTL_MS } from './access.js';
import { parseCid } from './cid.js';
import { PorterError } from './errors.js';
import { defaultRoot } from './files.js';
import { runningServe, type ServeInfo } from './serve.js';

export interface EnsureServeOptions {
  /** Porter's root. Defaults to the platform's application-data directory. */
  root?: string;
  /** Port for a server this starts. Defaults to `porter serve`'s own default. */
  port?: number;
  /** How long a server this starts waits, idle, before stopping. Defaults to 10 minutes. */
  idleExitMs?: number;
  /** How long to wait for a server this starts to come up. Defaults to 10 seconds. */
  timeoutMs?: number;
}

export interface ServeClient {
  /** The running server, e.g. `http://127.0.0.1:7413`. */
  readonly url: string;
  readonly pid: number;
  /** Whether this call started the server. */
  readonly started: boolean;
  /** A URL a player or `<img>` can load `cid` from without the token, until it expires. */
  urlFor(cid: string, options?: { ttlMs?: number }): string;
}

/**
 * The server for a root, started in the background if none is running.
 * One this starts runs `porter serve --idle-exit`, so it stops on its own
 * once nothing needs it, and logs to `porter-serve.log` in the root. If two
 * processes call this at once, both end up with the same server.
 */
export async function ensureServe(options: EnsureServeOptions = {}): Promise<ServeClient> {
  const root = options.root ?? defaultRoot();
  const access = await Access.load(root);
  const client = (info: ServeInfo, started: boolean): ServeClient => ({
    url: info.url,
    pid: info.pid,
    started,
    urlFor: (cid, { ttlMs = DEFAULT_CAPABILITY_TTL_MS } = {}) => {
      parseCid(cid);
      return access.urlFor(info.url, cid, ttlMs);
    },
  });

  const existing = await runningServe(root);
  if (existing) return client(existing, false);

  await mkdir(root, { recursive: true });
  const logPath = join(root, 'porter-serve.log');
  const log = await open(logPath, 'a');
  const args = [porterBin(), 'serve', '--home', root, '--idle-exit', `${options.idleExitMs ?? 10 * 60 * 1000}ms`];
  if (options.port !== undefined) args.push('--port', String(options.port));
  // The log is a file, so no color; FORCE_COLOR would override NO_COLOR.
  const { FORCE_COLOR: _, ...env } = process.env;
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...env, NO_COLOR: '1' } });
  let exited: number | null | undefined;
  child.on('exit', code => (exited = code));
  child.unref();
  await log.close();

  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    const info = await runningServe(root);
    if (info) return client(info, info.pid === child.pid);
    // Ours exiting is fine if it lost a race to another server that's still
    // starting: the lock is held by a live process. Keep waiting for that one.
    if (exited !== undefined && !(await lockHeld(root))) {
      throw new PorterError('serve-failed', "porter serve didn't start", `See ${logPath}: ${await lastError(logPath)}`);
    }
    await sleep(50);
  }
  child.kill();
  throw new PorterError('serve-failed', "porter serve didn't start in time", `See ${logPath}.`);
}

/** The `porter` bin beside this module, whether running from `dist/src` or `src`. */
function porterBin(): string {
  for (const relative of ['../../bin/porter.js', '../bin/porter.js']) {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(path)) return path;
  }
  throw new PorterError('serve-failed', "Can't find the porter command", 'Reinstall @chronicle.app/porter.');
}

/** The last error porter serve logged, without its timestamp. */
async function lastError(path: string): Promise<string> {
  const lines = (await readFile(path, 'utf8').catch(() => '')).trim().split('\n');
  const error = [...lines].reverse().find(line => line.includes('Error:')) ?? lines.at(-1);
  return error?.replace(/^.*?Error:\s*/, '').trim() || 'nothing logged';
}

/** Whether a live process holds the serve lock for `root`. */
async function lockHeld(root: string): Promise<boolean> {
  const pid = Number((await readFile(join(root, 'porter-serve.lock'), 'utf8').catch(() => '')).trim());
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
