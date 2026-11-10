import { createLogger, type Logger, type Sink } from '@chronicle.app/logging';
import { PorterError } from './errors.js';
import { card, clean, colorEnabled, createSink, glyphs, hint, line, pathArg, summary, table, tildes, tokens, type ColorMode, type Status, type Tokens } from './output/index.js';

/**
 * How the `porter` command talks to a person: results on stdout, and
 * everything else as `@chronicle.app/logging` events on stderr, after Vestry.
 * With `--json`, one JSON result or error on stdout and nothing else.
 */
export class Terminal {
  json = false;
  quiet = false;
  mode: ColorMode = 'auto';
  /** The `--home` a person passed, added to porter commands in hints so they run as printed. */
  home?: string;
  #output?: { sink: Sink; logger: Logger };

  configure(options: { json?: boolean; quiet?: boolean; mode?: ColorMode; home?: string }): void {
    this.#output = undefined;
    Object.assign(this, options);
  }

  get #log(): Logger {
    if (!this.#output) {
      const tty = !!process.stderr.isTTY;
      const sink = createSink({ pretty: tty, t: tokens(colorEnabled(this.mode, tty)), level: this.quiet ? 'warn' : 'info' });
      this.#output = { sink, logger: createLogger({ scope: 'cli', sink }) };
    }
    return this.#output.logger;
  }

  /** Colors for stdout. */
  get t(): Tokens {
    return tokens(colorEnabled(this.mode, !!process.stdout.isTTY));
  }

  /** Columns a result fits: the terminal's, or unbounded when piped, so nothing is cut. */
  get width(): number {
    return process.stdout.isTTY ? (process.stdout.columns || 80) - 1 : Number.POSITIVE_INFINITY;
  }

  /** A command's result: `data` as JSON, or `lines` for a person. */
  result(command: string, data: Record<string, unknown>, lines: () => string[]): void {
    if (this.json) {
      process.stdout.write(JSON.stringify({ schemaVersion: 1, command, ...data }) + '\n');
      return;
    }
    const out = lines();
    if (out.length) process.stdout.write(out.join('\n') + '\n');
  }

  summary(status: Status, title: string, durationMs?: number): string {
    return summary({ status, title, durationMs }, this.t, this.width);
  }

  card(entries: [string, string][]): string[] {
    return card(entries.map(([key, value]) => [key, clean(value)]), this.t, this.width);
  }

  table(headings: string[], cells: string[][], numeric: boolean[] = []): string[] {
    return table({ headings, cells: cells.map(row => row.map(clean)), numeric }, this.t, this.width).lines;
  }

  hint(text: string): string[] {
    return hint(this.#next(text), this.t, this.width);
  }

  line(text: string): string {
    return line([[clean(text)]], this.width);
  }

  /** Something wrong that didn't stop the command. */
  warn(message: string, next?: string): void {
    if (this.json) return;
    this.#log.emit({ level: 'warn', kind: 'notice', message: tildes(clean(message)), ...(next && { hint: { action: this.#next(next) } }) });
    this.#log.flush();
  }

  /** What stopped the command, and what to do about it. Returns the exit code. */
  error(command: string, error: unknown): number {
    const known = error instanceof PorterError;
    const code = known ? error.code : 'internal';
    const exitCode = code === 'usage' ? 2 : 1;
    const message = error instanceof Error ? error.message : String(error);
    const next = known ? error.hint : 'This looks like a bug in Porter.';
    if (this.json) {
      process.stdout.write(JSON.stringify({ schemaVersion: 1, command, error: { code, message, ...(next && { hint: next }), exitCode } }) + '\n');
      return exitCode;
    }
    this.#log.emit({ level: 'error', kind: 'error', message: tildes(clean(message)), error: { code, exitCode }, ...(next && { hint: { action: this.#next(next) } }) });
    this.#log.flush();
    return exitCode;
  }

  /** A hint made safe to print, with `--home` added to each porter command in it. */
  #next(text: string): string {
    text = clean(text);
    if (!this.home) return text;
    return text.replaceAll(/`(porter [^`]*)`/g, (span, command: string) => (/--home|--help/.test(command) ? span : `\`${command} --home ${pathArg(this.home!)}\``));
  }
}

export { glyphs };
