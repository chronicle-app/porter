import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** How long a capability URL lasts unless asked otherwise: long enough to watch a film. */
export const DEFAULT_CAPABILITY_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Who may read from Porter's HTTP server. A request needs either the bearer
 * token, or a capability for one CID that hasn't expired. Both secrets live
 * in `0600` files under the root, so they survive restarts; deleting
 * `porter-secret` revokes every capability URL handed out.
 */
export class Access {
  readonly token: string;
  readonly #secret: Buffer;

  private constructor(token: string, secret: Buffer) {
    this.token = token;
    this.#secret = secret;
  }

  /** Load the token and capability secret from `root`, creating them on first use. */
  static async load(root: string): Promise<Access> {
    await mkdir(root, { recursive: true });
    const token = await secretFile(join(root, 'porter-token'));
    const secret = await secretFile(join(root, 'porter-secret'));
    return new Access(token, Buffer.from(secret, 'base64url'));
  }

  /** Whether an `Authorization` header carries the bearer token. */
  allowsToken(header: string | undefined): boolean {
    const match = header?.match(/^Bearer (\S+)$/);
    return !!match && same(match[1]!, this.token);
  }

  /** Query parameters granting reads of `cid` until `expires` (milliseconds since the epoch). */
  capability(cid: string, expires: number): { exp: string; cap: string } {
    const exp = String(Math.floor(expires / 1000));
    return { exp, cap: this.#sign(cid, exp) };
  }

  /** Whether `exp` and `cap` grant reads of `cid` at `now`. */
  allowsCapability(cid: string, exp: string | null, cap: string | null, now = Date.now()): boolean {
    if (!exp || !cap || !/^\d+$/.test(exp)) return false;
    if (Number(exp) * 1000 <= now) return false;
    return same(cap, this.#sign(cid, exp));
  }

  /** A URL on the server at `base` that reads `cid` without the token until `ttlMs` from now. */
  urlFor(base: string, cid: string, ttlMs = DEFAULT_CAPABILITY_TTL_MS): string {
    const { exp, cap } = this.capability(cid, Date.now() + ttlMs);
    return `${base}/.well-known/rasl/${cid}?exp=${exp}&cap=${cap}`;
  }

  #sign(cid: string, exp: string): string {
    return createHmac('sha256', this.#secret).update(`porter-rasl-read\0${cid}\0${exp}`).digest('base64url');
  }
}

async function secretFile(path: string): Promise<string> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const value = randomBytes(32).toString('base64url');
  try {
    await writeFile(path, value + '\n', { mode: 0o600, flag: 'wx' });
    return value;
  } catch (error) {
    // Another process created it first; use theirs.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return (await readFile(path, 'utf8')).trim();
    throw error;
  }
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
