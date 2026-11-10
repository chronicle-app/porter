/** Base class for errors Porter throws on purpose. */
export class PorterError extends Error {
  /**
   * @param code Stable, machine-readable error code.
   * @param message What happened, in a few words.
   * @param hint What to do about it, if anything.
   */
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Bytes didn't match the CID they were stored or requested under. */
export class IntegrityError extends PorterError {
  constructor(message: string, hint?: string) {
    super('integrity', message, hint);
  }
}
