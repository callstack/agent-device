import type { ExecOptions } from './exec.ts';

/**
 * `ps -o lstart` spells weekday and month names in the caller's locale, so one start time reads
 * differently from a daemon and a client run under different `LANG`/`LC_TIME`. Every `ps` read
 * whose output carries `lstart` runs with this pin.
 */
const PS_LSTART_LOCALE_PIN: NodeJS.ProcessEnv = { LC_ALL: 'C' };

/**
 * Options for a `ps` read whose output does not carry `lstart`: failure is unknown evidence, and
 * the caller's locale stays in charge of the output.
 */
export function psReadOptions(timeoutMs: number): ExecOptions {
  return { allowFailure: true, timeoutMs };
}

/**
 * Options for a `ps` read whose output carries `lstart`: failure is unknown evidence, and the C
 * locale is pinned as the final override on top of the effective child environment, so `TZ` and
 * the rest of the environment survive the pin. Command-text reads must not use this: BSD/macOS
 * `ps` escapes non-ASCII argv bytes under `LC_ALL=C`, and every command read in host-kit has to
 * keep the same encoding as `listHostProcesses`, which runs unpinned.
 */
export function psLstartReadOptions(timeoutMs: number): ExecOptions {
  return { allowFailure: true, timeoutMs, envOverrides: PS_LSTART_LOCALE_PIN };
}

/**
 * The `ps -o lstart=` rendering printed under the pinned C locale, e.g. `Tue Nov 17 19:42:27 2026`.
 */
const PS_START_TIME_C_FORM = /^[A-Za-z]{3} [A-Za-z]{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;
/** The invariant-culture CIM birth stamp a Windows host reads: `yyyyMMddHHmmssfffffff`. */
const WINDOWS_START_TIME = /^\d{21}$/;

/**
 * The format of a recorded start time. Only the formats host-kit itself reads are verified: the
 * `linux:` token of one /proc read, the pinned C-form `lstart`, and the Windows invariant stamp.
 * Anything else is a legacy record — written by an older build whose `ps` ran under another
 * locale, such as `mar. 17 nov. 19:42:27 2026` or a rendering with no colon-separated clock — and
 * its text cannot be compared against another format.
 */
function psStartTimeFormat(value: string): 'linux' | 'c-lstart' | 'windows' | 'legacy' {
  if (value.startsWith('linux:')) return 'linux';
  if (PS_START_TIME_C_FORM.test(value)) return 'c-lstart';
  if (WINDOWS_START_TIME.test(value)) return 'windows';
  return 'legacy';
}

/**
 * Positive proof of different lifetimes. Unreadable values prove nothing, and a difference proves
 * exit only when both sides share one verified format: a legacy localized rendering beside a
 * C-form read, or beside another legacy rendering, is unverified evidence, never proof that the
 * recorded process is gone.
 */
export function processStartTimesDiffer(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false;
  const leftFormat = psStartTimeFormat(left);
  if (leftFormat !== psStartTimeFormat(right)) return false;
  if (leftFormat === 'legacy') return false;
  return left !== right;
}
