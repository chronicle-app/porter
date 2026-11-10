import { CODEC_DCBOR, CODEC_RAW, createSync, toString } from '@atcute/cid';
import { describe, expect, it } from 'vitest';
import { CidError, parseCid, sha256Hex } from '../src/index.js';

const HELLO = 'bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4';
const HELLO_SHA256 = 'a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447';
const hello = Buffer.from('hello world\n');

describe('parseCid', () => {
  it('parses raw and DRISL CIDs', () => {
    expect(parseCid(HELLO).codec).toBe(CODEC_RAW);
    const drisl = toString(createSync(CODEC_DCBOR, hello));
    expect(drisl.startsWith('bafyrei')).toBe(true);
    expect(parseCid(drisl).codec).toBe(CODEC_DCBOR);
  });

  it.each([
    ['another multibase', 'z' + HELLO.slice(1)],
    ['uppercase base32', HELLO.toUpperCase()],
    ['a truncated CID', HELLO.slice(0, -2)],
    ['trailing characters', HELLO + 'a'],
    ['non-canonical padding bits', HELLO.slice(0, -1) + '5'],
    ['a CIDv0', 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'],
    ['dag-pb', 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'],
    ['a BLAKE3 CID', 'bafkr4ifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4'],
  ])('rejects %s with a CidError', (_, text) => {
    expect(() => parseCid(text)).toThrow(CidError);
    try {
      parseCid(text);
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid-cid', hint: expect.stringContaining('DASL') });
    }
  });
});

describe('sha256Hex', () => {
  it('gives the SHA-256 that BagIt manifests and S3 use', () => {
    expect(sha256Hex(parseCid(HELLO))).toBe(HELLO_SHA256);
    expect(toString(createSync(CODEC_RAW, hello))).toBe(HELLO);
  });
});
