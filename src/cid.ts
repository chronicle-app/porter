import { createHash } from 'node:crypto';

// DASL CIDs (https://dasl.ing/cid.html): CIDv1, SHA-256 only, raw or DRISL
// codec, multibase "b" (lowercase RFC 4648 base32, no padding). The binary
// form is always 36 bytes: version, codec, hash type, digest length, digest.

export type Codec = 'raw' | 'drisl';

export interface Cid {
  codec: Codec;
  /** The 32-byte SHA-256 digest of the addressed bytes. */
  digest: Uint8Array;
}

const VERSION = 0x01;
const SHA256 = 0x12;
const DIGEST_LENGTH = 32;
const BINARY_LENGTH = 4 + DIGEST_LENGTH;
const CODECS: Record<Codec, number> = { raw: 0x55, drisl: 0x71 };
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export class CidError extends Error {
  override name = 'CidError';
}

export function encodeBase32(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function decodeBase32(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of text) {
    const digit = BASE32.indexOf(char);
    if (digit < 0) throw new CidError(`Invalid base32 character ${JSON.stringify(char)}`);
    value = ((value << 5) | digit) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out[index++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  // Leftover bits must be zero padding, or two strings would name one CID.
  if (bits >= 5 || (value & ((1 << bits) - 1)) !== 0) throw new CidError('Non-canonical base32');
  return out;
}

export function cidFromBinary(bytes: Uint8Array): Cid {
  if (bytes.length !== BINARY_LENGTH) throw new CidError(`CID must be ${BINARY_LENGTH} bytes, got ${bytes.length}`);
  if (bytes[0] !== VERSION) throw new CidError(`Unsupported CID version ${bytes[0]}`);
  const codec = (Object.keys(CODECS) as Codec[]).find(name => CODECS[name] === bytes[1]);
  if (!codec) throw new CidError(`Unsupported codec 0x${bytes[1]!.toString(16)}`);
  if (bytes[2] !== SHA256) throw new CidError(`Unsupported hash 0x${bytes[2]!.toString(16)}`);
  if (bytes[3] !== DIGEST_LENGTH) throw new CidError(`Unsupported digest length ${bytes[3]}`);
  return { codec, digest: bytes.slice(4) };
}

export function cidToBinary(cid: Cid): Uint8Array {
  if (cid.digest.length !== DIGEST_LENGTH) throw new CidError('Digest must be 32 bytes');
  const out = new Uint8Array(BINARY_LENGTH);
  out.set([VERSION, CODECS[cid.codec], SHA256, DIGEST_LENGTH]);
  out.set(cid.digest, 4);
  return out;
}

export function parseCid(text: string): Cid {
  if (!text.startsWith('b')) throw new CidError('CID must start with "b" (base32)');
  return cidFromBinary(decodeBase32(text.slice(1)));
}

export function formatCid(cid: Cid): string {
  return 'b' + encodeBase32(cidToBinary(cid));
}

export function cidForBytes(bytes: Uint8Array, codec: Codec = 'raw'): Cid {
  return { codec, digest: new Uint8Array(createHash('sha256').update(bytes).digest()) };
}

/** The hex SHA-256 used by BagIt manifests and x-amz-content-sha256. */
export function sha256Hex(cid: Cid): string {
  return Buffer.from(cid.digest).toString('hex');
}

export function cidEquals(a: Cid, b: Cid): boolean {
  return a.codec === b.codec && Buffer.from(a.digest).equals(Buffer.from(b.digest));
}
