import { effectiveChildEnv, type ExecOptions } from './exec.ts';

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
  return { allowFailure: true, timeoutMs, env: effectiveChildEnv(PS_LSTART_LOCALE_PIN) };
}
