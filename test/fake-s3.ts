import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Just enough of the S3 API for S3ByteStore's tests, in memory. Like real
 * servers, it rejects bodies that don't match `x-amz-content-sha256`; unlike
 * them, it also rejects unsigned payloads, so a missing header fails tests.
 * It doesn't check signatures.
 */
export class FakeS3 {
  readonly objects = new Map<string, Buffer>();
  readonly requests: { method: string; path: string; sha256: string | undefined }[] = [];
  /** Return a status to fail the matching request instead of serving it. */
  fail: (method: string, path: string) => number | undefined = () => undefined;
  #uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  #server: Server | undefined;
  readonly bucket = 'test-bucket';

  async start(): Promise<string> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>(resolve => this.#server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise(resolve => this.#server?.close(resolve));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url!, 'http://fake');
    const body = Buffer.concat(await req.toArray());
    const sha256 = req.headers['x-amz-content-sha256'] as string | undefined;
    this.requests.push({ method: req.method!, path: url.pathname + url.search, sha256 });
    const send = (status: number, text = '', headers: Record<string, string> = {}) => {
      res.writeHead(status, headers).end(text);
    };
    const error = (status: number, code: string) => send(status, `<Error><Code>${code}</Code></Error>`);

    const injected = this.fail(req.method!, url.pathname + url.search);
    if (injected) return error(injected, 'Injected');
    if (!req.headers.authorization) return error(403, 'AccessDenied');
    if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) return error(400, 'UnsignedPayloadRejectedByFake');
    if (createHash('sha256').update(body).digest('hex') !== sha256) return error(400, 'XAmzContentSHA256Mismatch');

    const [, bucket, ...rest] = url.pathname.split('/');
    if (bucket !== this.bucket) return error(404, 'NoSuchBucket');
    const key = decodeURIComponent(rest.join('/'));
    const q = url.searchParams;

    if (!key && req.method === 'GET') {
      const prefix = q.get('prefix') ?? '';
      const keys = [...this.objects.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = Number(q.get('continuation-token') ?? 0);
      const page = keys.slice(start, start + 2);
      const more = start + 2 < keys.length;
      return send(
        200,
        `<ListBucketResult>${page.map(k => `<Contents><Key>${k}</Key></Contents>`).join('')}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ''}</ListBucketResult>`,
      );
    }
    if (req.method === 'POST' && q.has('uploads')) {
      const id = randomUUID();
      this.#uploads.set(id, { key, parts: new Map() });
      return send(200, `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    }
    const upload = q.get('uploadId') ? this.#uploads.get(q.get('uploadId')!) : undefined;
    if (q.has('uploadId') && !upload) return error(404, 'NoSuchUpload');
    if (req.method === 'PUT' && upload) {
      upload.parts.set(Number(q.get('partNumber')), body);
      return send(200, '', { etag: `"part-${q.get('partNumber')}"` });
    }
    if (req.method === 'POST' && upload) {
      const numbers = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map(m => Number(m[1]));
      this.objects.set(upload.key, Buffer.concat(numbers.map(n => upload.parts.get(n)!)));
      this.#uploads.delete(q.get('uploadId')!);
      return send(200, '<CompleteMultipartUploadResult/>');
    }
    if (req.method === 'DELETE' && upload) {
      this.#uploads.delete(q.get('uploadId')!);
      return send(204);
    }
    if (req.method === 'PUT') {
      this.objects.set(key, body);
      return send(200, '', { etag: '"whole"' });
    }
    const object = this.objects.get(key);
    if (!object) return req.method === 'HEAD' ? send(404) : error(404, 'NoSuchKey');
    if (req.method === 'HEAD') return send(200, '', { 'content-length': String(object.length) });
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (!range) return void res.writeHead(200).end(object);
    const start = Number(range[1]);
    if (start >= object.length) return error(416, 'InvalidRange');
    const end = range[2] ? Math.min(Number(range[2]) + 1, object.length) : object.length;
    res.writeHead(206, { 'content-range': `bytes ${start}-${end - 1}/${object.length}` }).end(object.subarray(start, end));
  }

  /** Multipart uploads started but neither completed nor aborted. */
  get openUploads(): number {
    return this.#uploads.size;
  }
}
