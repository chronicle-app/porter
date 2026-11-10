import { open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Access } from './access.js';
import { PorterError } from './errors.js';
import { defaultRoot, readJson, writeJson } from './files.js';
import { Porter } from './porter.js';
import type { ReplicationEvent } from './replicate.js';
import { serveRasl, type RaslServer } from './server.js';

/** Port `porter serve` listens on unless told otherwise. Fixed, so capability URLs survive restarts. */
export const DEFAULT_PORT = 7413;

export interface ServeOptions {
  /** Porter's root. Defaults to the platform's application-data directory. */
  root?: string;
  /** Port on 127.0.0.1. Defaults to `DEFAULT_PORT`; 0 picks any free port. */
  port?: number;
  /** How often to look for blobs to upload. Defaults to 30 seconds. */
  intervalMs?: number;
  /**
   * Stop after this long with no requests and no uploads waiting. Leave it
   * out to run until stopped.
   */
  idleExitMs?: number;
  /** How long `stop` waits for uploads under way. Defaults to 10 seconds. */
  graceMs?: number;
  onEvent?: (event: ServeEvent) => void;
}

export type ServeEvent =
  | { kind: 'started'; url: string; pid: number }
  | { kind: 'recovered'; uploads: number }
  | { kind: 'replication'; event: ReplicationEvent }
  | { kind: 'stopping'; reason: StopReason };

export type StopReason = 'stopped' | 'idle';

/** What `porter-serve.json` says about the server running for a root. */
export interface ServeInfo {
  pid: number;
  url: string;
  startedAt: number;
  /** Remotes paused when last written, and until when (milliseconds since the epoch). */
  pauses: Record<string, number>;
}

export interface RunningServe {
  readonly url: string;
  readonly porter: Porter;
  readonly server: RaslServer;
  /** Settles once the server has stopped, with why. */
  readonly done: Promise<StopReason>;
  /** Stop: finish or abandon uploads under way, close the server, release the lock. */
  stop(): Promise<StopReason>;
}

/**
 * Run Porter for a root: serve blobs over RASL and replicate them to
 * remotes on an interval. Only one runs per root, guarded by
 * `porter-serve.lock`; `porter-serve.json` tells other processes where to
 * find it while it runs.
 */
export async function serve(options: ServeOptions = {}): Promise<RunningServe> {
  const root = options.root ?? defaultRoot();
  const emit = options.onEvent ?? (() => {});
  const porter = await Porter.open({ root });
  const lock = await acquireLock(root).catch(error => {
    porter.close();
    throw error;
  });

  let server: RaslServer;
  try {
    server = await serveRasl({ reader: porter.reader(), access: await Access.load(root), port: options.port ?? DEFAULT_PORT });
  } catch (error) {
    await lock.release();
    porter.close();
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new PorterError('port-in-use', `Port ${options.port ?? DEFAULT_PORT} is in use`, 'Pass `--port` with another port.');
    }
    throw error;
  }

  const replicator = porter.replicator({ onEvent: event => emit({ kind: 'replication', event }) });
  const recovered = replicator.recover();
  if (recovered) emit({ kind: 'recovered', uploads: recovered });

  const infoPath = join(root, 'porter-serve.json');
  const startedAt = Date.now();
  const writeInfo = () => writeJson(infoPath, { pid: process.pid, url: server.url, startedAt, pauses: replicator.pauses() } satisfies ServeInfo);
  await writeInfo();
  emit({ kind: 'started', url: server.url, pid: process.pid });

  let lastActivity = Date.now();
  server.server.on('request', () => (lastActivity = Date.now()));

  /** The pass under way, including writing what it learned to porter-serve.json. */
  let ticking: Promise<void> | undefined;
  let stopping: Promise<StopReason> | undefined;
  let resolveDone!: (reason: StopReason) => void;
  const done = new Promise<StopReason>(resolve => (resolveDone = resolve));

  const pass = async () => {
    try {
      const summary = await replicator.runOnce();
      if (summary.uploaded || summary.failed) lastActivity = Date.now();
      if (!stopping) await writeInfo();
    } catch {
      // A failed pass leaves its replicas queued; the next one retries.
    }
    if (!stopping && options.idleExitMs !== undefined && Date.now() - lastActivity >= options.idleExitMs && !hasWork(porter)) void stop('idle');
  };
  const tick = () => {
    if (ticking || stopping) return;
    ticking = pass().finally(() => (ticking = undefined));
  };
  const timer = setInterval(tick, options.intervalMs ?? 30_000);
  tick();

  const stop = (reason: StopReason = 'stopped'): Promise<StopReason> => {
    stopping ??= (async () => {
      emit({ kind: 'stopping', reason });
      clearInterval(timer);
      replicator.stop();
      // Uploads cut off here go back to the queue on the next start.
      if (ticking) await Promise.race([ticking, sleep(options.graceMs ?? 10_000)]);
      await server.close();
      await rm(infoPath, { force: true });
      await lock.release();
      porter.close();
      resolveDone(reason);
      return reason;
    })();
    return stopping;
  };

  return { url: server.url, porter, server, done, stop: () => stop('stopped') };
}

/** The server running for `root`, if there is one. */
export async function runningServe(root = defaultRoot()): Promise<ServeInfo | undefined> {
  const info = (await readJson(join(root, 'porter-serve.json'))) as ServeInfo | undefined;
  return info && alive(info.pid) ? info : undefined;
}

/** Uploads waiting or under way for a remote this server can reach (one without keys never drains). */
function hasWork(porter: Porter): boolean {
  const reachable = new Set(porter.remotes.map(r => r.name));
  return porter.local.index.counts().some(c => reachable.has(c.tier) && (c.state === 'pending' || c.state === 'uploading'));
}

async function acquireLock(root: string): Promise<{ release: () => Promise<void> }> {
  const path = join(root, 'porter-serve.lock');
  const mine = String(process.pid);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const file = await open(path, 'wx', 0o644);
      await file.writeFile(mine);
      await file.close();
      return {
        release: async () => {
          // Only remove the lock if it's still ours.
          if ((await readFile(path, 'utf8').catch(() => '')).trim() === mine) await rm(path, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = Number((await readFile(path, 'utf8').catch(() => '')).trim());
    if (holder && alive(holder)) {
      const info = await runningServe(root);
      throw new PorterError('already-serving', `Porter is already serving this directory (pid ${holder})`, info ? `It's at ${info.url}.` : 'Stop that process first.');
    }
    // Left by a process that died; take it over.
    await rm(path, { force: true });
  }
  throw new PorterError('lock-contended', "Couldn't take the serve lock", 'Another porter serve is starting. Try again.');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms).unref());
