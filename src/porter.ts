import { mkdir } from 'node:fs/promises';
import { PorterConfig, type RemoteConfig } from './config.js';
import { FileCredentialStore, type CredentialStore } from './credentials.js';
import { defaultRoot } from './files.js';
import { LocalStore } from './local.js';
import { ReadThrough } from './read-through.js';
import { Replicator, type Remote, type ReplicatorOptions } from './replicate.js';
import { S3ByteStore } from './s3.js';

export interface OpenOptions {
  /** Porter's root directory. Defaults to the platform's application-data directory. */
  root?: string;
  /** Where remotes' keys are kept. Defaults to `porter-credentials.json` in Chronicle's config directory. */
  credentials?: CredentialStore;
}

/**
 * Porter as configured in a root directory: the local store, the remotes
 * from `porter-config.json` with their keys, and readers and replicators
 * built from them. Remotes whose keys are missing are left out of `remotes`
 * and listed in `missingCredentials`, so the rest still works.
 */
export class Porter {
  private constructor(
    readonly root: string,
    readonly config: PorterConfig,
    readonly local: LocalStore,
    readonly remotes: readonly Remote[],
    readonly missingCredentials: readonly string[],
  ) {}

  static async open(options: OpenOptions = {}): Promise<Porter> {
    const root = options.root ?? defaultRoot();
    await mkdir(root, { recursive: true });
    const config = await PorterConfig.load(root);
    const credentials = options.credentials ?? new FileCredentialStore();
    const remotes: Remote[] = [];
    const missing: string[] = [];
    for (const remote of config.remotes) {
      const keys = await credentials.get(remote.name);
      if (keys) remotes.push({ name: remote.name, store: s3Store(remote, keys) });
      else missing.push(remote.name);
    }
    const tiers = config.remotes.filter(remote => remote.newBlobs === 'all').map(remote => remote.name);
    const local = new LocalStore({ root, tiers });
    return new Porter(root, config, local, remotes, missing);
  }

  /** Reads local blobs first, then each remote in configured order. */
  reader(): ReadThrough {
    return new ReadThrough(this.local, this.remotes);
  }

  replicator(options?: ReplicatorOptions): Replicator {
    return new Replicator(this.local, [...this.remotes], options);
  }

  close(): void {
    this.local.close();
  }
}

function s3Store(remote: RemoteConfig, keys: { accessKeyId: string; secretAccessKey: string }): S3ByteStore {
  return new S3ByteStore({ endpoint: remote.endpoint, bucket: remote.bucket, region: remote.region, prefix: remote.prefix, ...keys });
}
