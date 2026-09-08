import type { DeviceInfo } from '@agent-device/kernel/device';
import { runAndroidAdb } from './adb.ts';

/**
 * Whether the app held a runtime permission immediately before a revoke.
 *
 * `unknown` is a first-class answer, not a synonym for `not_granted`: the state is read from
 * `dumpsys package`, which can fail, be truncated, or not list the permission for the acting
 * user at all. Collapsing that into `not_granted` would make the response assert the app was
 * untouched exactly when we cannot tell — and the consequence of being wrong is an agent whose
 * app Android silently killed (#1796).
 */
export type AndroidPriorGrantState = 'granted' | 'not_granted' | 'unknown';

/**
 * What the acting user actually holds. `unknown` is never a value here — absence is what carries
 * it, so a caller reads the map before the revoke and can still answer for a permission it only
 * learns afterwards (`photos` resolves its permission by probing the device).
 */
export type AndroidRuntimePermissionGrants = ReadonlyMap<string, 'granted' | 'not_granted'>;

/**
 * `userId`'s runtime permissions, or `undefined` when the state could not be read — adb failed,
 * or the dump carried no runtime-permission block for that user.
 *
 * The caller passes the user its mutation will target, so the two halves cannot disagree.
 * `dumpsys package` prints an `install permissions:` section and one block per user, all
 * carrying `granted=` lines; a scan that ignores that structure reports another profile's
 * grant — or an install permission that `pm revoke` cannot touch — as this user's.
 */
export async function readAndroidRuntimePermissionGrants(
  device: DeviceInfo,
  appPackage: string,
  userId: number,
): Promise<AndroidRuntimePermissionGrants | undefined> {
  const result = await runAndroidAdb(device, ['shell', 'dumpsys', 'package', appPackage], {
    allowFailure: true,
  });
  if (result.exitCode !== 0) return undefined;
  return parseAndroidRuntimePermissionGrants(result.stdout, userId);
}

/**
 * The foreground user, or `undefined` when it cannot be resolved.
 *
 * This is the user the session's app runs as, and it is NOT what `pm` defaults to:
 * `PackageManagerShellCommand` defaults grant/revoke/permission-flag operations to
 * `UserHandle.USER_SYSTEM`, so on a device whose foreground user is nonzero a bare `pm revoke`
 * silently edits user 0 and leaves the running app's permission untouched. Every permission
 * mutation therefore passes `--user` explicitly (#1796).
 */
export async function readAndroidCurrentUserId(device: DeviceInfo): Promise<number | undefined> {
  const result = await runAndroidAdb(device, ['shell', 'am', 'get-current-user'], {
    allowFailure: true,
  });
  if (result.exitCode !== 0) return undefined;
  // Device stdout is a trust boundary: `parsed` is whatever the shell printed.
  const parsed = Number.parseInt(result.stdout.trim(), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

const USER_BLOCK = /^\s*User (\d+):/;
const RUNTIME_PERMISSIONS_BLOCK = /^\s*runtime permissions:\s*$/;
const GRANT_LINE = /^\s*([\w.]+): granted=(true|false)\b/;
const PACKAGE_BLOCK = /^\s*Package \[.+?\]/;
const REQUESTED_PERMISSIONS_BLOCK = /^\s*requested permissions:\s*$/;
const PERMISSION_ID = /^\s*([A-Za-z][\w.]*)/;

/** A non-blank dump line with the indentation that places it in the tree. */
type DumpLine = { text: string; indent: number };

/** Split a dump into indented lines; blank lines carry no structure. */
function dumpLines(dumpsysOutput: string): DumpLine[] {
  return dumpsysOutput
    .split('\n')
    .filter((text) => text.trim().length > 0)
    .map((text) => ({ text, indent: text.length - text.trimStart().length }));
}

/**
 * Runtime permission grants for `userId` only, or `undefined` when that user has no
 * runtime-permission block in the dump.
 *
 * `dumpsys package` is indentation-structured, so the read walks three nested blocks —
 * `Packages:` → `User <id>:` → `runtime permissions:` — instead of matching `granted=`
 * anywhere. That nesting is what keeps the `install permissions:` section, other users'
 * blocks, and the later top-level sections (`Queries:`, `Shared users:`, `Dexopt state:`,
 * which repeat `User <id>:` and can repeat grant lines) out of the answer.
 */
export function parseAndroidRuntimePermissionGrants(
  dumpsysOutput: string,
  userId: number,
): AndroidRuntimePermissionGrants | undefined {
  const lines = dumpLines(dumpsysOutput);
  const packages = nestedBlock(
    lines,
    (line) => line.indent === 0 && line.text.trim() === 'Packages:',
  );
  const user = nestedBlock(packages, (line) => USER_BLOCK.exec(line.text)?.[1] === String(userId));
  const runtime = nestedBlock(user, (line) => RUNTIME_PERMISSIONS_BLOCK.test(line.text));
  // Absent block: the device never reported this user's grants. An empty one is still an
  // answer — the app holds no runtime permissions for this user.
  if (!runtime) return undefined;
  const grants = new Map<string, 'granted' | 'not_granted'>();
  for (const { text } of runtime) {
    const grant = GRANT_LINE.exec(text);
    if (grant) grants.set(grant[1]!, grant[2] === 'true' ? 'granted' : 'not_granted');
  }
  return grants;
}

/**
 * The lines nested under the first line `isHeader` accepts, or `undefined` if there is none.
 * A block ends at the first line indented no deeper than its header, which is also what ends
 * the top-level `Packages:` section at the next top-level heading.
 */
function nestedBlock(
  lines: readonly DumpLine[] | undefined,
  isHeader: (line: DumpLine) => boolean,
): DumpLine[] | undefined {
  if (!lines) return undefined;
  const start = lines.findIndex((line) => isHeader(line));
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.indent <= lines[start]!.indent);
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * Both halves of one `dumpsys package` read: the declared ids and the acting
 * user's runtime grants. Each half keeps its own absent-vs-empty semantics —
 * see the two parsers — so callers can refuse on a missing section while
 * still answering `unknown` for missing grants.
 */
export function parseAndroidPackagePermissions(
  dumpsysOutput: string,
  userId: number,
): {
  requested: string[] | undefined;
  grants: AndroidRuntimePermissionGrants | undefined;
} {
  return {
    requested: parseAndroidRequestedPermissions(dumpsysOutput),
    grants: parseAndroidRuntimePermissionGrants(dumpsysOutput, userId),
  };
}

/**
 * The permission ids the package declares, in dump order, or `undefined` when
 * the dump carries no `requested permissions:` block for a package. An empty
 * block is still an answer — the app declares nothing — while a missing one
 * means the device did not tell us, and `all` must refuse rather than guess.
 *
 * Entries are bare ids (`android.permission.CAMERA`); any trailing attribute
 * (`: restricted=false`) is not part of the id. Section scoping reuses the
 * same `Packages:` → `Package […]` nesting as the grants read, so the later
 * top-level sections cannot leak ids in.
 */
export function parseAndroidRequestedPermissions(dumpsysOutput: string): string[] | undefined {
  const lines = dumpLines(dumpsysOutput);
  const packages = nestedBlock(
    lines,
    (line) => line.indent === 0 && line.text.trim() === 'Packages:',
  );
  const pkg = nestedBlock(packages, (line) => PACKAGE_BLOCK.test(line.text));
  const requested = nestedBlock(pkg, (line) => REQUESTED_PERMISSIONS_BLOCK.test(line.text));
  if (!requested) return undefined;
  const ids: string[] = [];
  for (const { text } of requested) {
    const id = PERMISSION_ID.exec(text)?.[1];
    if (id && id.includes('.') && !ids.includes(id)) ids.push(id);
  }
  return ids;
}
