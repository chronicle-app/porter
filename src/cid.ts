import { fromString, type Cid } from '@atcute/cid';
import { PorterError } from './errors.js';

// CIDs are @atcute/cid's DASL CIDs (https://dasl.ing/cid.html): CIDv1,
// SHA-256, raw (0x55) or DRISL (0x71). Porter adds error handling and the hex
// digest; use @atcute/cid directly for everything else.

export type { Cid } from '@atcute/cid';
export { CODEC_DCBOR, CODEC_RAW } from '@atcute/cid';

export class CidError extends PorterError {
  constructor(message: string) {
    super('invalid-cid', message, 'Porter only accepts DASL CIDs: CIDv1, SHA-256, raw or DRISL, base32.');
  }
}

/**
 * Parse a DASL CID string.
 * @throws {CidError} if `text` isn't a DASL CID. Non-canonical base32 is rejected too.
 */
export function parseCid(text: string): Cid {
  try {
    return fromString(text);
  } catch {
    throw new CidError(`Not a DASL CID: ${text.length > 64 ? text.slice(0, 61) + '…' : text}`);
  }
}

/** The digest as hex, as in BagIt manifests and `x-amz-content-sha256`. */
export function sha256Hex(cid: Cid): string {
  return Buffer.from(cid.digest.contents).toString('hex');
}
