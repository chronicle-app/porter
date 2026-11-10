import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { CODEC_RAW, createSync, toString } from '@atcute/cid';
import { PorterConfig, type RemoteConfig } from './config.js';
import { FileCredentialStore, type RemoteCredentials } from './credentials.js';
import { PorterError } from './errors.js';
import { defaultRoot } from './files.js';
import { bytes, count, tilde } from './output/index.js';
import { Porter } from './porter.js';
import { DEFAULT_PORT, runningServe, serve, type ServeEvent } from './serve.js';
import { ensureServe } from './ensure.js';
import { parseCid } from './cid.js';
import { Terminal } from './terminal.js';

const HELP = `Usage: porter COMMAND [flags]

Commands:
  serve [--port PORT] [--idle-exit TIME]
                                Serve blobs on localhost and upload them to remotes
  url CID [--ttl TIME]          A URL that reads one blob, starting porter serve if needed
  status                        Blobs, and where each remote stands
  scan                          Record files the index doesn't know, and report missing ones
  retry [REMOTE]                Queue blobs that failed to upload again
  remote list                   Show remotes
  remote add NAME ENDPOINT --bucket BUCKET [--region REGION] [--prefix PREFIX] [--no-new]
                                Add an S3-compatible remote; prompts for its keys
  remote remove NAME            Stop using a remote; its bucket is left as it is
  remote backfill NAME [--plan] [--max-size SIZE] [--since DAY] [--until DAY]
                                Queue existing blobs for a remote
  cid FILE                      Print a file's DASL CID

Flags:
  --home DIR      Porter's directory (default: ${tilde(defaultRoot())})
  --json          One JSON result on stdout
  --quiet, -q     Hide routine messages
  --color MODE    auto, always, or never
  --help, -h      Show this help

remote add reads keys from PORTER_ACCESS_KEY_ID and PORTER_SECRET_ACCESS_KEY
when they're set, and otherwise asks for them. Keys are never taken as flags.
`;

const FLAGS_NOTE = 'Global flags: --home DIR, --json, --quiet, --color MODE. Run `porter --help` for all commands.';

/** Help for each command: how to call it, then what it does. */
const COMMAND_HELP: Record<string, string> = {
  serve: `Usage: porter serve [--port PORT] [--idle-exit TIME] [--interval TIME]

Serves blobs over RASL at http://127.0.0.1:PORT/.well-known/rasl/CID and
uploads new blobs to remotes, until stopped with Ctrl-C. Only one runs per
directory.

  --port PORT       Defaults to ${DEFAULT_PORT}; capability URLs carry it, so keep it fixed
  --idle-exit TIME  Stop after this long with no requests or uploads, like 10m
  --interval TIME   How often to look for blobs to upload. Defaults to 30s`,
  url: `Usage: porter url CID [--ttl TIME]

Prints a URL that reads one blob from porter serve without the token, for a
video player or an <img>. It works until it expires, 12h by default. If
porter serve isn't running, it's started in the background and stops once
idle for 10 minutes.

  --ttl TIME   How long the URL works, like 30m or 24h`,
  status: `Usage: porter status

Shows how many blobs Porter holds, and for each remote how many are
verified, pending, uploading, failed, or not queued at all.`,
  scan: `Usage: porter scan

Records files in Porter's directory that the index doesn't know, queueing
them for remotes that take new blobs, and lists index entries whose file is
gone. Blobs already recorded are never queued for more remotes.`,
  retry: `Usage: porter retry [REMOTE]

Queues blobs that gave up uploading again, for one remote or all of them.`,
  'remote list': `Usage: porter remote list

Shows each remote, whether new blobs go to it, and whether its keys are stored.`,
  'remote add': `Usage: porter remote add NAME ENDPOINT --bucket BUCKET [--region REGION] [--prefix PREFIX] [--no-new]

Adds an S3-compatible remote, such as Cloudflare R2. New blobs go to it
unless --no-new is given. Blobs you already have don't; copy them with
porter remote backfill.

  --bucket BUCKET   The bucket to write to
  --region REGION   Defaults to auto, which R2 uses
  --prefix PREFIX   Put every object under this prefix, like blobs/
  --no-new          Don't send new blobs here

Keys come from PORTER_ACCESS_KEY_ID and PORTER_SECRET_ACCESS_KEY when set;
otherwise porter asks for them. They're never taken as flags, so they stay
out of shell history.`,
  'remote remove': `Usage: porter remote remove NAME

Stops using a remote and forgets its keys. Nothing in its bucket is deleted,
and its upload history stays in the index.`,
  'remote backfill': `Usage: porter remote backfill NAME [--plan] [--max-size SIZE] [--since DAY] [--until DAY]

Queues blobs you already have for a remote. This can mean a lot of data, so
run it with --plan first to see how many blobs and bytes it would send.

  --plan            Count, without queueing anything
  --max-size SIZE   Only blobs up to this size, like 50MB
  --since DAY       Only blobs added on or after this day, like 2026-01-31
  --until DAY       Only blobs added before this day`,
  remote: `Usage: porter remote list | add | remove | backfill

  remote list                 Show remotes
  remote add NAME ENDPOINT    Add an S3-compatible remote
  remote remove NAME          Stop using a remote
  remote backfill NAME        Queue blobs you already have for a remote

Run \`porter remote add --help\` and so on for each one's flags.`,
  cid: `Usage: porter cid FILE

Prints the file's DASL CID, the name Porter stores it under.`,
};

const usage = (message: string, hint = 'Run `porter --help` to see the commands.') => new PorterError('usage', message, hint);

export async function main(args: string[], terminal = new Terminal()): Promise<number> {
  let command = args[0] ?? 'help';
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        home: { type: 'string' },
        json: { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        color: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        bucket: { type: 'string' },
        region: { type: 'string' },
        prefix: { type: 'string' },
        'no-new': { type: 'boolean' },
        plan: { type: 'boolean' },
        'max-size': { type: 'string' },
        since: { type: 'string' },
        until: { type: 'string' },
        port: { type: 'string' },
        'idle-exit': { type: 'string' },
        interval: { type: 'string' },
        ttl: { type: 'string' },
      },
    });
    const mode = values.color ?? 'auto';
    if (!['auto', 'always', 'never'].includes(mode)) throw usage(`Unknown color mode ${mode}`, 'Use auto, always, or never.');
    terminal.configure({ json: values.json, quiet: values.quiet, mode: mode as 'auto', home: values.home });
    command = positionals[0] === 'remote' && positionals[1] ? `remote ${positionals[1]}` : (positionals[0] ?? 'help');
    const rest = positionals.slice(command.split(' ').length);
    if (values.help || command === 'help') {
      // `porter help remote add` asks about the command after `help`.
      const topic = command === 'help' ? rest.join(' ') : command;
      const text = COMMAND_HELP[topic] ? `${COMMAND_HELP[topic]}\n\n${FLAGS_NOTE}\n` : HELP;
      if (topic && topic !== 'help' && !COMMAND_HELP[topic]) throw usage(`Unknown command ${topic}`);
      terminal.result('help', { help: text }, () => [text.trimEnd()]);
      return 0;
    }
    const root = values.home ?? defaultRoot();
    const want = (n: number, shape: string) => {
      if (rest.length !== n) throw usage(rest.length < n ? `porter ${command} needs ${shape}` : `Too many arguments for porter ${command}`, `Run \`porter ${command} --help\` for its usage.`);
    };

    switch (command) {
      case 'cid': {
        want(1, 'a FILE');
        const cid = toString(createSync(CODEC_RAW, await readFile(rest[0]!)));
        terminal.result(command, { cid }, () => [cid]);
        return 0;
      }
      case 'serve': {
        want(0, '');
        const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw usage(`Can't read port ${values.port}`, 'Give --port a number from 1 to 65535.');
        const idleExitMs = values['idle-exit'] === undefined ? undefined : parseDuration(values['idle-exit'], '--idle-exit');
        const intervalMs = values.interval === undefined ? undefined : parseDuration(values.interval, '--interval');
        // Catch signals before starting: one that arrives while the server is
        // starting must still stop it cleanly, not kill it holding the lock.
        let stopRequested = false;
        let running: Awaited<ReturnType<typeof serve>> | undefined;
        const stop = () => {
          stopRequested = true;
          void running?.stop();
        };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
        try {
          running = await serve({ root, port, idleExitMs, intervalMs, onEvent: event => report(terminal, event) });
          if (stopRequested) void running.stop();
          const reason = await running.done;
          terminal.result(command, { stopped: reason }, () => []);
        } finally {
          process.off('SIGINT', stop);
          process.off('SIGTERM', stop);
        }
        return 0;
      }
      case 'url': {
        want(1, 'a CID');
        parseCid(rest[0]!);
        const ttlMs = values.ttl === undefined ? undefined : parseDuration(values.ttl, '--ttl');
        const client = await ensureServe({ root, ...(values.port !== undefined && { port: Number(values.port) }) });
        const url = client.urlFor(rest[0]!, { ttlMs });
        if (client.started) terminal.notice(`Started porter serve at ${client.url}`);
        terminal.result(command, { url, server: client.url, started: client.started }, () => [url]);
        return 0;
      }
      case 'status': {
        want(0, '');
        const serving = await runningServe(root);
        return await withPorter(root, porter => status(porter, terminal, serving));
      }
      case 'scan': {
        want(0, '');
        const started = Date.now();
        return await withPorter(root, async porter => {
          const result = await porter.local.scan();
          terminal.result(command, { ...result }, () => [
            terminal.summary(result.missing.length ? 'warning' : 'success', `Scanned ${tilde(porter.root)}`, Date.now() - started),
            ...terminal.card([
              ['Added', count(result.added)],
              ['Missing', count(result.missing.length)],
            ]),
            ...result.missing.map(cid => terminal.line(`    ${cid}`)),
          ]);
          return 0;
        });
      }
      case 'retry': {
        if (rest.length > 1) want(1, 'at most one REMOTE');
        return await withPorter(root, async porter => {
          if (rest[0] && !porter.config.remote(rest[0])) throw unknownRemote(rest[0]);
          const queued = porter.local.index.retryFailed(rest[0]);
          terminal.result(command, { queued }, () => [terminal.summary('success', `Queued ${count(queued)} failed ${queued === 1 ? 'blob' : 'blobs'} again`)]);
          return 0;
        });
      }
      case 'remote list': {
        want(0, '');
        const config = await PorterConfig.load(root);
        const credentials = new FileCredentialStore();
        const remotes = await Promise.all(config.remotes.map(async remote => ({ ...remote, keys: !!(await credentials.get(remote.name)) })));
        terminal.result(command, { remotes }, () =>
          remotes.length
            ? terminal.table(
                ['Remote', 'New blobs', 'Keys', 'Bucket', 'Endpoint'],
                remotes.map(r => [r.name, r.newBlobs, r.keys ? 'stored' : 'missing', r.bucket + (r.prefix ? `/${r.prefix}` : ''), r.endpoint]),
              )
            : [terminal.line('No remotes'), ...terminal.hint('Add one with `porter remote add NAME ENDPOINT --bucket BUCKET`.')],
        );
        return 0;
      }
      case 'remote add': {
        want(2, 'a NAME and an ENDPOINT');
        if (!values.bucket) throw usage('porter remote add needs --bucket', 'Run `porter remote add --help` for its usage.');
        const [name, endpoint] = rest as [string, string];
        const config = await PorterConfig.load(root);
        const remote: RemoteConfig = { name, endpoint, bucket: values.bucket, region: values.region ?? 'auto', newBlobs: values['no-new'] ? 'none' : 'all', ...(values.prefix && { prefix: values.prefix }) };
        config.addRemote(remote);
        const keys = await readKeys(terminal);
        await new FileCredentialStore().set(name, keys);
        await config.save();
        return await withPorter(root, porter => {
          const unqueued = porter.local.index.unqueued(name);
          terminal.result(command, { remote, unqueued }, () => [
            terminal.summary('success', `Remote ${name} added`),
            ...terminal.card([
              ['New blobs', remote.newBlobs === 'all' ? `go to ${name}` : `don't go to ${name}`],
              ['Existing', `${count(unqueued.blobs)} blobs (${bytes(unqueued.bytes)}) not on ${name}`],
            ]),
            ...(unqueued.blobs ? terminal.hint(`To copy them too, run \`porter remote backfill ${name} --plan\` first.`) : []),
          ]);
          return 0;
        });
      }
      case 'remote remove': {
        want(1, 'a NAME');
        const config = await PorterConfig.load(root);
        config.removeRemote(rest[0]!);
        await config.save();
        await new FileCredentialStore().delete(rest[0]!);
        terminal.result(command, { removed: rest[0] }, () => [
          terminal.summary('success', `Remote ${rest[0]} removed`),
          ...terminal.hint('Nothing in its bucket was deleted. Its upload history stays in the index.'),
        ]);
        return 0;
      }
      case 'remote backfill': {
        want(1, 'a NAME');
        const name = rest[0]!;
        const filter = {
          maxSize: values['max-size'] === undefined ? undefined : parseSize(values['max-size']),
          addedSince: values.since === undefined ? undefined : parseDay(values.since, '--since'),
          addedBefore: values.until === undefined ? undefined : parseDay(values.until, '--until'),
        };
        return await withPorter(root, porter => {
          if (!porter.config.remote(name)) throw unknownRemote(name);
          const result = porter.local.index.backfill(name, filter, { plan: values.plan });
          const what = `${count(result.blobs)} ${result.blobs === 1 ? 'blob' : 'blobs'} (${bytes(result.bytes)})`;
          terminal.result(command, { remote: name, plan: !!values.plan, ...result }, () =>
            values.plan
              ? [terminal.summary('success', `Would queue ${what} for ${name}`), ...(result.blobs ? terminal.hint(`Run it without --plan to queue them.`) : [])]
              : [terminal.summary('success', `Queued ${what} for ${name}`)],
          );
          return 0;
        });
      }
      default:
        throw usage(`Unknown command ${command}`);
    }
  } catch (error) {
    return terminal.error(command, error);
  }
}

async function withPorter<T>(root: string, fn: (porter: Porter) => Promise<T> | T): Promise<T> {
  const porter = await Porter.open({ root });
  try {
    return await fn(porter);
  } finally {
    porter.close();
  }
}

/** Say what a running server is doing, as log lines on stderr. */
function report(terminal: Terminal, event: ServeEvent): void {
  if (event.kind === 'started') terminal.notice(`Serving ${event.url}`);
  else if (event.kind === 'recovered') terminal.notice(`Queued ${count(event.uploads)} interrupted ${event.uploads === 1 ? 'upload' : 'uploads'} again`);
  else if (event.kind === 'stopping') terminal.notice(event.reason === 'idle' ? 'Stopping, nothing to do' : 'Stopping');
  else {
    const e = event.event;
    if (e.kind === 'uploaded') terminal.notice(`Uploaded ${e.cid} to ${e.remote} (${bytes(e.size)})`);
    else if (e.kind === 'remote-paused') terminal.warn(`Remote ${e.remote} isn't reachable: ${e.error.message}`, `Uploads to it pause until ${new Date(e.until).toLocaleTimeString()}.`);
    else if (e.gaveUp) terminal.warn(`Gave up uploading ${e.cid} to ${e.remote}: ${e.error.message}`, `Run \`porter retry ${e.remote}\` once it's fixed.`);
    else terminal.warn(`Couldn't upload ${e.cid} to ${e.remote}: ${e.error.message}`, 'It will be tried again.');
  }
}

function status(porter: Porter, terminal: Terminal, serving?: { pid: number; url: string; pauses: Record<string, number> }): number {
  const index = porter.local.index;
  const totals = index.totals();
  const counts = index.counts();
  const remotes = porter.config.remotes.map(remote => ({
    name: remote.name,
    newBlobs: remote.newBlobs,
    keys: !porter.missingCredentials.includes(remote.name),
    states: Object.fromEntries(counts.filter(c => c.tier === remote.name).map(c => [c.state, { blobs: c.blobs, bytes: c.bytes }])),
    unqueued: index.unqueued(remote.name),
  }));
  terminal.result('status', { root: porter.root, ...totals, serving: serving ?? null, remotes }, () => {
    const rows = remotes.flatMap(remote => [
      ...Object.entries(remote.states).map(([state, n]) => [remote.name, state, count(n.blobs), bytes(n.bytes)]),
      ...(remote.unqueued.blobs ? [[remote.name, 'not queued', count(remote.unqueued.blobs), bytes(remote.unqueued.bytes)]] : []),
    ]);
    return [
      terminal.summary('success', `Porter  ${tilde(porter.root)}`),
      ...terminal.card([
        ['Blobs', `${count(totals.blobs)} (${bytes(totals.bytes)})`],
        ['Serving', serving ? `${serving.url} (pid ${serving.pid})` : 'no'],
        ...Object.entries(serving?.pauses ?? {}).map(([name, until]) => ['Paused', `${name} until ${new Date(until).toLocaleTimeString()}`] as [string, string]),
      ]),
      ...(rows.length ? ['', ...terminal.table(['Remote', 'State', 'Blobs', 'Size'], rows, [false, false, true, true])] : []),
    ];
  });
  for (const name of porter.missingCredentials) terminal.warn(`No keys stored for remote ${name}`, `Run \`porter remote remove ${name}\`, then add it again with its keys.`);
  if (remotes.some(r => r.states.failed)) terminal.warn('Some blobs failed to upload', 'Run `porter retry` to queue them again.');
  return 0;
}

function unknownRemote(name: string): PorterError {
  return new PorterError('unknown-remote', `No remote named ${name}`, 'Run `porter remote list` to see them.');
}

async function readKeys(terminal: Terminal): Promise<RemoteCredentials> {
  const fromEnv = { accessKeyId: process.env.PORTER_ACCESS_KEY_ID, secretAccessKey: process.env.PORTER_SECRET_ACCESS_KEY };
  if (fromEnv.accessKeyId && fromEnv.secretAccessKey) return fromEnv as RemoteCredentials;
  if (!process.stdin.isTTY || terminal.json) {
    throw new PorterError('keys-missing', 'No keys for the remote', 'Set PORTER_ACCESS_KEY_ID and PORTER_SECRET_ACCESS_KEY, or run it at a terminal to be asked.');
  }
  const accessKeyId = await ask('Access key ID: ');
  const secretAccessKey = await ask('Secret access key: ', true);
  if (!accessKeyId || !secretAccessKey) throw new PorterError('keys-missing', 'No keys for the remote', 'Enter both the access key ID and the secret.');
  return { accessKeyId, secretAccessKey };
}

async function ask(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  if (hidden) {
    // Echo nothing while the secret is typed.
    (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = text => {
      if (text.startsWith(question)) process.stderr.write(question);
    };
  }
  try {
    return (await rl.question(question)).trim();
  } finally {
    if (hidden) process.stderr.write('\n');
    rl.close();
  }
}

/** `50MB`, `1.5GB`, `200k`, or a plain number of bytes. */
export function parseSize(text: string): number {
  const match = text.trim().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i);
  if (!match) throw usage(`Can't read size ${text}`, 'Use a number of bytes, or one like 50MB or 1.5GB.');
  const power = ' kmgt'.indexOf((match[2] || ' ').toLowerCase());
  return Math.floor(Number(match[1]) * 1000 ** power);
}

/** `30s`, `10m`, `2h`, or a plain number of seconds, in milliseconds. */
export function parseDuration(text: string, flag: string): number {
  const match = text.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
  if (!match) throw usage(`Can't read ${flag} ${text}`, `Give ${flag} a time like 30s, 10m, or 2h.`);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] ?? 's']!;
  return Math.round(Number(match[1]) * unit);
}

/** `2026-01-31` as the start of that day, local time. */
function parseDay(text: string, flag: string): number {
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const time = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime() : NaN;
  if (Number.isNaN(time)) throw usage(`Can't read ${flag} ${text}`, `Give ${flag} a day like 2026-01-31.`);
  return time;
}
