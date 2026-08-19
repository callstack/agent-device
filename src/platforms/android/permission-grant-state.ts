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
 * The grants a revoke's prior state is resolved against. Held opaque so a caller reads the
 * state once, before the revoke, and can still answer for a permission it only learns
 * afterwards (`photos` resolves its permission by probing the device).
 */
export type AndroidRuntimePermissionGrants = ReadonlyMap<string, AndroidPriorGrantState>;

/** The state of one permission within a grants read; `unknown` when either is absent. */
export function androidPriorGrantState(
  grants: AndroidRuntimePermissionGrants | undefined,
  permission: string,
): AndroidPriorGrantState {
  return grants?.get(permission) ?? 'unknown';
}

/**
 * The acting user's runtime permissions, or `undefined` when the state could not be read —
 * adb failed, the current user could not be resolved, or the dump carried no runtime-permission
 * block for that user.
 *
 * `pm revoke` without `--user` acts on the caller's user, so the state must be read from that
 * same user's block. `dumpsys package` prints an `install permissions:` section and one block
 * per user, all carrying `granted=` lines; a scan that ignores that structure reports another
 * profile's grant — or an install permission that `pm revoke` cannot touch — as this user's.
 */
export async function readAndroidRuntimePermissionGrants(
  device: DeviceInfo,
  appPackage: string,
): Promise<AndroidRuntimePermissionGrants | undefined> {
  const userId = await readAndroidCurrentUserId(device);
  if (userId === undefined) return undefined;
  const result = await runAndroidAdb(device, ['shell', 'dumpsys', 'package', appPackage], {
    allowFailure: true,
  });
  if (result.exitCode !== 0) return undefined;
  return parseAndroidRuntimePermissionGrants(result.stdout, userId);
}

/** The user `adb shell` commands act on, or `undefined` when it cannot be resolved. */
async function readAndroidCurrentUserId(device: DeviceInfo): Promise<number | undefined> {
  const result = await runAndroidAdb(device, ['shell', 'am', 'get-current-user'], {
    allowFailure: true,
  });
  if (result.exitCode !== 0) return undefined;
  const parsed = Number.parseInt(result.stdout.trim(), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

const TOP_LEVEL_SECTION = /^\S.*:\s*$/;
const PACKAGES_SECTION = 'Packages:';
const USER_BLOCK = /^\s*User (\d+):/;
const RUNTIME_PERMISSIONS_BLOCK = /^\s*runtime permissions:\s*$/;
const GRANT_LINE = /^\s*([\w.]+): granted=(true|false)\b/;

/** A non-blank dump line with the indentation that places it in the tree. */
type DumpLine = { text: string; indent: number };

/**
 * Runtime permission grants for `userId` only, or `undefined` when that user has no
 * runtime-permission block in the dump.
 *
 * `dumpsys package` is indentation-structured: top-level `Packages:` holds the package's own
 * blocks, `User <id>:` opens a per-user block, and `runtime permissions:` opens the grant list
 * inside it. The read walks that nesting instead of matching `granted=` anywhere, which is what
 * keeps the `install permissions:` section, other users' blocks, and the later top-level
 * sections (`Queries:`, `Shared users:`, `Dexopt state:` — which repeat `User <id>:` and can
 * repeat grant lines) out of the answer.
 */
export function parseAndroidRuntimePermissionGrants(
  dumpsysOutput: string,
  userId: number,
): AndroidRuntimePermissionGrants | undefined {
  const packages = topLevelSection(readDumpLines(dumpsysOutput), PACKAGES_SECTION);
  const user = nestedBlock(packages, (line) => USER_BLOCK.exec(line.text)?.[1] === String(userId));
  const runtime = nestedBlock(user, (line) => RUNTIME_PERMISSIONS_BLOCK.test(line.text));
  // Absent block: the device never reported this user's grants. An empty one is still an
  // answer — the app holds no runtime permissions for this user.
  if (!runtime) return undefined;
  const grants = new Map<string, AndroidPriorGrantState>();
  for (const { text } of runtime) {
    const grant = GRANT_LINE.exec(text);
    if (grant) grants.set(grant[1]!, grant[2] === 'true' ? 'granted' : 'not_granted');
  }
  return grants;
}

function readDumpLines(dumpsysOutput: string): DumpLine[] {
  return dumpsysOutput
    .split('\n')
    .filter((text) => text.trim().length > 0)
    .map((text) => ({ text, indent: text.length - text.trimStart().length }));
}

/** The lines under a top-level `<name>` header, up to the next top-level header. */
function topLevelSection(lines: readonly DumpLine[], name: string): DumpLine[] {
  const start = lines.findIndex((line) => line.indent === 0 && line.text.trim() === name);
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.indent === 0 && TOP_LEVEL_SECTION.test(line.text));
  return end < 0 ? rest : rest.slice(0, end);
}

/** The lines nested under the first line `isHeader` accepts, or `undefined` if there is none. */
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
