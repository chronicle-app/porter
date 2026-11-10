import { join } from 'node:path';
import { readJson, writeJson } from './files.js';

export interface RemoteCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/** Where remotes' keys are kept. A file today; a keychain could implement this later. */
export interface CredentialStore {
  get(remote: string): Promise<RemoteCredentials | undefined>;
  set(remote: string, credentials: RemoteCredentials): Promise<void>;
  delete(remote: string): Promise<void>;
}

/**
 * Remotes' keys in `porter-credentials.json` in Porter's root, readable only
 * by its owner (`0600`), as Chronicle keeps its own credentials. The file is
 * not encrypted.
 */
export class FileCredentialStore implements CredentialStore {
  readonly path: string;

  constructor(root: string) {
    this.path = join(root, 'porter-credentials.json');
  }

  async get(remote: string): Promise<RemoteCredentials | undefined> {
    return (await this.#load())[remote];
  }

  async set(remote: string, credentials: RemoteCredentials): Promise<void> {
    await this.#save({ ...(await this.#load()), [remote]: credentials });
  }

  async delete(remote: string): Promise<void> {
    const all = await this.#load();
    delete all[remote];
    await this.#save(all);
  }

  async #load(): Promise<Record<string, RemoteCredentials>> {
    return ((await readJson(this.path)) as Record<string, RemoteCredentials> | undefined) ?? {};
  }

  async #save(all: Record<string, RemoteCredentials>): Promise<void> {
    await writeJson(this.path, all, 0o600);
  }
}
