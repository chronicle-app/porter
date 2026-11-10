#!/usr/bin/env node
// node:sqlite warns that it's experimental on first use. That's noise for
// people running porter, so drop that one warning before anything loads it.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes('SQLite is an experimental feature')) return;
  emitWarning.call(process, warning, ...rest);
};

const { main } = await import('../dist/src/cli.js');
process.exitCode = await main(process.argv.slice(2));
