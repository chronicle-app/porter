import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DEFAULT_CAPABILITY_TTL_MS, type Access } from './access.js';
import { CidError, parseCid } from './cid.js';
import type { ReadThrough } from './read-through.js';
import type { ByteRange } from './store.js';

export interface RaslServerOptions {
  reader: ReadThrough;
  access: Access;
  /** Port on 127.0.0.1. Defaults to 0, any free port. */
  port?: number;
}

export interface RaslServer {
  /** e.g. `http://127.0.0.1:52341`. */
  readonly url: string;
  readonly server: Server;
  /** A URL that reads `cid` without the token until it expires, for players and `<img>`. */
  urlFor(cid: string, options?: { ttlMs?: number }): string;
  close(): Promise<void>;
}

const PATH = /^\/\.well-known\/rasl\/([^/]+)$/;

/**
 * Serve blobs over RASL (https://dasl.ing/rasl.html) on 127.0.0.1:
 * `GET` and `HEAD` at `/.well-known/rasl/<cid>`, with byte ranges. It's
 * read-only. Requests need the bearer token or a capability URL from
 * `urlFor`, and must name the server by its loopback address, which blocks
 * DNS rebinding. There are no CORS headers, so web pages can embed blobs
 * but their scripts can't read them.
 */
export async function serveRasl(options: RaslServerOptions): Promise<RaslServer> {
  const { reader, access } = options;
  let hosts = new Set<string>();
  const server = createServer((req, res) => {
    handle(req, res).catch(error => {
      if (!res.headersSent) respond(res, 500, 'Internal error');
      else res.destroy(error);
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hosts.has(req.headers.host ?? '')) return respond(res, 403, 'Unknown host');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = url.pathname.match(PATH);
    if (!match) return respond(res, 404, 'Not found');
    if (req.method !== 'GET' && req.method !== 'HEAD') return respond(res, 405, 'Method not allowed', { allow: 'GET, HEAD' });

    const cid = decodeURIComponent(match[1]!);
    try {
      parseCid(cid);
    } catch (error) {
      if (error instanceof CidError) return respond(res, 400, 'Not a DASL CID');
      throw error;
    }
    const authorized = access.allowsToken(req.headers.authorization) || access.allowsCapability(cid, url.searchParams.get('exp'), url.searchParams.get('cap'));
    if (!authorized) return respond(res, req.headers.authorization || url.searchParams.has('cap') ? 403 : 401, 'Not allowed');

    let size: number | undefined;
    try {
      size = await reader.size(cid);
    } catch {
      return respond(res, 502, 'Remote unavailable');
    }
    if (size === undefined) return respond(res, 404, 'Not found');

    const range = parseRange(req.headers.range, size);
    if (range === 'unsatisfiable') return respond(res, 416, 'Range not satisfiable', { 'content-range': `bytes */${size}` });
    const headers: Record<string, string> = {
      // RASL: the media type is always octet-stream; meaning lives elsewhere.
      'content-type': 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
      etag: `"${cid}"`,
      // A CID's bytes never change. Private, since URLs may carry a capability.
      'cache-control': 'private, max-age=31536000, immutable',
    };
    const length = range ? range.end - range.start : size;
    headers['content-length'] = String(length);
    if (range) headers['content-range'] = `bytes ${range.start}-${range.end - 1}/${size}`;
    const status = range ? 206 : 200;
    if (req.method === 'HEAD' || length === 0) {
      res.writeHead(status, headers).end();
      return;
    }

    let read;
    try {
      read = await reader.get(cid, range ?? undefined);
    } catch {
      return respond(res, 502, 'Remote unavailable');
    }
    if (!read) return respond(res, 404, 'Not found');
    // Send headers now: players start sooner, and a body cut short by a
    // failed check reads as a broken 200, not a dropped connection.
    res.writeHead(status, headers).flushHeaders();
    // A full read is checked once its last chunk has been read. Holding that
    // chunk back until then means a blob that fails the check arrives short
    // of its Content-Length, which clients treat as a broken transfer.
    const body = read.verified === 'full' ? holdingLast(read.stream) : read.stream;
    await pipeline(Readable.from(body), res).catch(() => {});
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    server,
    urlFor(cid, { ttlMs = DEFAULT_CAPABILITY_TTL_MS } = {}) {
      parseCid(cid);
      return access.urlFor(url, cid, ttlMs);
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

/** The same chunks, each passed on only once the next has arrived (or the stream ended cleanly). */
async function* holdingLast(stream: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  let held: Uint8Array | undefined;
  for await (const chunk of stream) {
    if (held) yield held;
    held = chunk;
  }
  if (held) yield held;
}

function respond(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers }).end(message + '\n');
}

/**
 * One byte range from a `Range` header, with an exclusive end; `null` to
 * serve the whole blob (no header, or one we don't handle, like several
 * ranges); `unsatisfiable` if it asks for bytes past the end.
 */
export function parseRange(header: string | undefined, size: number): (ByteRange & { end: number }) | null | 'unsatisfiable' {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start: number;
  let end: number;
  if (match[1] === '') {
    // Suffix: the last N bytes.
    const suffix = Number(match[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size : Math.min(Number(match[2]) + 1, size);
    if (match[2] !== '' && Number(match[2]) < start) return null;
  }
  if (start >= size) return 'unsatisfiable';
  return { start, end };
}
