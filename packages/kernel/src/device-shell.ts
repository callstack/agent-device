import { AppError } from './errors.ts';

// `adb shell`, `adb exec-out`, and `hdc shell` join the argv after the subcommand into one string
// that the device's `sh` re-parses (adb deliberately does not escape, "just like ssh(1)"). The host
// never runs a shell, so the injection surface is purely device-side: every dynamic element in a
// device-shell argv is a command injection unless it is quoted.
//
// The boundary makes that unrepresentable rather than detected: a device-shell argv can only be
// produced by `deviceShellArgv`, which quotes every word, and every executor boundary refuses a
// `shell`/`exec-out` argv it did not produce. The one way to hand the device shell an unquoted
// fragment is `shellFragment`, which is greppable and reviewed at its call site.

const SAFE_SHELL_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** POSIX single-quote wrap (`'` → `'\''`), always one argument to a shell. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/** Quote only when the value is not already a bare shell word; identity on the safe charset. */
export function shellQuoteIfNeeded(value: string): string {
  return SAFE_SHELL_WORD.test(value) ? value : shellQuote(value);
}

declare const shellFragmentBrand: unique symbol;

/**
 * A shell-script fragment the author wrote and quoted themselves (a pipeline, redirection, or
 * `&` background job). The device shell parses it verbatim, so every interpolated value inside
 * it must go through `shellQuote`.
 */
export type ShellFragment = Readonly<{ readonly [shellFragmentBrand]: true; script: string }>;

export function shellFragment(script: string): ShellFragment {
  return Object.freeze({ script }) as ShellFragment;
}

/** One element of a device-shell command: a value (quoted for the device shell) or a fragment. */
export type ShellWord = string | number | ShellFragment;

export type DeviceShellSubcommand = 'shell' | 'exec-out';

// Every argv the funnel produced, by identity. A relay that must rebuild the array (prefixing or
// stripping transport options) carries the identity across with `relayDeviceShellArgv`; a plain
// copy is refused, loudly, at the next boundary.
const mintedDeviceShellArgv = new WeakSet<readonly string[]>();

function renderShellWord(word: ShellWord): string {
  if (typeof word === 'number') return String(word);
  if (typeof word === 'string') return shellQuoteIfNeeded(word);
  return word.script;
}

/**
 * Builds the argv for a device-shell subcommand from words: `deviceShellArgv('shell', ['am',
 * 'force-stop', packageName])` → `['shell', 'am', 'force-stop', <quoted packageName>]`. A bare
 * safe word renders byte-identical to itself, so only a value that would have been an injection
 * vector changes. `prefix` carries transport options that precede the subcommand
 * (`['-s', serial]`, `['-t', target]`).
 */
export function deviceShellArgv(
  subcommand: DeviceShellSubcommand,
  words: readonly ShellWord[],
  prefix: readonly string[] = [],
): readonly string[] {
  const argv = Object.freeze([...prefix, subcommand, ...words.map(renderShellWord)]);
  mintedDeviceShellArgv.add(argv);
  return argv;
}

/**
 * A relay that rebuilds an argv it received (adding or removing transport options such as
 * `-s <serial>`) hands the rebuilt array through here so a minted argv stays minted and a raw one
 * stays raw. The device-side command itself must not change.
 */
export function relayDeviceShellArgv<Rebuilt extends readonly string[]>(
  received: readonly string[],
  rebuilt: Rebuilt,
): Rebuilt {
  if (mintedDeviceShellArgv.has(received)) mintedDeviceShellArgv.add(rebuilt);
  return rebuilt;
}

function isDeviceShellArgv(args: readonly string[]): boolean {
  return args.includes('shell') || args.includes('exec-out');
}

/**
 * The executor-boundary guard: refuses a `shell`/`exec-out` argv that {@link deviceShellArgv} did
 * not build. Checked on the value, so a variable-built or indirect argv is caught the same as a
 * literal one.
 */
export function assertDeviceShellArgv(args: readonly string[], boundary: string): void {
  if (!isDeviceShellArgv(args) || mintedDeviceShellArgv.has(args)) return;
  throw new AppError(
    'INVALID_ARGS',
    `${boundary}: device-shell argv must be built with deviceShellArgv (got ${JSON.stringify(args)}).`,
    { reason: 'unguarded-device-shell-argv' },
  );
}

export type DeviceShellExecutable = 'adb' | 'hdc';

/** Which device-shell tool a host command names, whatever its path or Windows extension. */
export function deviceShellExecutableOf(command: string): DeviceShellExecutable | undefined {
  const executable = command
    .slice(Math.max(command.lastIndexOf('/'), command.lastIndexOf('\\')) + 1)
    .replace(/\.(?:com|exe|bat|cmd)$/i, '');
  return executable === 'adb' || executable === 'hdc' ? executable : undefined;
}
