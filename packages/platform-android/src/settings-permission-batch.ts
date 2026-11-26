import { randomBytes } from 'node:crypto';
import { shellQuote } from '@agent-device/kernel/device-shell';

/**
 * Safe per-invocation command-line budget for `adb shell`: stays well under legacy 4 KiB
 * `adbd` shell buffers while fitting ~50 typical permission ids into one round trip.
 */
const ANDROID_PM_BATCH_MAX_SCRIPT_BYTES = 3_072;

/**
 * Batch timeout for scoped remote adb providers (e.g. Limrun's 30 s per-call default):
 * keeps the full 30 s base budget plus 500 ms per on-device `pm` call, capped at 90 s so a
 * hung device never waits tens of minutes while normal batches keep ample headroom.
 */
const ANDROID_PM_BATCH_REMOTE_BASE_TIMEOUT_MS = 30_000;
const ANDROID_PM_BATCH_REMOTE_PER_CALL_MS = 500;
const ANDROID_PM_BATCH_REMOTE_MAX_TIMEOUT_MS = 90_000;

export function createAndroidPmBatchMarker(): string {
  return `__AD_PM_BATCH_${randomBytes(8).toString('hex')}__`;
}

export function androidPmBatchTimeoutMs(permissionCount: number, clearFlags: boolean): number {
  const calls = Math.max(1, permissionCount) * (clearFlags ? 3 : 1);
  return Math.min(
    ANDROID_PM_BATCH_REMOTE_MAX_TIMEOUT_MS,
    ANDROID_PM_BATCH_REMOTE_BASE_TIMEOUT_MS + calls * ANDROID_PM_BATCH_REMOTE_PER_CALL_MS,
  );
}

export type AndroidPmBatchScriptParams = Readonly<{
  pmAction: 'grant' | 'revoke';
  clearFlags: boolean;
  userArgs: readonly string[];
  appPackage: string;
  permissions: readonly string[];
  skipPhrases: readonly string[];
  marker: string;
}>;

/**
 * Builds a POSIX `case` glob matching `phrase` case-insensitively without spawning `tr`.
 * Derived from the caller's skip-phrase table so the shell's stop-on-hard-failure guard and
 * `classifyAndroidPmSkip` share one source of truth.
 */
function buildShellCaseInsensitivePattern(phrase: string): string {
  let body = '';
  for (const ch of phrase) {
    body += /^[a-z]$/.test(ch) ? `[${ch}${ch.toUpperCase()}]` : shellQuote(ch);
  }
  return `*${body}*`;
}

/**
 * Splits `permissions` into chunks whose generated shell script fits within `maxScriptBytes`.
 * Always emits at least one permission per chunk so an oversized id still makes progress.
 */
export function chunkAndroidPmBatch(
  params: AndroidPmBatchScriptParams,
  maxScriptBytes = ANDROID_PM_BATCH_MAX_SCRIPT_BYTES,
): readonly (readonly string[])[] {
  const { permissions } = params;
  if (permissions.length === 0) return [];
  const baseBytes = Buffer.byteLength(
    buildAndroidPmBatchScript({ ...params, permissions: [] }),
    'utf8',
  );
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentBytes = baseBytes;

  for (const permission of permissions) {
    const quotedBytes = Buffer.byteLength(shellQuote(permission), 'utf8');
    const addedBytes = current.length === 0 ? quotedBytes : 1 + quotedBytes;
    if (current.length > 0 && currentBytes + addedBytes > maxScriptBytes) {
      chunks.push(current);
      current = [permission];
      currentBytes = baseBytes + quotedBytes;
    } else {
      current.push(permission);
      currentBytes += addedBytes;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Builds a single POSIX `sh` script that executes `pm grant|revoke` (and `clear-permission-flags`
 * on reset) across `permissions`, emitting per-command exit code, stdout, and stderr framed by
 * `marker`. Stops immediately (`break`) on the first non-skippable failure so later permissions
 * are never touched.
 */
export function buildAndroidPmBatchScript(params: AndroidPmBatchScriptParams): string {
  const { pmAction, clearFlags, userArgs, appPackage, permissions, skipPhrases, marker } = params;
  const quotedUserArgs = userArgs.map(shellQuote).join(' ');
  const quotedPackage = shellQuote(appPackage);
  const quotedPermissions = permissions.map(shellQuote).join(' ');
  const quotedMarkerOut = shellQuote(`${marker}:OUT:`);
  const quotedMarkerErr = shellQuote(`${marker}:ERR:`);
  const quotedMarkerEnd = shellQuote(`${marker}:END:`);
  const shellSkipCasePattern = skipPhrases.map(buildShellCaseInsensitivePattern).join('|');

  // Android's `/system/bin/pm` is a two-line shell wrapper (`cmd package "$@"`) since API 26.
  // Calling `/system/bin/cmd package` directly when verified avoids one extra `/system/bin/sh`
  // fork per permission while keeping stdout, stderr, and exit status identical.
  const pmSetup = [
    '_pm() { pm "$@"; }',
    `if [ -x /system/bin/cmd ] && [ -r /system/bin/pm ]; then { IFS= read -r _l1; IFS= read -r _l2; } < /system/bin/pm 2>/dev/null; [ "$_l2" = 'cmd package "$@"' ] && _pm() { /system/bin/cmd package "$@"; }; fi`,
    // `mksh` (Android's `/system/bin/sh`) has builtin `print` while `printf` is external toybox.
    `case "$(type print 2>/dev/null)" in *builtin*) _pr() { print -rn -- "$1"; } ;; *) _pr() { printf '%s' "$1"; } ;; esac`,
  ].join('; ');

  const clearFlagsStep = clearFlags
    ? `if [ "$rc" -eq 0 ]; then _pm clear-permission-flags ${quotedUserArgs} ${quotedPackage} "$p" user-set >/dev/null 2>&1; _pm clear-permission-flags ${quotedUserArgs} ${quotedPackage} "$p" user-fixed >/dev/null 2>&1; fi`
    : undefined;

  const loopBody = [
    `echo ${quotedMarkerOut}"$i" >&3`,
    // Route pm's stdout directly to fd 3 (outer stdout) while capturing pm's stderr into $e.
    // Appending `.` via builtin `echo .` preserves trailing newlines across `$(...)`.
    `e=$(_pm ${pmAction} ${quotedUserArgs} ${quotedPackage} "$p" 2>&1 1>&3 3>&-; s=$?; echo .; exit $s)`,
    'rc=$?',
    'e=${e%.}',
    ...(clearFlagsStep ? [clearFlagsStep] : []),
    `echo ${quotedMarkerErr}"$i:$rc" >&3`,
    '[ -n "$e" ] && _pr "$e" >&3',
    `echo ${quotedMarkerEnd}"$i" >&3`,
    `if [ "$rc" -ne 0 ]; then case "$e" in ${shellSkipCasePattern}) ;; *) break ;; esac; fi`,
    'i=$((i + 1))',
  ].join('; ');

  return `exec 3>&1; ${pmSetup}; i=0; for p in ${quotedPermissions}; do ${loopBody}; done`;
}

export type AndroidPmBatchRecord = Readonly<{
  index: number;
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export type AndroidPmBatchParseResult = Readonly<{
  records: readonly AndroidPmBatchRecord[];
  partialStdout: string;
  /** `pm` stderr of the incomplete record, when its stream started before the output stopped. */
  partialStderr: string;
}>;

function skipLineEnding(text: string, pos: number): number | undefined {
  if (text[pos] === '\r' && text[pos + 1] === '\n') return pos + 2;
  if (text[pos] === '\n') return pos + 1;
  return undefined;
}

/**
 * Parses marker-framed per-permission records emitted by {@link buildAndroidPmBatchScript}.
 * Stops cleanly at the first incomplete record so callers can surface partial/transport failures.
 */
export function parseAndroidPmBatchOutput(
  stdout: string,
  marker: string,
  expectedCount: number,
): AndroidPmBatchParseResult {
  const records: AndroidPmBatchRecord[] = [];
  let cursor = 0;

  for (let index = 0; index < expectedCount; index += 1) {
    const outTag = `${marker}:OUT:${index}`;
    const outPos = stdout.indexOf(outTag, cursor);
    if (outPos === -1) {
      return { records, partialStdout: stdout.slice(cursor), partialStderr: '' };
    }
    const contentStart = skipLineEnding(stdout, outPos + outTag.length);
    if (contentStart === undefined) {
      return { records, partialStdout: stdout.slice(cursor), partialStderr: '' };
    }

    const errPrefix = `${marker}:ERR:${index}:`;
    const errPos = stdout.indexOf(errPrefix, contentStart);
    if (errPos === -1) {
      return { records, partialStdout: stdout.slice(contentStart), partialStderr: '' };
    }
    const cmdStdout = stdout.slice(contentStart, errPos);

    const rcStart = errPos + errPrefix.length;
    const rcLineEnd = stdout.indexOf('\n', rcStart);
    if (rcLineEnd === -1) {
      return { records, partialStdout: cmdStdout, partialStderr: '' };
    }
    const rcText = stdout.slice(rcStart, rcLineEnd).replace(/\r$/, '');
    if (!/^\d+$/.test(rcText)) {
      return { records, partialStdout: cmdStdout, partialStderr: '' };
    }
    const exitCode = Number.parseInt(rcText, 10);

    const errStart = rcLineEnd + 1;
    const endTag = `${marker}:END:${index}`;
    const endPos = stdout.indexOf(endTag, errStart);
    if (endPos === -1) {
      return { records, partialStdout: cmdStdout, partialStderr: stdout.slice(errStart) };
    }
    const cmdStderr = stdout.slice(errStart, endPos);

    records.push({ index, exitCode, stdout: cmdStdout, stderr: cmdStderr });
    const afterEnd = endPos + endTag.length;
    cursor = skipLineEnding(stdout, afterEnd) ?? afterEnd;
  }

  return { records, partialStdout: '', partialStderr: '' };
}
