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
import { Terminal } from './terminal.js';

const HELP = `Usage: porter COMMAND [flags]

Commands:
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
      },
    });
    const mode = values.color ?? 'auto';
    if (!['auto', 'always', 'never'].includes(mode)) throw usage(`Unknown color mode ${mode}`, 'Use auto, always, or never.');
    terminal.configure({ json: values.json, quiet: values.quiet, mode: mode as 'auto', home: values.home });
    command = positionals[0] === 'remote' && positionals[1] ? `remote ${positionals[1]}` : (positionals[0] ?? 'help');
    const rest = positionals.slice(command.split(' ').length);
    if (values.help || command === 'help') {
      terminal.result('help', { help: HELP }, () => [HELP.trimEnd()]);
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
      case 'status':
        want(0, '');
        return await withPorter(root, porter => status(porter, terminal));
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
        const credentials = new FileCredentialStore(root);
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
        await new FileCredentialStore(root).set(name, keys);
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
        await new FileCredentialStore(root).delete(rest[0]!);
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

function status(porter: Porter, terminal: Terminal): number {
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
  terminal.result('status', { root: porter.root, ...totals, remotes }, () => {
    const rows = remotes.flatMap(remote => [
      ...Object.entries(remote.states).map(([state, n]) => [remote.name, state, count(n.blobs), bytes(n.bytes)]),
      ...(remote.unqueued.blobs ? [[remote.name, 'not queued', count(remote.unqueued.blobs), bytes(remote.unqueued.bytes)]] : []),
    ]);
    return [
      terminal.summary('success', `Porter  ${tilde(porter.root)}`),
      ...terminal.card([['Blobs', `${count(totals.blobs)} (${bytes(totals.bytes)})`]]),
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

/** `2026-01-31` as the start of that day, local time. */
function parseDay(text: string, flag: string): number {
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const time = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime() : NaN;
  if (Number.isNaN(time)) throw usage(`Can't read ${flag} ${text}`, `Give ${flag} a day like 2026-01-31.`);
  return time;
}
