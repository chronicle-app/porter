import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import { FsByteStore, MemoryByteStore, S3ByteStore } from '../src/index.js';
import { byteStoreContract } from './contract.js';
import { FakeS3 } from './fake-s3.js';
import { tempDir } from './helpers.js';

const fake = new FakeS3();
let endpoint = '';
beforeAll(async () => {
  endpoint = await fake.start();
});
afterAll(() => fake.stop());

byteStoreContract('MemoryByteStore', async () => new MemoryByteStore());
byteStoreContract('FsByteStore', async () => new FsByteStore(await tempDir()));
byteStoreContract(
  'S3ByteStore (fake)',
  async () => new S3ByteStore({ endpoint, bucket: fake.bucket, region: 'auto', accessKeyId: 'test', secretAccessKey: 'test', prefix: `${randomUUID()}/` }),
);
