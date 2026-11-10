import { join } from 'node:path';
import { PorterError } from './errors.js';
import { readJson, writeJson } from './files.js';

/** A remote, without its secrets. */
export interface RemoteConfig {
  /** Lowercase letters, digits, and dashes, e.g. `r2`. */
  name: string;
  endpoint: string;
  bucket: string;
  region: string;
  /** Prepended to every object name. Defaults to none. */
  prefix?: string;
  /** Whether new blobs are queued for this remote. Existing ones only go by an explicit backfill. */
  newBlobs: 'all' | 'none';
}

const NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** `porter-config.json` in Porter's root: settings, never secrets. */
export class PorterConfig {
  private constructor(
    readonly path: string,
    private remoteList: RemoteConfig[],
  ) {}

  static async load(root: string): Promise<PorterConfig> {
    const path = join(root, 'porter-config.json');
    const data = (await readJson(path)) as { remotes?: RemoteConfig[] } | undefined;
    return new PorterConfig(path, data?.remotes ?? []);
  }

  get remotes(): readonly RemoteConfig[] {
    return this.remoteList;
  }

  remote(name: string): RemoteConfig | undefined {
    return this.remoteList.find(remote => remote.name === name);
  }

  /** Add a remote. Call `save` to keep it. */
  addRemote(remote: RemoteConfig): void {
    if (!NAME.test(remote.name)) {
      throw new PorterError('invalid-remote', `Invalid remote name ${remote.name}`, 'Use lowercase letters, digits, and dashes, starting with a letter.');
    }
    if (this.remote(remote.name)) throw new PorterError('remote-exists', `Remote ${remote.name} already exists`, `Remove it first with \`porter remote remove ${remote.name}\`.`);
    try {
      new URL(remote.endpoint);
    } catch {
      throw new PorterError('invalid-remote', `Invalid endpoint ${remote.endpoint}`, 'Use a full URL, like https://ACCOUNT.r2.cloudflarestorage.com.');
    }
    this.remoteList = [...this.remoteList, remote];
  }

  /** Remove a remote. Its blobs' history stays in the index, and nothing in its bucket is deleted. */
  removeRemote(name: string): void {
    if (!this.remote(name)) throw new PorterError('unknown-remote', `No remote named ${name}`, 'Run `porter remote list` to see them.');
    this.remoteList = this.remoteList.filter(remote => remote.name !== name);
  }

  async save(): Promise<void> {
    await writeJson(this.path, { remotes: this.remoteList });
  }
}
