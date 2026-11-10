import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import { IntegrityError, PorterError } from './errors.js';
import { checkKey, chunks, type ByteRange, type ByteSource, type ByteStore, type PutHints } from './store.js';

export interface S3Options {
  /** e.g. `https://ACCOUNT.r2.cloudflarestorage.com` or `https://s3.us-east-1.amazonaws.com`. */
  endpoint: string;
  bucket: string;
  /** `auto` for R2. */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Prepended to every key, e.g. `blobs/`. Defaults to none. */
  prefix?: string;
  /** Uploads larger than this use multipart, in parts of this size. Defaults to 16 MiB; S3's minimum is 5 MiB. */
  partSize?: number;
  /** Retries of 5xx and 429 responses within one request. Defaults to 2; the replication queue retries the rest. */
  retries?: number;
}

/** A request to S3 failed. */
export class S3Error extends PorterError {
  constructor(
    message: string,
    readonly status: number,
    readonly s3Code: string | undefined,
    hint?: string,
  ) {
    super('s3', message, hint);
  }
}

const EMPTY_SHA256 = createHash('sha256').digest('hex');

/**
 * A `ByteStore` in an S3-compatible bucket (S3, R2, versitygw), with keys
 * as object names under `prefix`. Every request signs the SHA-256 of its
 * body, so the server rejects bytes that changed on the way. Pass
 * `hints.sha256` to `put` and that check covers the whole trip from the
 * caller's hash, not just the network.
 */
export class S3ByteStore implements ByteStore {
  readonly #client: AwsClient;
  readonly #base: string;
  readonly #prefix: string;
  readonly partSize: number;

  constructor(options: S3Options) {
    this.#client = new AwsClient({
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      service: 's3',
      region: options.region,
      retries: options.retries ?? 2,
    });
    this.#base = `${options.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(options.bucket)}`;
    this.#prefix = options.prefix ?? '';
    this.partSize = options.partSize ?? 16 * 1024 * 1024;
    if (this.partSize < 5 * 1024 * 1024) throw new RangeError('partSize must be at least 5 MiB');
  }

  async put(key: string, source: ByteSource, hints: PutHints = {}): Promise<void> {
    checkKey(key);
    // The source may be a stream of unknown length. Read up to two parts:
    // fewer than two means it fits in a single PUT.
    const parts = partsOf(source, this.partSize);
    const head = await take(parts, 2);
    if (head.length < 2) {
      const body = head[0] ?? new Uint8Array();
      const sha256 = hints.sha256 ? Buffer.from(hints.sha256).toString('hex') : sha256HexOf(body);
      // Store only if absent, in one round trip: 412 means it's already there.
      await this.#request('PUT', key, '', { body, sha256, headers: { 'if-none-match': '*' }, allow: [412] });
      return;
    }
    // Conditional completes aren't supported everywhere (R2), so check first.
    // One extra request is nothing next to a multipart upload.
    if ((await this.size(key)) !== undefined) return;
    await this.#multipart(key, head, parts, hints.sha256);
  }

  async read(key: string, range?: ByteRange): Promise<AsyncIterable<Uint8Array> | undefined> {
    checkKey(key);
    if (range?.end !== undefined && range.end <= range.start) {
      return (await this.size(key)) === undefined ? undefined : chunks(new Uint8Array());
    }
    const headers: Record<string, string> = {};
    if (range) headers.range = `bytes=${range.start}-${range.end === undefined ? '' : range.end - 1}`;
    const response = await this.#request('GET', key, '', { headers, allow: [404, 416] });
    if (response.status === 404) return undefined;
    // A range starting at or past the end has no bytes.
    if (response.status === 416) return chunks(new Uint8Array());
    return response.body ?? chunks(new Uint8Array());
  }

  async size(key: string): Promise<number | undefined> {
    checkKey(key);
    const response = await this.#request('HEAD', key, '', { allow: [404] });
    if (response.status === 404) return undefined;
    return Number(response.headers.get('content-length'));
  }

  async *keys(): AsyncIterable<string> {
    let token: string | undefined;
    do {
      const query = new URLSearchParams({ 'list-type': '2', prefix: this.#prefix });
      if (token) query.set('continuation-token', token);
      const xml = await (await this.#request('GET', '', `?${query}`)).text();
      for (const [, name] of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) {
        const key = decodeXml(name!).slice(this.#prefix.length);
        if (/^[a-z0-9]{8,}$/.test(key)) yield key;
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? decodeXml(xml.match(/<NextContinuationToken>([^<]*)</)?.[1] ?? '') : undefined;
    } while (token);
  }

  async #multipart(key: string, head: Uint8Array[], rest: AsyncIterator<Uint8Array>, expected: Uint8Array | undefined): Promise<void> {
    const created = await (await this.#request('POST', key, '?uploads')).text();
    const uploadId = decodeXml(created.match(/<UploadId>([^<]*)<\/UploadId>/)?.[1] ?? '');
    if (!uploadId) throw new S3Error('No upload ID in CreateMultipartUpload response', 200, undefined);
    const upload = `uploadId=${encodeURIComponent(uploadId)}`;
    const whole = createHash('sha256');
    const etags: string[] = [];
    try {
      const send = async (part: Uint8Array) => {
        whole.update(part);
        const response = await this.#request('PUT', key, `?partNumber=${etags.length + 1}&${upload}`, { body: part, sha256: sha256HexOf(part) });
        etags.push(response.headers.get('etag') ?? '');
      };
      for (const part of head) await send(part);
      for (let next = await rest.next(); !next.done; next = await rest.next()) await send(next.value);
      // Parts are only checked one by one, so check the whole before publishing it.
      if (expected && !whole.digest().equals(expected)) throw new IntegrityError(`Bytes for ${key} don't match their hash`, 'The local copy changed or is damaged.');
      const body = Buffer.from(
        `<CompleteMultipartUpload>${etags.map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`).join('')}</CompleteMultipartUpload>`,
      );
      const response = await this.#request('POST', key, `?${upload}`, { body, sha256: sha256HexOf(body) });
      // CompleteMultipartUpload can fail with a 200 and an error document.
      const text = await response.text();
      if (/<Error>/.test(text)) throw new S3Error(`Couldn't complete upload of ${key}`, 200, text.match(/<Code>([^<]*)</)?.[1]);
    } catch (error) {
      await this.#request('DELETE', key, `?${upload}`, { allow: [404] }).catch(() => {});
      throw error;
    }
  }

  async #request(
    method: string,
    key: string,
    query: string,
    options: { body?: Uint8Array; sha256?: string; headers?: Record<string, string>; allow?: number[] } = {},
  ): Promise<Response> {
    const url = `${this.#base}/${key ? encodeURIComponent(this.#prefix + key) : ''}${query}`;
    // aws4fetch sends UNSIGNED-PAYLOAD for S3 unless this header is set, which would leave the body unchecked.
    const headers = { ...options.headers, 'x-amz-content-sha256': options.sha256 ?? EMPTY_SHA256 };
    const response = await this.#client.fetch(url, { method, headers, body: options.body as Uint8Array<ArrayBuffer> | undefined });
    if (response.ok || options.allow?.includes(response.status)) return response;
    const text = method === 'HEAD' ? '' : await response.text();
    const code = text.match(/<Code>([^<]*)<\/Code>/)?.[1];
    if (code === 'XAmzContentSHA256Mismatch' || code === 'BadDigest') {
      throw new IntegrityError(`Bytes for ${key} don't match their hash`, 'The local copy changed or is damaged.');
    }
    throw new S3Error(`${method} ${key || this.#base} failed with ${response.status}${code ? ` ${code}` : ''}`, response.status, code, hintFor(response.status));
  }
}

function hintFor(status: number): string | undefined {
  if (status === 401 || status === 403) return "Check the remote's access key, secret, and bucket permissions.";
  if (status === 404) return "Check the remote's endpoint and bucket name.";
  if (status >= 500 || status === 429) return 'The provider is having trouble. Uploads retry on their own.';
  return undefined;
}

/** Regroup a source into parts of exactly `size` bytes, except the last. */
async function* partsOf(source: ByteSource, size: number): AsyncGenerator<Uint8Array> {
  let buffer = Buffer.allocUnsafe(size);
  let filled = 0;
  for await (const chunk of chunks(source)) {
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(size - filled, chunk.length - offset);
      buffer.set(chunk.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      if (filled === size) {
        yield buffer;
        buffer = Buffer.allocUnsafe(size);
        filled = 0;
      }
    }
  }
  if (filled > 0) yield buffer.subarray(0, filled);
}

/** The next `count` items of `items`, or fewer if it ends first. */
async function take<T>(items: AsyncIterator<T>, count: number): Promise<T[]> {
  const taken: T[] = [];
  while (taken.length < count) {
    const next = await items.next();
    if (next.done) break;
    taken.push(next.value);
  }
  return taken;
}

/** Hash `bytes` and return the SHA-256 as hex, as `x-amz-content-sha256` wants it. */
function sha256HexOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function decodeXml(text: string): string {
  return text.replace(/&(lt|gt|quot|apos|amp);/g, (_, name: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[name]!);
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, char => `&#${char.charCodeAt(0)};`);
}
