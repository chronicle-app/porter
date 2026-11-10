import { readFile } from 'node:fs/promises';
import { CODEC_RAW, createSync, toString } from '@atcute/cid';

const HELP = `Usage: porter COMMAND

Commands:
  cid FILE    Print the DASL CID of a file

Coming next: serve, status, scan, remote.
`;

export async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === 'cid' && rest.length === 1) {
    process.stdout.write(toString(createSync(CODEC_RAW, await readFile(rest[0]!))) + '\n');
    return 0;
  }
  process.stderr.write(`Unknown command ${command}\n${HELP}`);
  return 2;
}
