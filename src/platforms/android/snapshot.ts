import fs from 'node:fs/promises';
import path from 'node:path';
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

const HELPER_INSTALL_TIMEOUT_MS = 30_000;
const HELPER_CAPTURE_TIMEOUT_MS = 5_000;
const HELPER_COMMAND_TIMEOUT_MS = 30_000;
const HELPER_RUNTIME_RESET_DELAY_MS = 150;
const HELPER_RUNTIME_RESET_TIMEOUT_MS = 2_000;
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
  const adbProvider = resolveAndroidAdbProvider(device, options.helperAdb);
  const helper = await withDiagnosticTimer(
    'android_snapshot_helper_artifact_resolution',
    async () =>
      await resolveAndroidSnapshotHelperArtifact(
        options.helperArtifact ?? adbProvider.snapshotHelperArtifact,
      ),
  );
  if (helper.artifact) {
    return await captureAndroidUiHierarchyWithHelper(device, options, adb, helper.artifact);
  }

  emitDiagnostic({
    level: 'error',
    phase: 'android_snapshot_helper_unavailable',
    data: { reason: helper.errorReason ?? 'artifact_not_found' },
  });
  throw androidSnapshotHelperUnavailableError(helper.errorReason);
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
    let helperCapture: { xml: string; metadata: AndroidSnapshotBackendMetadata };
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
      helperCapture = formatAndroidHelperCaptureResult(capture, artifact, install.reason);
    } catch (error) {
      return await rejectAndroidHelperCaptureFailure({
        error,
        helperDeviceKey,
        artifact,
        adb,
      });
    }

    const contentRecovery = classifyAndroidHelperContentRecovery(
      helperCapture.xml,
      helperCapture.metadata,
      { foregroundAppPackage: options.appBundleId },
    );
    if (!contentRecovery) return helperCapture;
    return await rejectAndroidHelperContentUnavailable({
      contentRecovery,
      helperDeviceKey,
      artifact,
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
      artifactSha256: artifact.manifest.sha256,
      installedSha256: install.installedSha256,
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

async function rejectAndroidHelperContentUnavailable(params: {
  contentRecovery: AndroidHelperContentRecoveryDecision;
  helperDeviceKey: string;
  artifact: AndroidSnapshotHelperArtifact;
  adb: AndroidAdbExecutor;
}): Promise<{ xml: string; metadata: AndroidSnapshotBackendMetadata }> {
  emitDiagnostic({
    level: 'error',
    phase: 'android_snapshot_helper_content_invalid',
    data: {
      reason: params.contentRecovery.reason,
      failureReason: params.contentRecovery.failureReason,
      ...params.contentRecovery.diagnostics,
    },
  });
  await resetAndroidSnapshotHelperRuntime(params.adb, params.artifact.manifest.packageName);
  throw new AppError('COMMAND_FAILED', params.contentRecovery.failureReason, {
    ...params.contentRecovery.diagnostics,
    androidSnapshotHelperFailureReason: params.contentRecovery.reason,
    retriable: true,
    hint: 'Retry after the app UI stabilizes. If this persists, capture a screenshot and report the helper diagnostics; agent-device does not substitute a second snapshot engine.',
  });
}

async function rejectAndroidHelperCaptureFailure(params: {
  error: unknown;
  helperDeviceKey: string;
  artifact: AndroidSnapshotHelperArtifact;
  adb: AndroidAdbExecutor;
}): Promise<{ xml: string; metadata: AndroidSnapshotBackendMetadata }> {
  const failureReason = formatAndroidSnapshotHelperFailureReason(params.error);
  emitDiagnostic({
    level: 'error',
    phase: 'android_snapshot_helper_failed',
    data: { reason: failureReason },
  });
  await stopAndroidSnapshotHelperSession(params.helperDeviceKey);
  await resetAndroidSnapshotHelperRuntime(params.adb, params.artifact.manifest.packageName);
  forgetAndroidSnapshotHelperInstall({
    deviceKey: params.helperDeviceKey,
    packageName: params.artifact.manifest.packageName,
    versionCode: params.artifact.manifest.versionCode,
  });
  throw androidSnapshotHelperCaptureError(params.error, failureReason);
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

function formatAndroidSnapshotHelperFailureReason(error: unknown): string {
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

function androidSnapshotHelperCaptureError(error: unknown, reason: string): AppError {
  const normalized = normalizeError(error);
  const busy =
    isStructuredHelperTimeout(normalized.details?.helper, normalized.message) ||
    isKilledHelperInstrumentationFailure(normalized);
  const hint = busy
    ? 'Android accessibility snapshots can be blocked by busy or continuously changing app UI. Use screenshot as visual truth after this timeout and report the busy UI if it persists.'
    : (normalized.hint ??
      'Retry once. If the helper still fails, run agent-device doctor and report the diagnostic log; agent-device does not substitute a second snapshot engine.');
  return new AppError(
    toAppErrorCode(normalized.code),
    `Android snapshot helper failed: ${reason}`,
    {
      ...normalized.details,
      androidSnapshotHelperFailureReason: reason,
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
): Promise<{ artifact?: AndroidSnapshotHelperArtifact; errorReason?: string }> {
  if (explicitArtifact) {
    return { artifact: explicitArtifact };
  }

  const version = readVersion();
  const helperDir = path.join(findProjectRoot(), 'android', 'snapshot-helper', 'dist');
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
    return { errorReason: normalizeError(error).message };
  }
}

function androidSnapshotHelperUnavailableError(errorReason: string | undefined): AppError {
  const reason = errorReason ?? 'the bundled helper artifact was not found';
  return new AppError('COMMAND_FAILED', `Android snapshot helper is unavailable: ${reason}`, {
    androidSnapshotHelperFailureReason: reason,
    hint: 'For a source checkout, run pnpm build:android. For a packaged install, reinstall agent-device; the Android snapshot helper must ship with the package.',
  });
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
