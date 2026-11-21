import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import {
  accessHostFile,
  chmodHostFile,
  copyHostFile,
  ensureHostDirectory,
  hostFileExistsSync,
  hostHomeDirectory,
  readHostBinaryFile,
  readHostDirectory,
  readHostTextFile,
  renameHostPath,
  writeHostTextFile,
} from '@agent-device/host-kit/host-file';
import type { EnvMap } from '@agent-device/kernel/source-value';
import type { MacOsHelperSurface, SessionSurface } from '@agent-device/contracts/session';
import type {
  MacOsBackgroundProcess,
  MacOsDeliveryMechanism,
  MacOsPermissionTarget,
} from '@agent-device/contracts/macos-platform-leaf';
import { resolveDeviceClaimRoot } from '@agent-device/host-kit/file';
import type { MacOsToolbox } from './toolbox.ts';

// Keep this shape aligned with macOS helper SnapshotNodeResponse in
// macos-helper/Sources/AgentDeviceMacOSHelper/SnapshotTraversal.swift.
export type MacOsSnapshotNode = {
  index: number;
  type?: string;
  role?: string;
  subrole?: string;
  label?: string;
  value?: string;
  identifier?: string;
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  enabled?: boolean;
  selected?: boolean;
  hittable?: boolean;
  depth?: number;
  parentIndex?: number;
  pid?: number;
  bundleId?: string;
  appName?: string;
  windowTitle?: string;
  surface?: string;
};

type HelperSuccess<T extends Record<string, unknown>> = {
  ok: true;
  data: T;
};

type HelperFailure = {
  ok: false;
  error?: {
    message?: string;
    details?: Record<string, unknown>;
  };
};

type HelperResult<T extends Record<string, unknown>> = HelperSuccess<T> | HelperFailure;

const MACOS_HELPER_PRODUCT_NAME = 'agent-device-macos-helper';
const MACOS_HELPER_ENV_PATH = 'AGENT_DEVICE_MACOS_HELPER_BIN';
const MACOS_HELPER_INSTALL_ROOT = path.join(
  hostHomeDirectory(),
  '.agent-device',
  'macos-helper',
  'current',
);
const MACOS_HELPER_MANIFEST_PATH = path.join(MACOS_HELPER_INSTALL_ROOT, 'manifest.json');
const MACOS_BUNDLE_ID_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/;

function assertMacOsBundleId(bundleId: string): string {
  const normalized = bundleId.trim();
  if (!MACOS_BUNDLE_ID_PATTERN.test(normalized)) {
    throw new AppError(
      'INVALID_ARGS',
      'macOS bundle id must use reverse-DNS form like com.example.App',
      { bundleId },
    );
  }
  return normalized;
}

function appendMacOsHelperContextArgs(
  args: string[],
  options: { bundleId?: string; surface?: SessionSurface },
): void {
  if (options.bundleId) {
    args.push('--bundle-id', assertMacOsBundleId(options.bundleId));
  }
  if (options.surface) {
    args.push('--surface', options.surface);
  }
}

const MACOS_GHOST_CURSOR_ENV = 'AGENT_DEVICE_MACOS_GHOST_CURSOR';

/**
 * A background action on an app session draws its own pointer so the user can follow it while
 * keeping the real one; `AGENT_DEVICE_MACOS_GHOST_CURSOR=0` turns the drawing off.
 */
function appendGhostCursorArg(
  args: string[],
  surface: SessionSurface | undefined,
  env: Readonly<EnvMap>,
): void {
  if (surface !== 'app') return;
  if (env[MACOS_GHOST_CURSOR_ENV]?.trim() === '0') return;
  args.push('--ghost-cursor');
}

/**
 * The ghost cursor's glide and pulse take about 0.3 s; the budget also covers the helper's first
 * WindowServer connection. Only a drawn cursor earns it.
 */
function ghostCursorBudgetMs(args: readonly string[]): number {
  return args.includes('--ghost-cursor') ? 1_000 : 0;
}

/**
 * The reasons the helper writes, which {@link runMacOsHelper} passes through in its error details.
 * `contracts/fixtures/macos-native-helper-outcomes.json` pins them with the Swift
 * `BackgroundRefusal` (the first five rows) and `HelperFailureReason` enums.
 */
export const MACOS_HELPER_REASONS = {
  // A double-click or press-and-hold has no accessibility equivalent in a background macOS app.
  pointerGesture: { reason: 'background-pointer-gesture' },
  // No accessibility element the action can use is at the point.
  noAccessibleTarget: { reason: 'no-accessible-target' },
  // No settable text input is at the point, or the input refused the new value.
  noTextInput: { reason: 'no-settable-text-input' },
  // No scroll area with a settable scroll bar is under the front window's center.
  noScrollBar: { reason: 'no-scroll-bar' },
  // No element at the point offers a context menu.
  noContextMenu: { reason: 'no-context-menu' },
  // The app has no on-screen window on the current Space.
  windowNotFound: { reason: 'window-not-found' },
  // The app excludes its front window from screen capture; use `snapshot` to read it.
  frontWindowCaptureExcluded: { reason: 'front-window-capture-excluded' },
  // ScreenCaptureKit does not offer the front window, for example while it opens or closes.
  frontWindowNotShareable: { reason: 'front-window-not-shareable' },
  // The element offered a context menu, but no menu window appeared.
  contextMenuNotObserved: { reason: 'context-menu-not-observed' },
  // The app's on-screen window list could not be read.
  windowListUnreadable: { reason: 'window-list-unreadable' },
  // macOS could not create the keyboard or mouse event to post.
  eventCreationFailed: { reason: 'event_creation_failed' },
  // No button on the alert fits the requested accept or dismiss.
  missingButton: { reason: 'missing_button' },
} as const satisfies ReasonTable<'macos helper'>;
/** The helper's app-surface refusals, which the native macOS app backend answers as unsupported. */
export const MACOS_HELPER_REFUSAL_REASONS: ReadonlySet<string> = new Set([
  MACOS_HELPER_REASONS.pointerGesture.reason,
  MACOS_HELPER_REASONS.noAccessibleTarget.reason,
  MACOS_HELPER_REASONS.noTextInput.reason,
  MACOS_HELPER_REASONS.noScrollBar.reason,
  MACOS_HELPER_REASONS.noContextMenu.reason,
]);
export const MACOS_DELIVERY_MECHANISMS = [
  'ax-press',
  'ax-focus',
  'ax-value',
  'ax-selected-text',
  'ax-confirm',
  'ax-scroll-bar',
  'ax-show-menu',
  'key-events',
] as const;
type AssertTrue<T extends true> = T;
/** Compile-time pin: this table and the leaf contract name the same mechanisms. */
export type MacOsDeliveryMechanismsMatchContract = AssertTrue<
  [MacOsDeliveryMechanism] extends [(typeof MACOS_DELIVERY_MECHANISMS)[number]]
    ? [(typeof MACOS_DELIVERY_MECHANISMS)[number]] extends [MacOsDeliveryMechanism]
      ? true
      : false
    : false
>;

export function resolveMacOsHelperPackageRootFrom(modulePath: string): string {
  let currentDir = path.dirname(modulePath);
  while (true) {
    const candidate = path.join(currentDir, 'macos-helper');
    if (hostFileExistsSync(path.join(candidate, 'Package.swift'))) {
      return candidate;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }
  throw new AppError('COMMAND_FAILED', 'Unable to locate macOS helper package root', {
    modulePath,
  });
}

function resolveMacOsHelperPackageRoot(): string {
  return resolveMacOsHelperPackageRootFrom(fileURLToPath(import.meta.url));
}

function resolveMacOsHelperSourceBinaryPath(): string {
  return path.join(resolveMacOsHelperPackageRoot(), '.build', 'release', MACOS_HELPER_PRODUCT_NAME);
}

function resolveInstalledMacOsHelperPath(): string {
  return path.join(MACOS_HELPER_INSTALL_ROOT, MACOS_HELPER_PRODUCT_NAME);
}

async function listMacOsHelperSourceFiles(root: string): Promise<string[]> {
  const entries = await readHostDirectory(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.build') return [];
        return await listMacOsHelperSourceFiles(entryPath);
      }
      if (!entry.isFile()) return [];
      if (!entry.name.endsWith('.swift') && entry.name !== 'Package.swift') return [];
      return [entryPath];
    }),
  );
  return files.flat().sort();
}

async function computeMacOsHelperFingerprint(
  box: MacOsToolbox,
  packageRoot: string,
): Promise<string> {
  const files = await listMacOsHelperSourceFiles(packageRoot);
  const hash = createHash('sha256');
  for (const filePath of files) {
    hash.update(path.relative(packageRoot, filePath));
    hash.update('\0');
    hash.update(await readHostBinaryFile(filePath));
    hash.update('\0');
  }
  const swiftVersion = await box.tools.runCommand('swift', ['--version'], {
    allowFailure: true,
    cwd: packageRoot,
    timeoutMs: 10_000,
  });
  hash.update('swift-version');
  hash.update('\0');
  hash.update(swiftVersion.stdout || swiftVersion.stderr || `exit:${swiftVersion.exitCode}`);
  hash.update('\0');
  return hash.digest('hex');
}

async function readInstalledMacOsHelperFingerprint(): Promise<string | null> {
  try {
    const data = JSON.parse(await readHostTextFile(MACOS_HELPER_MANIFEST_PATH)) as {
      fingerprint?: unknown;
    };
    return typeof data.fingerprint === 'string' ? data.fingerprint : null;
  } catch {
    return null;
  }
}

/**
 * The executable an override variable names. It must be an absolute path the host can execute:
 * the host answers the probe, so it reads the same machine the spawn it authorizes runs on.
 */
async function resolveHelperOverridePath(
  box: MacOsToolbox,
  rawPath: string | undefined,
): Promise<string | undefined> {
  const candidate = rawPath?.trim();
  if (!candidate) return undefined;
  if (!path.isAbsolute(candidate) || candidate.includes('\0')) {
    throw new AppError(
      'INVALID_ARGS',
      `${MACOS_HELPER_ENV_PATH} must be an absolute executable path, not ${JSON.stringify(rawPath)}`,
      { envName: MACOS_HELPER_ENV_PATH, path: rawPath },
    );
  }
  if (!(await box.host.isFileExecutable(candidate))) {
    throw new AppError(
      'TOOL_MISSING',
      `${MACOS_HELPER_ENV_PATH} points to a missing or non-executable file: ${candidate}`,
      { envName: MACOS_HELPER_ENV_PATH, path: candidate },
    );
  }
  return candidate;
}

async function ensureMacOsHelperBinary(box: MacOsToolbox): Promise<string> {
  const packageRoot = resolveMacOsHelperPackageRoot();
  const sourceFingerprint = await computeMacOsHelperFingerprint(box, packageRoot);
  const installedPath = resolveInstalledMacOsHelperPath();
  try {
    const installedFingerprint = await readInstalledMacOsHelperFingerprint();
    if (installedFingerprint === sourceFingerprint) {
      await accessHostFile(installedPath);
      return installedPath;
    }
  } catch {
    // Build/install below.
  }

  const sourceBinary = resolveMacOsHelperSourceBinaryPath();
  box.host.emitDiagnostic({
    level: 'info',
    phase: 'macos_helper_build',
    data: { packageRoot, reason: 'first run or helper update' },
  });
  await box.tools.runCommand('swift', ['build', '-c', 'release', '--package-path', packageRoot], {
    cwd: packageRoot,
    timeoutMs: 120_000,
  });
  await ensureHostDirectory(MACOS_HELPER_INSTALL_ROOT);
  const tempInstalledPath = `${installedPath}.tmp`;
  await copyHostFile(sourceBinary, tempInstalledPath);
  await renameHostPath(tempInstalledPath, installedPath);
  await chmodHostFile(installedPath, 0o755);
  await writeHostTextFile(
    MACOS_HELPER_MANIFEST_PATH,
    `${JSON.stringify({ fingerprint: sourceFingerprint }, null, 2)}\n`,
  );
  return installedPath;
}

async function resolveMacOsHelperCommandPath(
  box: MacOsToolbox,
  env: Readonly<EnvMap>,
): Promise<string> {
  const configuredPath = await resolveHelperOverridePath(box, env[MACOS_HELPER_ENV_PATH]);
  if (configuredPath) return configuredPath;
  if (box.tools.scoped) {
    return MACOS_HELPER_PRODUCT_NAME;
  }
  if (box.host.hostOs !== 'darwin') {
    throw new AppError('UNSUPPORTED_PLATFORM', 'macOS helper is only available on macOS');
  }
  return await ensureMacOsHelperBinary(box);
}

export async function startMacOsAudioProbeProcess(
  box: MacOsToolbox,
  options: {
    durationMs: number;
    bucketMs: number;
    statusPath: string;
    env: Readonly<EnvMap>;
  },
): Promise<MacOsBackgroundProcess> {
  const helperPath = await resolveMacOsHelperCommandPath(box, options.env);
  return await box.tools.startBackground(helperPath, [
    'audio-probe',
    '--duration-ms',
    String(options.durationMs),
    '--bucket-ms',
    String(options.bucketMs),
    '--out',
    options.statusPath,
  ]);
}

const MACOS_HELPER_TIMEOUT_MS = 30_000;
/**
 * Every stop the host applies to the helper — a deadline, a cancelled request, a client that
 * dropped mid-command — reaches it as SIGTERM first. A helper posting a press may be holding
 * the mouse button down at that moment, and its SIGTERM handler releases the button before it
 * exits; SIGKILL would end it between the down and the up and leave the button stuck for
 * whatever the user touches next. A helper that has not exited a second later is killed.
 */
const MACOS_HELPER_KILL_GRACE_MS = 1_000;

async function runMacOsHelper<T extends Record<string, unknown>>(
  box: MacOsToolbox,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs?: number; env: Readonly<EnvMap> },
): Promise<T> {
  const helperOptions = {
    allowFailure: true,
    timeoutMs: options.timeoutMs ?? MACOS_HELPER_TIMEOUT_MS,
    signal: options.signal,
    kill: { signal: 'SIGTERM' as const, graceMs: MACOS_HELPER_KILL_GRACE_MS },
  };
  const helperProvider = box.tools.helper;
  const helperPath = helperProvider
    ? MACOS_HELPER_PRODUCT_NAME
    : await resolveMacOsHelperCommandPath(box, options.env);
  const result = helperProvider
    ? await helperProvider.run(args, helperOptions)
    : await box.tools.runCommand(helperPath, args, helperOptions);
  const stdout = result.stdout.trim();
  let parsed: HelperResult<T> | null = null;
  if (stdout) {
    try {
      parsed = JSON.parse(stdout) as HelperResult<T>;
    } catch {
      parsed = null;
    }
  }

  if (result.exitCode === 0 && parsed?.ok) {
    return parsed.data;
  }

  const message =
    parsed && !parsed.ok
      ? (parsed.error?.message ?? `macOS helper exited with code ${result.exitCode}`)
      : stdout || result.stderr.trim() || `macOS helper exited with code ${result.exitCode}`;
  // The helper's `details` carry its typed `reason` and, where a remedy exists, its `hint`;
  // `normalizeError` reads `details.hint`, so the refusal reaches the agent untouched.
  // exec-guard-allow: the message is already built from the helper's JSON error
  // envelope (or its output); a stderr excerpt would only degrade it, and the
  // throw is reachable at exit 0 when the envelope reports ok=false.
  throw new AppError('COMMAND_FAILED', message, {
    helperPath,
    args,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    ...(parsed && !parsed.ok ? parsed.error?.details : {}),
  });
}

export async function resolveFrontmostMacOsApp(
  box: MacOsToolbox,
  env: Readonly<EnvMap>,
): Promise<{
  bundleId?: string;
  appName?: string;
  pid?: number;
}> {
  return await runMacOsHelper(box, ['app', 'frontmost'], { env });
}

export async function quitMacOsApp(
  box: MacOsToolbox,
  bundleId: string,
  env: Readonly<EnvMap>,
): Promise<{
  bundleId: string;
  running: boolean;
  terminated: boolean;
  forceTerminated: boolean;
}> {
  return await runMacOsHelper(box, ['app', 'quit', '--bundle-id', assertMacOsBundleId(bundleId)], {
    env,
  });
}

export async function runMacOsPermissionAction(
  box: MacOsToolbox,
  action: 'grant' | 'reset',
  target: MacOsPermissionTarget,
  env: Readonly<EnvMap>,
): Promise<{
  target: MacOsPermissionTarget;
  granted: boolean;
  requested: boolean;
  openedSettings: boolean;
  action: 'grant' | 'reset';
  message?: string;
}> {
  return await runMacOsHelper(box, ['permission', action, target], { env });
}

export async function runMacOsAlertAction(
  box: MacOsToolbox,
  action: 'get' | 'accept' | 'dismiss',
  options: { bundleId?: string; surface?: SessionSurface; env: Readonly<EnvMap> },
): Promise<{
  title?: string;
  role?: string;
  buttons?: string[];
  action?: string;
  bundleId?: string;
}> {
  const args = ['alert', action];
  appendMacOsHelperContextArgs(args, options);
  return await runMacOsHelper(box, args, { env: options.env });
}

export async function runMacOsSnapshotAction(
  box: MacOsToolbox,
  surface: MacOsHelperSurface,
  options: { bundleId?: string; signal?: AbortSignal; env: Readonly<EnvMap> },
): Promise<{
  surface: SessionSurface;
  nodes: MacOsSnapshotNode[];
  truncated: boolean;
  backend: 'macos-helper';
  /** Set when the app's Chromium accessibility tree could not be turned on in time. */
  warnings?: string[];
}> {
  const args = ['snapshot', '--surface', surface];
  appendMacOsHelperContextArgs(args, options);
  return await runMacOsHelper(box, args, { signal: options.signal, env: options.env });
}

export async function runMacOsReadTextAction(
  box: MacOsToolbox,
  x: number,
  y: number,
  options: {
    surface: MacOsHelperSurface;
    bundleId?: string;
    signal?: AbortSignal;
    env: Readonly<EnvMap>;
  },
): Promise<{
  text: string;
}> {
  const args = ['read', '--x', String(x), '--y', String(y)];
  appendMacOsHelperContextArgs(args, options);
  return await runMacOsHelper(box, args, { signal: options.signal, env: options.env });
}

// Mirrors the helper's own floors (`MouseClickSchedule.swift`): the schedule the helper runs
// is derived from the same numbers, so the timeout that must outlast it is derived here too.
const MACOS_CLICK_MINIMUM_HOLD_MS = 40;
const MACOS_CLICK_DEFAULT_HOLD_MS = 60;
const MACOS_CLICK_PAIR_GAP_MS = 80;
const MACOS_CLICK_DEFAULT_INTERVAL_MS = 120;

/**
 * How long the helper stays busy posting one press request: every hold plus every gap,
 * exactly as `mouseClickScheduleMs` in the helper sums them. Every path that runs a click
 * schedule sets its process timeout from this, because a helper killed mid-hold would leave
 * the system's mouse button down.
 */
export function macOsClickScheduleMs(options: {
  holdMs?: number;
  clicks?: number;
  doubleClick?: boolean;
  intervalMs?: number;
}): number {
  const hold =
    options.holdMs && options.holdMs > 0
      ? Math.max(options.holdMs, MACOS_CLICK_MINIMUM_HOLD_MS)
      : MACOS_CLICK_DEFAULT_HOLD_MS;
  const clicks = Math.max(options.clicks ?? 1, 1);
  const interval = Math.max(options.intervalMs ?? MACOS_CLICK_DEFAULT_INTERVAL_MS, 0);
  const perPress = options.doubleClick ? 2 * hold + MACOS_CLICK_PAIR_GAP_MS : hold;
  return clicks * perPress + (clicks - 1) * interval;
}

export async function runMacOsPressAction(
  box: MacOsToolbox,
  x: number,
  y: number,
  options: {
    surface: MacOsHelperSurface;
    bundleId?: string;
    holdMs?: number;
    /** Independent presses, each a single click; `--count` on every platform. */
    clicks?: number;
    /** Post each press as a double-click pair; `--double-tap`. */
    doubleClick?: boolean;
    intervalMs?: number;
    signal?: AbortSignal;
    env: Readonly<EnvMap>;
  },
): Promise<{
  x: number;
  y: number;
  holdMs?: number;
  clicks?: number;
  doubleClick?: boolean;
  bundleId?: string;
  surface?: SessionSurface;
  mechanism?: MacOsDeliveryMechanism;
  /** The window the helper acted in, for an app-surface press. */
  windowTitle?: string;
}> {
  const args = ['press', '--x', String(x), '--y', String(y)];
  if (options.holdMs && options.holdMs > 0) {
    args.push('--hold-ms', String(options.holdMs));
  }
  const clicks = options.clicks ?? 1;
  if (clicks > 1) {
    args.push('--clicks', String(clicks));
    // An explicit zero is a request for back-to-back presses, not an unset interval.
    if (options.intervalMs !== undefined) {
      args.push('--interval-ms', String(Math.max(options.intervalMs, 0)));
    }
  }
  if (options.doubleClick) {
    args.push('--double-click');
  }
  appendMacOsHelperContextArgs(args, options);
  appendGhostCursorArg(args, options.surface, options.env);
  return await runMacOsHelper(box, args, {
    signal: options.signal,
    env: options.env,
    timeoutMs: macOsClickScheduleMs(options) + MACOS_HELPER_TIMEOUT_MS + ghostCursorBudgetMs(args),
  });
}

/** Inserts text at the app session's focused element without activating the app. */
export async function runMacOsTypeAction(
  box: MacOsToolbox,
  text: string,
  options: {
    bundleId: string;
    delayMs?: number;
    signal?: AbortSignal;
    env: Readonly<EnvMap>;
  },
): Promise<{ mechanism?: MacOsDeliveryMechanism; role?: string; windowTitle?: string }> {
  const args = ['type', '--text', text];
  if (options.delayMs && options.delayMs > 0) args.push('--delay-ms', String(options.delayMs));
  appendMacOsHelperContextArgs(args, { bundleId: options.bundleId });
  appendGhostCursorArg(args, 'app', options.env);
  return await runMacOsHelper(box, args, {
    signal: options.signal,
    env: options.env,
    timeoutMs:
      MACOS_HELPER_TIMEOUT_MS + ghostCursorBudgetMs(args) + text.length * (options.delayMs ?? 0),
  });
}

/** Dispatches one prepared app-surface action with the ghost-cursor settle budget added. */
function runMacOsAppSurfaceAction<T extends Record<string, unknown>>(
  box: MacOsToolbox,
  args: string[],
  options: { bundleId: string; signal?: AbortSignal; env: Readonly<EnvMap> },
): Promise<T> {
  appendMacOsHelperContextArgs(args, { bundleId: options.bundleId });
  appendGhostCursorArg(args, 'app', options.env);
  return runMacOsHelper<T>(box, args, {
    signal: options.signal,
    env: options.env,
    timeoutMs: MACOS_HELPER_TIMEOUT_MS + ghostCursorBudgetMs(args),
  });
}

/** Replaces the value of the app session's text input at a point. */
export async function runMacOsFillAction(
  box: MacOsToolbox,
  x: number,
  y: number,
  text: string,
  options: { bundleId: string; signal?: AbortSignal; env: Readonly<EnvMap> },
): Promise<{ mechanism?: MacOsDeliveryMechanism; role?: string; windowTitle?: string }> {
  return await runMacOsAppSurfaceAction(
    box,
    ['fill', '--x', String(x), '--y', String(y), '--text', text],
    options,
  );
}

/** Opens the context menu of the app session's element at a point, as a secondary click does. */
export async function runMacOsShowMenuAction(
  box: MacOsToolbox,
  x: number,
  y: number,
  options: { bundleId: string; signal?: AbortSignal; env: Readonly<EnvMap> },
): Promise<{ mechanism?: MacOsDeliveryMechanism; role?: string; windowTitle?: string }> {
  return await runMacOsAppSurfaceAction(
    box,
    ['show-menu', '--x', String(x), '--y', String(y)],
    options,
  );
}

/** Scrolls the scroll area at the center of the app session's front window. */
export async function runMacOsScrollAction(
  box: MacOsToolbox,
  direction: 'up' | 'down' | 'left' | 'right',
  options: {
    bundleId: string;
    amount?: number;
    pixels?: number;
    signal?: AbortSignal;
    env: Readonly<EnvMap>;
  },
): Promise<Record<string, unknown>> {
  const args = ['scroll', '--direction', direction];
  if (options.amount !== undefined) args.push('--amount', String(options.amount));
  if (options.pixels !== undefined) args.push('--pixels', String(options.pixels));
  return await runMacOsAppSurfaceAction(box, args, options);
}

export async function runMacOsScreenshotAction(
  box: MacOsToolbox,
  outPath: string,
  options: {
    surface: MacOsHelperSurface;
    bundleId?: string;
    signal?: AbortSignal;
    env: Readonly<EnvMap>;
  },
): Promise<{
  path: string;
  surface?: SessionSurface;
}> {
  const args = ['screenshot', '--out', outPath];
  appendMacOsHelperContextArgs(args, options);
  return await withMacOsScreenCaptureLock(
    box,
    options,
    async () => await runMacOsHelper(box, args, { signal: options.signal, env: options.env }),
  );
}

/**
 * ScreenCaptureKit fails or hangs window captures that two processes start at the same time
 * (measured on macOS 27 with two helpers capturing two apps), so every helper capture on this Mac
 * runs alone, whichever daemon asks. The lock sits in the host-global device claims directory,
 * the store every daemon on the host already coordinates through. The host takes the claim, so
 * the owner it records is the process that runs the capture.
 */
async function withMacOsScreenCaptureLock<T>(
  box: MacOsToolbox,
  options: { env: Readonly<EnvMap>; signal?: AbortSignal },
  task: () => Promise<T>,
): Promise<T> {
  const lockRoot = resolveDeviceClaimRoot(options.env);
  await ensureHostDirectory(lockRoot);
  return await box.host.processes.withLock({
    lockDirPath: path.join(path.resolve(lockRoot), 'macos-screen-capture.lock'),
    timeoutMs: MACOS_HELPER_TIMEOUT_MS + 5_000,
    description: 'the macOS screen capture lock',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    task,
  });
}
