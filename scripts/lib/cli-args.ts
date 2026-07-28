import { parseArgs, type ParseArgsConfig } from 'node:util';

type Options = NonNullable<ParseArgsConfig['options']>;

/**
 * `parseArgs` plus the shared script `--help` contract: `-h`/`--help` prints the
 * usage the caller owns and exits 0, so no script re-implements the flag.
 */
export function parseScriptArgs<T extends Options>(
  argv: readonly string[],
  usage: string,
  options: T,
): ReturnType<typeof parseArgs<{ options: T & { help: { type: 'boolean' } } }>>['values'] {
  const { values } = parseArgs({
    args: [...argv],
    options: { ...options, help: { type: 'boolean', short: 'h', default: false } },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(usage);
    process.exit(0);
  }
  return values as ReturnType<
    typeof parseArgs<{ options: T & { help: { type: 'boolean' } } }>
  >['values'];
}
