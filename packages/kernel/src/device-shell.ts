import { AppError } from './errors.ts';

// `adb shell`, `adb exec-out`, and `hdc shell` hand the argv after the subcommand to the device's
// `sh`, which re-parses it. The host never runs a shell, so the injection surface is purely
// device-side: every dynamic element in a device-shell command is a command injection unless the
// transport's own quoting is respected.
//
// The two transports quote differently, which is why a caller names the transport instead of
// choosing quoting. `adb` deliberately escapes nothing ("just like ssh(1)"), so a word reaches the
// device shell inside whatever quotes we put in it and POSIX single-quoting is correct. `hdc` wraps
// every element it forwards in double quotes, so our quotes would arrive as data while `$`,
// backquote, and `"` stay live at the device shell — an escaped word is correct there and a
// single-quoted one is both corrupted and injectable.
//
// A device-shell command can only be produced by `deviceShellArgv`, which renders every word for its
// transport, and every dispatch boundary refuses a `shell`/`exec-out` command it did not produce. The
// one way to hand the device shell an unquoted fragment is `shellFragment`, which is greppable and
// reviewed at its call site and is only available to a transport that forwards words verbatim.
//
// The same POSIX quoting rule also serves host-side needs — CLI hints and daemon recovery hints
// quote for the user's shell, and the Apple runner host exports an environment value. Nothing here
// runs a shell on the host; `shellQuote` and `shellQuoteIfNeeded` are the shared quoting primitive.

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

/** The host tool that carries a device-shell command to the device, and therefore how it quotes. */
export type DeviceShellTransport = 'adb' | 'hdc';

declare const deviceShellArgvBrand: unique symbol;

/**
 * A device-shell command that {@link deviceShellArgv} produced. The phantom member records that
 * provenance; {@link assertDeviceShellArgv} is the runtime truth.
 */
export type DeviceShellArgv = readonly string[] & {
  readonly [deviceShellArgvBrand]: true;
};

// Every command the funnel produced, by identity, mapped to how many leading tokens were its
// transport options. Nothing carries provenance across a rebuild of the device command's words; the
// one rebuild a transport is allowed to do is {@link relayDeviceShellArgvWithoutOptions}.
const mintedDeviceShellOptionRuns = new WeakMap<readonly string[], number>();

/** The characters the device shell still acts on inside the double quotes `hdc` puts around elements. */
const HDC_DOUBLE_QUOTED_LIVE_WORD = /[\\$"`]/g;

/**
 * A backslash escape is what that shell consumes inside those double quotes, so escaping the live
 * characters yields the word — while wrapping in quotes would deliver the quotes as data.
 */
function renderDoubleQuotedShellWord(word: string): string {
  return word.replaceAll(HDC_DOUBLE_QUOTED_LIVE_WORD, (live) => `\\${live}`);
}
function renderShellWord(word: ShellWord, transport: DeviceShellTransport): string {
  if (typeof word === 'number') return String(word);
  if (typeof word === 'string') {
    if (transport === 'hdc') {
      if (word === '') {
        throw new AppError(
          'INVALID_ARGS',
          'hdc drops an empty element instead of carrying it, so the device command would lose an operand.',
          {
            reason: 'hdc-empty-word-unsupported',
            hint: 'Pass a value the transport can carry, or use a device action that needs no operand.',
          },
        );
      }
      return renderDoubleQuotedShellWord(word);
    }
    return shellQuoteIfNeeded(word);
  }
  if (transport === 'hdc') {
    throw new AppError(
      'INVALID_ARGS',
      'hdc wraps every element in double quotes, so a shell fragment would reach the device as literal text instead of a script.',
      { reason: 'hdc-shell-fragment-unsupported' },
    );
  }
  return word.script;
}
/**
 * Builds a device-shell command from words:
 * `deviceShellArgv('adb', 'shell', ['am', 'force-stop', packageName])` →
 * `['shell', 'am', 'force-stop', <quoted packageName>]`. A bare safe word renders byte-identical to
 * itself on the adb transport, so only a value that would have been an injection vector changes.
 *
 * The transport is required because it decides quoting: `adb` forwards words verbatim while `hdc`
 * double-quotes each one. A fragment is refused on `hdc`, where it cannot survive as a script.
 *
 * `prefix` carries transport options that must travel inside the same argv as the subcommand: the
 * `-t <target>` of an `hdc` command sent through the generic host command port, or an adb
 * `wait-for-*` token and `-s`/`-P` pair on a route that spells its addressing in argv. Where a route
 * carries addressing as a typed target instead, mint the device command alone.
 */
export function deviceShellArgv(
  transport: DeviceShellTransport,
  subcommand: DeviceShellSubcommand,
  words: readonly ShellWord[],
  prefix: readonly string[] = [],
): DeviceShellArgv {
  const argv = Object.freeze([
    ...prefix,
    subcommand,
    ...words.map((word) => renderShellWord(word, transport)),
  ]);
  mintedDeviceShellOptionRuns.set(argv, prefix.length);
  return argv as DeviceShellArgv;
}

/**
 * The argv left after a transport took some of a minted command's leading transport options out of
 * it: the `-s <serial>` pair a provider scope adopts for itself, or the addressing a host route moves
 * into a typed target before dispatching. Only a removal inside that option run is the same device
 * command, because the words from the subcommand onward are untouched — which is what no comparison
 * of contents could ever prove. Anything else, including a removal that reaches the device command,
 * comes back unminted and is refused by {@link assertDeviceShellArgv}.
 */
export function relayDeviceShellArgvWithoutOptions(
  args: readonly string[],
  removedIndex: number,
  removedLength: number,
): readonly string[] {
  if (removedLength === 0) return args;
  const optionRun = mintedDeviceShellOptionRuns.get(args);
  const relayed = [...args.slice(0, removedIndex), ...args.slice(removedIndex + removedLength)];
  if (optionRun === undefined || removedIndex + removedLength > optionRun) return relayed;
  const relayedOptionRun = optionRun - removedLength;
  const command = Object.freeze(relayed);
  mintedDeviceShellOptionRuns.set(command, relayedOptionRun);
  return command;
}

/**
 * The dispatch-boundary guard: refuses a `shell`/`exec-out` command that {@link deviceShellArgv} did
 * not build. Checked on the value, so a variable-built or indirect command is caught the same as a
 * literal one, and a copy of a minted command is refused rather than trusted.
 */
export function assertDeviceShellArgv(args: readonly string[], boundary: string): void {
  if (!args.includes('shell') && !args.includes('exec-out')) return;
  if (mintedDeviceShellOptionRuns.has(args)) return;
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
