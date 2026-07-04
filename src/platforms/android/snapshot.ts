import fs from 'node:fs/promises';
import path from 'node:path';
import { withRetry } from '../../utils/retry.ts';
import { AppError, normalizeError, toAppErrorCode } from '../../kernel/errors.ts';
import { emitDiagnostic, withDiagnosticTimer } from '../../utils/diagnostics.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import { findProjectRoot, readVersion } from '../../utils/version.ts';
import {
  attachRefs,
  type HiddenContentHint,
  type RawSnapshotNode,
  type SnapshotOptions,
} from '../../kernel/snapshot.ts';
import { isScrollableType } from '../../utils/scrollable.ts';
import { deriveMobileSnapshotHiddenContentHints } from '../../snapshot/mobile-snapshot-semantics.ts';
import {
  buildUiHierarchySnapshot,
  parseUiHierarchy,
  parseUiHierarchyTree,
  type AndroidBuiltSnapshot,
  type AndroidSnapshotAnalysis,
  type AndroidUiHierarchy,
} from './ui-hierarchy.ts';
import {
  androidAdbResultError,
  classifyAdbFailure,
  resolveAndroidAdbExecutor,
  resolveAndroidAdbProvider,
  type AndroidAdbProvider,
} from './adb-executor.ts';
import { sleep } from './adb.ts';
import { deriveAndroidScrollableContentHints } from './scroll-hints.ts';
import {
  captureAndroidSnapshotWithHelper,
  captureAndroidSnapshotWithHelperSession,
  ANDROID_SNAPSHOT_HELPER_WAIT_FOR_IDLE_TIMEOUT_MS,
  ensureAndroidSnapshotHelper,
  forgetAndroidSnapshotHelperInstall,
  getAndroidSnapshotHelperSessionDeviceKey,
  parseAndroidSnapshotHelperManifest,
  stopAndroidSnapshotHelperSession,
  type AndroidAdbExecutor,
  type AndroidSnapshotHelperArtifact,
  type AndroidSnapshotHelperInstallPolicy,
  type AndroidSnapshotHelperInstallResult,
  type AndroidSnapshotHelperOutput,
} from './snapshot-helper.ts';
import type { AndroidSnapshotBackendMetadata } from './snapshot-types.ts';
import {
  classifyAndroidHelperContentRecovery,
  type AndroidHelperContentRecoveryDecision,
} from './snapshot-content-recovery.ts';

const UI_HIERARCHY_DUMP_TIMEOUT_MS = 8_000;
const HELPER_INSTALL_TIMEOUT_MS = 30_000;
const HELPER_CAPTURE_TIMEOUT_MS = 5_000;
const HELPER_COMMAND_TIMEOUT_MS = 30_000;
const HELPER_RUNTIME_RESET_DELAY_MS = 150;
const HELPER_RUNTIME_RESET_TIMEOUT_MS = 2_000;
// Transient adb transport families (device offline/not found, transport error,
// connection reset, broken pipe) come from the shared classifier; these extras
// are snapshot-specific races (dump timeouts, dump-file reads) worth retrying.
const SNAPSHOT_ONLY_RETRYABLE_ADB_STDERR_PATTERNS = [
  'timed out',
  'no such file or directory',
] as const;

export type AndroidSnapshotOptions = SnapshotOptions & {
  appBundleId?: string;
  helperArtifact?: AndroidSnapshotHelperArtifact;
  helperInstallPolicy?: AndroidSnapshotHelperInstallPolicy;
  helperSessionScope?: 'command' | 'daemon-session';
  helperAdb?: AndroidAdbExecutor | AndroidAdbProvider;
  helperWaitForIdleTimeoutMs?: number;
  includeHiddenContentHints?: boolean;
};

export async function captureAndroidUiHierarchyXml(
  device: DeviceInfo,
  options: AndroidSnapshotOptions = {},
): Promise<string> {
  const adb = resolveAndroidAdbProvider(device, options.helperAdb).exec;
  return (await captureAndroidUiHierarchy(device, options, adb)).xml;
}

export async function snapshotAndroid(
  device: DeviceInfo,
  options: AndroidSnapshotOptions = {},
): Promise<{
  nodes: RawSnapshotNode[];
  truncated?: boolean;
  analysis: AndroidSnapshotAnalysis;
  androidSnapshot: AndroidSnapshotBackendMetadata;
}> {
  const adb = resolveAndroidAdbProvider(device, options.helperAdb).exec;
  const capture = await captureAndroidUiHierarchy(device, options, adb);
  const xml = capture.xml;
  const includeHiddenContentHints = options.includeHiddenContentHints !== false;
  if (!options.interactiveOnly) {
    const parsed = parseUiHierarchy(xml, undefined, options);
    const truncated = mergeAndroidSnapshotTruncation(parsed.truncated, capture.metadata);
    if (includeHiddenContentHints) {
      const nativeHints = await deriveScrollableContentHintsIfNeeded(
        device,
        parsed.nodes,
        xml,
        adb,
      );
      applyHiddenContentHintsToNodes(nativeHints, parsed.nodes);
    }
    return {
      ...parsed,
      ...androidSnapshotTruncationFields(truncated),
      androidSnapshot: capture.metadata,
    };
  }

  const tree = parseUiHierarchyTree(xml);
  const interactiveSnapshot = buildUiHierarchySnapshot(tree, undefined, options);
  const truncated = mergeAndroidSnapshotTruncation(interactiveSnapshot.truncated, capture.metadata);
  if (includeHiddenContentHints) {
    await applyHiddenContentHintsToInteractiveSnapshot({
      device,
      options,
      tree,
      xml,
      adb,
      interactiveSnapshot,
    });
  }
  const { sourceNodes: _sourceNodes, ...snapshot } = interactiveSnapshot;
  return {
    ...snapshot,
    ...androidSnapshotTruncationFields(truncated),
    androidSnapshot: capture.metadata,
  };
}

function mergeAndroidSnapshotTruncation(
  snapshotTruncated: boolean | undefined,
  metadata: AndroidSnapshotBackendMetadata,
): boolean | undefined {
  return snapshotTruncated === true || metadata.helperTruncated === true ? true : snapshotTruncated;
}

function androidSnapshotTruncationFields(
  truncated: boolean | undefined,
): { truncated: true } | Record<string, never> {
  return truncated === true ? { truncated: true } : {};
}

async function applyHiddenContentHintsToInteractiveSnapshot(params: {
  device: DeviceInfo;
  options: AndroidSnapshotOptions;
  tree: AndroidUiHierarchy;
  xml: string;
  adb: AndroidAdbExecutor;
  interactiveSnapshot: AndroidBuiltSnapshot;
}): Promise<void> {
  if (
    collectExistingHiddenContentHints(params.interactiveSnapshot.nodes).size > 0 ||
    hasAndroidScrollActionAttributes(params.xml)
  ) {
    return;
  }

  const fullSnapshot = buildUiHierarchySnapshot(params.tree, undefined, {
    ...params.options,
    interactiveOnly: false,
  });
  const nativeHints = await deriveScrollableContentHintsIfNeeded(
    params.device,
    fullSnapshot.nodes,
    params.xml,
    params.adb,
  );
  applyHiddenContentHintsToInteractiveNodes(nativeHints, fullSnapshot, params.interactiveSnapshot);
  if (nativeHints.size === 0) {
    const presentationHints = deriveMobileSnapshotHiddenContentHints(
      attachRefs(fullSnapshot.nodes),
    );
    applyHiddenContentHintsToInteractiveNodes(
      presentationHints,
      fullSnapshot,
      params.interactiveSnapshot,
    );
  }
}

async function captureAndroidUiHierarchy(
  device: DeviceInfo,
  options: AndroidSnapshotOptions,
  adb: AndroidAdbExecutor,
): Promise<{ xml: string; metadata: AndroidSnapshotBackendMetadata }> {
  const helper = await withDiagnosticTimer(
    'android_snapshot_helper_artifact_resolution',
    async () => await resolveAndroidSnapshotHelperArtifact(options.helperArtifact),
  );
  if (helper.artifact) {
    return await captureAndroidUiHierarchyWithHelper(device, options, adb, helper.artifact);
  }

  emitDiagnostic({
    level: helper.fallbackReason ? 'warn' : 'info',
    phase: 'android_snapshot_helper_unavailable',
    data: { reason: helper.fallbackReason ?? 'artifact_not_found' },
  });
  return await captureStockUiHierarchy(device, helper.fallbackReason, adb);
}

async function captureAndroidUiHierarchyWithHelper(
  device: DeviceInfo,
  options: AndroidSnapshotOptions,
  adb: AndroidAdbExecutor,
  artifact: AndroidSnapshotHelperArtifact,
): Promise<{ xml: string; metadata: AndroidSnapshotBackendMetadata }> {
  const helperDeviceKey = getAndroidSnapshotHelperSessionDeviceKey(device);
  const adbProvider = resolveAndroidAdbProvider(device, options.helperAdb);
  const commandScopedHelperSession = options.helperSessionScope !== 'daemon-session';
  try {
    const install = await installAndroidSnapshotHelper(
      options,
      adb,
      adbProvider,
      artifact,
      helperDeviceKey,
    );
    if (install.installed) {
      await stopAndroidSnapshotHelperSession(helperDeviceKey);
    }
    const capture = await captureAndroidUiHierarchyFromHelper({
      options,
      adb,
      adbProvider,
      artifact,
      helperDeviceKey,
    });
    const helperCapture = formatAndroidHelperCaptureResult(capture, artifact, install.reason);
    const contentRecovery = classifyAndroidHelperContentRecovery(
      helperCapture.xml,
      helperCapture.metadata,
      { foregroundAppPackage: options.appBundleId },
    );
    if (!contentRecovery) return helperCapture;
    return await recoverAndroidHelperContentUnavailable({
      contentRecovery,
      helperDeviceKey,
      artifact,
      device,
      adb,
    });
  } catch (error) {
    return await recoverAndroidHelperCaptureFailure({
      error,
      helperDeviceKey,
      artifact,
      device,
      adb,
    });
  } finally {
    if (commandScopedHelperSession) {
      await stopAndroidSnapshotHelperSession(helperDeviceKey);
    }
  }
}

async function installAndroidSnapshotHelper(
  options: AndroidSnapshotOptions,
  adb: AndroidAdbExecutor,
  adbProvider: AndroidAdbProvider,
  artifact: AndroidSnapshotHelperArtifact,
  deviceKey: string,
): Promise<AndroidSnapshotHelperInstallResult> {
  const install = await withDiagnosticTimer(
    'android_snapshot_helper_install',
    async () =>
      await ensureAndroidSnapshotHelper({
        adb,
        adbProvider,
        artifact,
        deviceKey,
        installPolicy: options.helperInstallPolicy,
        timeoutMs: HELPER_INSTALL_TIMEOUT_MS,
      }),
    {
      packageName: artifact.manifest.packageName,
      versionCode: artifact.manifest.versionCode,
      installPolicy: options.helperInstallPolicy ?? 'missing-or-outdated',
    },
  );
  emitDiagnostic({
    phase: 'android_snapshot_helper_install_decision',
    data: {
      packageName: install.packageName,
      versionCode: install.versionCode,
      installedVersionCode: install.installedVersionCode,
      installed: install.installed,
      reason: install.reason,
    },
  });
  return install;
}

async function captureAndroidUiHierarchyFromHelper(params: {
  options: AndroidSnapshotOptions;
  adb: AndroidAdbExecutor;
  adbProvider: AndroidAdbProvider;
  artifact: AndroidSnapshotHelperArtifact;
  helperDeviceKey: string;
}): Promise<AndroidSnapshotHelperOutput> {
  const { options, adb, adbProvider, artifact, helperDeviceKey } = params;
  const captureOptions = {
    adb,
    adbProvider,
    deviceKey: helperDeviceKey,
    helperVersion: artifact.manifest.version,
    helperVersionCode: artifact.manifest.versionCode,
    packageName: artifact.manifest.packageName,
    instrumentationRunner: artifact.manifest.instrumentationRunner,
    waitForIdleTimeoutMs:
      options.helperWaitForIdleTimeoutMs ?? ANDROID_SNAPSHOT_HELPER_WAIT_FOR_IDLE_TIMEOUT_MS,
    timeoutMs: HELPER_CAPTURE_TIMEOUT_MS,
    commandTimeoutMs: HELPER_COMMAND_TIMEOUT_MS,
  };
  try {
    const sessionCapture = await withDiagnosticTimer(
      'android_snapshot_helper_session_capture',
      async () => await captureAndroidSnapshotWithHelperSession(captureOptions),
      {
        packageName: artifact.manifest.packageName,
        version: artifact.manifest.version,
        timeoutMs: HELPER_CAPTURE_TIMEOUT_MS,
      },
    );
    if (sessionCapture) return sessionCapture;
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'android_snapshot_helper_session_fallback',
      data: { reason: normalizeError(error).message },
    });
    await resetAndroidSnapshotHelperRuntime(adb, artifact.manifest.packageName);
  }
  return await withDiagnosticTimer(
    'android_snapshot_helper_capture',
    async () => await captureAndroidSnapshotWithHelper(captureOptions),
    {
      packageName: artifact.manifest.packageName,
      version: artifact.manifest.version,
      timeoutMs: HELPER_CAPTURE_TIMEOUT_MS,
      commandTimeoutMs: HELPER_COMMAND_TIMEOUT_MS,
    },
  );
}

function formatAndroidHelperCaptureResult(
  capture: AndroidSnapshotHelperOutput,
  artifact: AndroidSnapshotHelperArtifact,
  installReason: AndroidSnapshotHelperInstallResult['reason'],
): { xml: string; metadata: AndroidSnapshotBackendMetadata } {
  return {
    xml: capture.xml,
    metadata: {
      backend: 'android-helper',
      helperVersion: artifact.manifest.version,
      helperApiVersion: capture.metadata.helperApiVersion,
      helperTransport: capture.metadata.transport,
      helperSessionReused: capture.metadata.sessionReused,
      installReason,
      waitForIdleTimeoutMs: capture.metadata.waitForIdleTimeoutMs,
      waitForIdleQuietMs: capture.metadata.waitForIdleQuietMs,
      timeoutMs: capture.metadata.timeoutMs,
      maxDepth: capture.metadata.maxDepth,
      maxNodes: capture.metadata.maxNodes,
      rootPresent: capture.metadata.rootPresent,
      captureMode: capture.metadata.captureMode,
      windowCount: capture.metadata.windowCount,
      nodeCount: capture.metadata.nodeCount,
      helperTruncated: capture.metadata.truncated,
      elapsedMs: capture.metadata.elapsedMs,
    },
  };
}

async function recoverAndroidHelperContentUnavailable(params: {
  contentRecovery: AndroidHelperContentRecoveryDecision;
  helperDeviceKey: string;
  artifact: AndroidSnapshotHelperArtifact;
  device: DeviceInfo;
  adb: AndroidAdbExecutor;
}): Promise<{ xml: string; metadata: AndroidSnapshotBackendMetadata }> {
  emitDiagnostic({
    level: 'warn',
    phase: 'android_snapshot_helper_content_fallback',
    data: {
      reason: params.contentRecovery.reason,
      fallbackReason: params.contentRecovery.fallbackReason,
      ...params.contentRecovery.diagnostics,
    },
  });
  await resetAndroidSnapshotHelperRuntime(params.adb, params.artifact.manifest.packageName);
  return await captureStockUiHierarchy(
    params.device,
    params.contentRecovery.fallbackReason,
    params.adb,
  );
}

async function recoverAndroidHelperCaptureFailure(params: {
  error: unknown;
  helperDeviceKey: string;
  artifact: AndroidSnapshotHelperArtifact;
  device: DeviceInfo;
  adb: AndroidAdbExecutor;
}): Promise<{ xml: string; metadata: AndroidSnapshotBackendMetadata }> {
  const busyError = formatAndroidSnapshotHelperBusyError(params.error);
  if (busyError) throw busyError;
  const fallbackReason = formatAndroidSnapshotHelperFallbackReason(params.error);
  emitDiagnostic({
    level: 'warn',
    phase: 'android_snapshot_helper_fallback',
    data: { reason: fallbackReason },
  });
  await stopAndroidSnapshotHelperSession(params.helperDeviceKey);
  await resetAndroidSnapshotHelperRuntime(params.adb, params.artifact.manifest.packageName);
  forgetAndroidSnapshotHelperInstall({
    deviceKey: params.helperDeviceKey,
    packageName: params.artifact.manifest.packageName,
    versionCode: params.artifact.manifest.versionCode,
  });
  return await captureStockUiHierarchy(params.device, fallbackReason, params.adb);
}

async function resetAndroidSnapshotHelperRuntime(
  adb: AndroidAdbExecutor,
  packageName: string,
): Promise<void> {
  try {
    await adb(['shell', 'am', 'force-stop', packageName], {
      allowFailure: true,
      timeoutMs: HELPER_RUNTIME_RESET_TIMEOUT_MS,
    });
    await sleep(HELPER_RUNTIME_RESET_DELAY_MS);
    emitDiagnostic({
      level: 'debug',
      phase: 'android_snapshot_helper_runtime_reset',
      data: { packageName },
    });
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'android_snapshot_helper_runtime_reset_failed',
      data: { packageName, error: normalizeError(error).message },
    });
  }
}

function formatAndroidSnapshotHelperFallbackReason(error: unknown): string {
  const normalized = normalizeError(error);
  const helperMessage = readHelperMessage(normalized.details?.helper);
  if (helperMessage && helperMessage !== normalized.message) {
    return `${normalized.message}: ${helperMessage}`;
  }
  if (helperMessage) return helperMessage;
  const stderr =
    typeof normalized.details?.stderr === 'string' ? normalized.details.stderr.trim() : '';
  const firstLine = stderr.split(/\r?\n/).find((line) => line.trim());
  return firstLine ? `${normalized.message}: ${firstLine}` : normalized.message;
}

function formatAndroidSnapshotHelperBusyError(error: unknown): AppError | undefined {
  const normalized = normalizeError(error);
  if (
    !isStructuredHelperTimeout(normalized.details?.helper, normalized.message) &&
    !isKilledHelperInstrumentationFailure(normalized)
  ) {
    return undefined;
  }
  const reason = formatAndroidSnapshotHelperFallbackReason(error);
  const hint =
    'Android accessibility snapshots can be blocked by busy or continuously changing app UI. Use screenshot as visual truth after this timeout and report the busy UI if it persists.';
  return new AppError(
    toAppErrorCode(normalized.code),
    `${reason}. Stock UIAutomator fallback was skipped because this usually means the Android accessibility tree is busy or stalled.`,
    {
      ...normalized.details,
      hint,
    },
    error,
  );
}

function isKilledHelperInstrumentationFailure(error: {
  message: string;
  details?: Record<string, unknown>;
}): boolean {
  if (error.details?.exitCode !== 137) return false;
  return /Android snapshot helper (failed before returning parseable output|output could not be parsed)/.test(
    error.message,
  );
}

function readHelperMessage(helper: unknown): string | undefined {
  if (!helper || typeof helper !== 'object' || !('message' in helper)) return undefined;
  const message = String(helper.message).trim();
  return message && message !== 'null' ? message : undefined;
}

function isStructuredHelperTimeout(helper: unknown, fallbackMessage: string): boolean {
  if (!helper || typeof helper !== 'object') return false;
  const errorType = 'errorType' in helper ? String(helper.errorType) : '';
  const message = readHelperMessage(helper) ?? fallbackMessage;
  return /TimeoutException/.test(errorType) || /timed out/i.test(message);
}

async function resolveAndroidSnapshotHelperArtifact(
  explicitArtifact?: AndroidSnapshotHelperArtifact,
): Promise<{ artifact?: AndroidSnapshotHelperArtifact; fallbackReason?: string }> {
  if (explicitArtifact) {
    return { artifact: explicitArtifact };
  }

  const version = readVersion();
  const helperDir = path.join(findProjectRoot(), 'android-snapshot-helper', 'dist');
  const manifestPath = path.join(
    helperDir,
    `agent-device-android-snapshot-helper-${version}.manifest.json`,
  );

  try {
    await fs.access(manifestPath);
  } catch {
    return {};
  }

  try {
    const manifest = parseAndroidSnapshotHelperManifest(
      JSON.parse(await fs.readFile(manifestPath, 'utf8')),
    );
    const apkPath = path.join(
      helperDir,
      manifest.assetName ?? `agent-device-android-snapshot-helper-${manifest.version}.apk`,
    );
    await fs.access(apkPath);
    return { artifact: { apkPath, manifest } };
  } catch (error) {
    return { fallbackReason: normalizeError(error).message };
  }
}

async function captureStockUiHierarchy(
  device: DeviceInfo,
  fallbackReason?: string,
  adb?: AndroidAdbExecutor,
): Promise<{ xml: string; metadata: AndroidSnapshotBackendMetadata }> {
  let xml: string;
  try {
    xml = await withDiagnosticTimer(
      'android_snapshot_stock_capture',
      async () => await dumpUiHierarchy(device, adb),
      {
        fallbackReason,
        timeoutMs: UI_HIERARCHY_DUMP_TIMEOUT_MS,
      },
    );
  } catch (error) {
    if (fallbackReason) {
      throw enrichStockSnapshotFailureWithHelperReason(error, fallbackReason);
    }
    throw error;
  }
  return {
    xml,
    metadata: {
      backend: 'uiautomator-dump',
      ...(fallbackReason ? { fallbackReason } : {}),
    },
  };
}

function enrichStockSnapshotFailureWithHelperReason(
  error: unknown,
  fallbackReason: string,
): AppError {
  const normalized = normalizeError(error);
  return new AppError(
    toAppErrorCode(normalized.code),
    `${normalized.message} Android snapshot helper failed before stock fallback: ${fallbackReason}`,
    {
      ...normalized.details,
      androidSnapshotHelperFallbackReason: fallbackReason,
      ...(normalized.hint ? { hint: normalized.hint } : {}),
    },
    error,
  );
}

async function deriveScrollableContentHintsIfNeeded(
  device: DeviceInfo,
  nodes: RawSnapshotNode[],
  xml: string,
  adb?: AndroidAdbExecutor,
): Promise<Map<number, HiddenContentHint>> {
  if (!nodes.some((node) => isScrollableType(node.type))) {
    return new Map();
  }
  const existingHints = collectExistingHiddenContentHints(nodes);
  if (existingHints.size > 0 || hasAndroidScrollActionAttributes(xml)) {
    return existingHints;
  }
  const activityTopDump = await dumpActivityTop(device, adb);
  if (!activityTopDump) {
    return new Map();
  }
  return deriveAndroidScrollableContentHints(nodes, activityTopDump);
}

function hasAndroidScrollActionAttributes(xml: string): boolean {
  return xml.includes(' can-scroll-forward=') || xml.includes(' can-scroll-backward=');
}

function collectExistingHiddenContentHints(
  nodes: RawSnapshotNode[],
): Map<number, HiddenContentHint> {
  const hintsByIndex = new Map<number, HiddenContentHint>();
  for (const node of nodes) {
    const hint: HiddenContentHint = {};
    if (node.hiddenContentAbove) {
      hint.hiddenContentAbove = true;
    }
    if (node.hiddenContentBelow) {
      hint.hiddenContentBelow = true;
    }
    if (hint.hiddenContentAbove || hint.hiddenContentBelow) {
      hintsByIndex.set(node.index, hint);
    }
  }
  return hintsByIndex;
}

export async function dumpUiHierarchy(
  device: DeviceInfo,
  adb = resolveAndroidAdbExecutor(device),
): Promise<string> {
  try {
    return await withRetry(() => dumpUiHierarchyOnce(adb), {
      shouldRetry: isRetryableAdbError,
    });
  } catch (error) {
    if (isUiHierarchyDumpTimeout(error)) {
      const hint =
        'Android accessibility snapshots can be blocked by busy or continuously changing app UI. Use screenshot as visual truth after this timeout. Stock Android UIAutomator may still time out on app-owned infinite animations.';
      throw new AppError(
        'COMMAND_FAILED',
        `Android UI hierarchy dump timed out while waiting for the UI to become idle. ${hint}`,
        {
          ...(error.details ?? {}),
          hint,
        },
        error,
      );
    }
    throw error;
  }
}

async function dumpUiHierarchyOnce(adb: AndroidAdbExecutor): Promise<string> {
  // Preferred: stream XML directly to stdout, avoiding file I/O race conditions.
  const streamed = await adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], {
    allowFailure: true,
    timeoutMs: UI_HIERARCHY_DUMP_TIMEOUT_MS,
  });
  const fromStream = extractUiDumpXml(streamed.stdout, streamed.stderr);
  if (fromStream) return fromStream;

  // Fallback: dump to file and read back.
  // If `cat` fails with "no such file", the outer withRetry (via isRetryableAdbError) handles it.
  const dumpPath = '/sdcard/window_dump.xml';
  const dumpResult = await adb(['shell', 'uiautomator', 'dump', dumpPath], {
    allowFailure: true,
    timeoutMs: UI_HIERARCHY_DUMP_TIMEOUT_MS,
  });
  const reportedPath = readDumpPath(dumpResult.stdout, dumpResult.stderr);
  if (dumpResult.exitCode !== 0 && !reportedPath) {
    throw androidAdbResultError('uiautomator dump did not return XML', dumpResult, {
      reason: 'missing_fresh_dump',
    });
  }
  const actualPath = reportedPath ?? dumpPath;

  const result = await adb(['shell', 'cat', actualPath]);
  const xml = extractUiDumpXml(result.stdout, result.stderr);
  if (!xml) {
    throw new AppError('COMMAND_FAILED', 'uiautomator dump did not return XML', {
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return xml;
}

function readDumpPath(stdout: string, stderr: string): string | undefined {
  const text = `${stdout}\n${stderr}`;
  const match = /dumped to:\s*(\S+)/i.exec(text);
  return match?.[1];
}

function extractUiDumpXml(stdout: string, stderr: string): string | null {
  const text = `${stdout}\n${stderr}`;
  const start = text.indexOf('<?xml');
  const hierarchyStart = start >= 0 ? start : text.indexOf('<hierarchy');
  if (hierarchyStart < 0) return null;
  const end = text.lastIndexOf('</hierarchy>');
  if (end < 0 || end < hierarchyStart) return null;
  const xml = text.slice(hierarchyStart, end + '</hierarchy>'.length).trim();
  return xml.length > 0 ? xml : null;
}

function isRetryableAdbError(err: unknown): boolean {
  if (!(err instanceof AppError)) return false;
  if (err.code !== 'COMMAND_FAILED') return false;
  const rawStderr = err.details?.stderr;
  const stderr = (typeof rawStderr === 'string' ? rawStderr : '').toLowerCase();
  if (classifyAdbFailure(stderr)?.retriable === true) return true;
  return SNAPSHOT_ONLY_RETRYABLE_ADB_STDERR_PATTERNS.some((pattern) => stderr.includes(pattern));
}

function isUiHierarchyDumpTimeout(err: unknown): err is AppError {
  if (!(err instanceof AppError)) return false;
  if (err.code !== 'COMMAND_FAILED') return false;
  const timeoutMs = err.details?.timeoutMs;
  if (typeof timeoutMs !== 'number') return false;
  return err.details?.cmd === 'adb' && isUiAutomatorDumpArgs(err.details?.args);
}

function isUiAutomatorDumpArgs(rawArgs: unknown): boolean {
  const args = Array.isArray(rawArgs)
    ? rawArgs.map(String)
    : typeof rawArgs === 'string'
      ? rawArgs.split(/\s+/)
      : [];
  return args.includes('uiautomator') && args.includes('dump');
}

async function dumpActivityTop(
  device: DeviceInfo,
  adb = resolveAndroidAdbExecutor(device),
): Promise<string | null> {
  try {
    const result = await adb(['shell', 'dumpsys', 'activity', 'top'], {
      allowFailure: true,
      timeoutMs: 8_000,
    });
    const text = `${result.stdout}\n${result.stderr}`.trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

function applyHiddenContentHintsToInteractiveNodes(
  hintsByFullNodeIndex: ReadonlyMap<number, HiddenContentHint>,
  fullSnapshot: AndroidBuiltSnapshot,
  interactiveSnapshot: AndroidBuiltSnapshot,
): void {
  if (hintsByFullNodeIndex.size === 0) {
    return;
  }

  // Both snapshots come from one parsed hierarchy, so source node identity is the stable bridge
  // between full geometry context and the pruned interactive output.
  const interactiveNodesBySource = new Map<AndroidUiHierarchy, RawSnapshotNode>();
  for (const [index, sourceNode] of interactiveSnapshot.sourceNodes.entries()) {
    const node = interactiveSnapshot.nodes[index];
    if (node) {
      interactiveNodesBySource.set(sourceNode, node);
    }
  }

  for (const [fullIndex, hint] of hintsByFullNodeIndex) {
    const sourceNode = fullSnapshot.sourceNodes[fullIndex];
    if (!sourceNode) {
      continue;
    }
    const interactiveNode = interactiveNodesBySource.get(sourceNode);
    if (!interactiveNode) {
      continue;
    }
    if (hint.hiddenContentAbove) {
      interactiveNode.hiddenContentAbove = true;
    }
    if (hint.hiddenContentBelow) {
      interactiveNode.hiddenContentBelow = true;
    }
  }
}

function applyHiddenContentHintsToNodes(
  hintsByIndex: ReadonlyMap<number, HiddenContentHint>,
  nodes: RawSnapshotNode[],
): void {
  for (const [index, hint] of hintsByIndex) {
    const node = nodes[index];
    if (!node) {
      continue;
    }
    if (hint.hiddenContentAbove) {
      node.hiddenContentAbove = true;
    }
    if (hint.hiddenContentBelow) {
      node.hiddenContentBelow = true;
    }
  }
}
