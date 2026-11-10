import { describe, expect, it } from 'vitest';
import { CidError, cidForBytes, cidFromBinary, cidToBinary, formatCid, parseCid, sha256Hex } from '../src/cid.js';

const HELLO = 'bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4';
const HELLO_SHA256 = 'a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447';
const EMPTY = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';

describe('DASL CIDs', () => {
  it('computes raw CIDs', () => {
    expect(formatCid(cidForBytes(Buffer.from('hello world\n')))).toBe(HELLO);
    expect(formatCid(cidForBytes(new Uint8Array()))).toBe(EMPTY);
  });

  it('round-trips through string and binary forms', () => {
    const cid = parseCid(HELLO);
    expect(cid.codec).toBe('raw');
    expect(formatCid(cid)).toBe(HELLO);
    expect(cidToBinary(cid)).toHaveLength(36);
    expect(formatCid(cidFromBinary(cidToBinary(cid)))).toBe(HELLO);
  });

  it('exposes the SHA-256 that BagIt manifests use', () => {
    expect(sha256Hex(parseCid(HELLO))).toBe(HELLO_SHA256);
  });

  it('labels DRISL CIDs with their own prefix', () => {
    const cid = formatCid(cidForBytes(Buffer.from('hello world\n'), 'drisl'));
    expect(cid.startsWith('bafyrei')).toBe(true);
    expect(parseCid(cid).codec).toBe('drisl');
  });

  it.each([
    ['another multibase', 'z' + HELLO.slice(1)],
    ['uppercase base32', HELLO.toUpperCase()],
    ['a truncated CID', HELLO.slice(0, -2)],
    ['trailing characters', HELLO + 'a'],
    ['non-canonical padding bits', HELLO.slice(0, -1) + '5'],
  ])('rejects %s', (_, text) => {
    expect(() => parseCid(text)).toThrow(CidError);
  });

  it.each([
    ['CIDv0-style version', 0, 0x55, 0x12, 0x20],
    ['dag-pb codec', 1, 0x70, 0x12, 0x20],
    ['BLAKE3 hash', 1, 0x55, 0x1e, 0x20],
    ['short digest length', 1, 0x55, 0x12, 0x10],
  ])('rejects a %s', (_, version, codec, hash, length) => {
    const bytes = cidToBinary(parseCid(HELLO));
    bytes.set([version, codec, hash, length]);
    expect(() => cidFromBinary(bytes)).toThrow(CidError);
  });
});
