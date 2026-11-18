import type { ExecOptions } from './exec.ts';

/**
 * `ps -o lstart` spells weekday and month names in the caller's locale, so one start time reads
 * differently from a daemon and a client run under different `LANG`/`LC_TIME`. Pin the C form.
 */
const PS_C_LOCALE_ENV: NodeJS.ProcessEnv = { LC_ALL: 'C' };

/** Options for a `ps` read: failure is unknown evidence, and the output is locale-free. */
export function psReadOptions(timeoutMs: number): ExecOptions {
  return { allowFailure: true, timeoutMs, env: PS_C_LOCALE_ENV };
}

const PS_START_TIME_C_FORM = /^[A-Za-z]{3} [A-Za-z]{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;
const CLOCK_TIME = /\d{2}:\d{2}:\d{2}/;

/**
 * A record written before `ps` was pinned to the C locale may hold a localized rendering of the
 * same start time. A C-form string against a localized one proves nothing about the lifetime.
 */
export function psStartTimesLocaleMismatch(left: string, right: string): boolean {
  return (
    PS_START_TIME_C_FORM.test(left) !== PS_START_TIME_C_FORM.test(right) &&
    CLOCK_TIME.test(left) &&
    CLOCK_TIME.test(right)
  );
}
