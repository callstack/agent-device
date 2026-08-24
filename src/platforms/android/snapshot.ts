import fs from 'node:fs/promises';
import path from 'node:path';
import {
  AppError,
  normalizeError,
  toAppErrorCode,
  type NormalizedError,
} from '@agent-device/kernel/errors';
import { emitDiagnostic, withDiagnosticTimer } from '../../utils/diagnostics.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { findProjectRoot, readVersion } from '../../utils/version.ts';
import {
  attachRefs,
  type HiddenContentHint,
  type RawSnapshotNode,
  type SnapshotOptions,
} from '@agent-device/kernel/snapshot';
import { deriveMobileSnapshotHiddenContentHints } from '../../snapshot/mobile-snapshot-semantics.ts';
import {
  buildUiHierarchySnapshot,
  parseUiHierarchyTree,
  type AndroidBuiltSnapshot,
  type AndroidUiHierarchySnapshotOptions,
  type AndroidUiHierarchy,
} from './ui-hierarchy.ts';
import { buildAndroidSnapshotClickabilityEvidence } from './snapshot-clickability.ts';
import { resolveAndroidAdbProvider, type AndroidAdbProvider } from './adb-executor.ts';
import { sleep } from './adb.ts';
import { buildAndroidSnapshotHelperCaptureOptions } from './snapshot-helper-capture.ts';
import {
  ANDROID_SNAPSHOT_HELPER_CAPTURE_TIMEOUT_MS,
  ANDROID_SNAPSHOT_HELPER_COMMAND_TIMEOUT_MS,
  type AndroidHelperSessionScope,
} from './snapshot-helper-types.ts';
import {
  captureAndroidSnapshotWithHelper,
  captureAndroidSnapshotWithHelperSession,
  ensureAndroidSnapshotHelper,
  forgetAndroidSnapshotHelperInstall,
  getAndroidSnapshotHelperSessionDeviceKey,
  isAndroidSnapshotHelperRetirementUnconfirmedError,
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
  classifyAndroidHelperContent,
  type AndroidHelperContentRecoveryDecision,
} from './snapshot-content-recovery.ts';
import type { AndroidContentRecoveryReason } from '@agent-device/contracts/platform';
import {
  resetAndroidSnapshotHelperRuntime,
  retireAndroidSnapshotHelperAfterContentFailure,
} from './snapshot-helper-runtime.ts';
import {
  ANDROID_SNAPSHOT_PRESENTATION_DEFAULT_DEADLINE_MS,
  isAndroidSnapshotPresentationFailure,
  type AndroidSnapshotPresentationFailure,
  type AndroidSnapshotPresentationOptions,
} from './snapshot-presentation.ts';
import { readAndroidSiblingOrder } from './ui-hierarchy-node.ts';
import { createAndroidSnapshotCapture, type AndroidSnapshotCapture } from './snapshot-capture.ts';

const HELPER_INSTALL_TIMEOUT_MS = 30_000;
/**
 * A content verdict means the capture mechanism worked but sampled a screen
 * mid-transition, which resolves on its own within a frame or two. Sampling
 * once turns that instant into a command failure, so re-capture a bounded
 * number of times before reporting the verdict.
 */
const HELPER_CONTENT_CAPTURE_ATTEMPTS = 3;
const HELPER_CONTENT_RECAPTURE_DELAY_MS = 250;
export type AndroidSnapshotOptions = SnapshotOptions & {
  appBundleId?: string;
  signal?: AbortSignal;
  helperArtifact?: AndroidSnapshotHelperArtifact;
  helperInstallPolicy?: AndroidSnapshotHelperInstallPolicy;
  helperSessionScope?: AndroidHelperSessionScope;
  helperAdb?: AndroidAdbExecutor | AndroidAdbProvider;
  includeHiddenContentHints?: boolean;
  androidPresentation?: AndroidSnapshotPresentationOptions;
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
): Promise<AndroidSnapshotCapture> {
  const adb = resolveAndroidAdbProvider(device, options.helperAdb).exec;
  const capture = await captureAndroidUiHierarchy(device, options, adb);
  const xml = capture.xml;
  const tree = parseUiHierarchyTree(xml);
  const androidSnapshot = withOcclusionScanDisclosure(capture.metadata, tree);
  const presentationOptions: AndroidUiHierarchySnapshotOptions = {
    ...options,
    androidPresentation: {
      ...options.androidPresentation,
      deadlineAtMs:
        options.androidPresentation?.deadlineAtMs ??
        Date.now() + ANDROID_SNAPSHOT_PRESENTATION_DEFAULT_DEADLINE_MS,
    },
  };

  try {
    const built = buildUiHierarchySnapshot(tree, undefined, presentationOptions);
    const truncated = mergeAndroidSnapshotTruncation(built.truncated, capture.metadata);
    if (options.interactiveOnly && options.includeHiddenContentHints !== false) {
      applyHiddenContentHintsToInteractiveSnapshot({
        options: presentationOptions,
        tree,
        xml,
        interactiveSnapshot: built,
      });
    }
    const { sourceNodes: _sourceNodes, occlusionContext, ...snapshot } = built;
    const result = {
      ...snapshot,
      ...androidSnapshotTruncationFields(truncated),
      androidSnapshot,
      quality: { state: 'healthy', backend: 'android-helper' } as const,
    };
    return createAndroidSnapshotCapture(result, {
      clickability: buildAndroidSnapshotClickabilityEvidence(built),
      occlusionContext,
    });
  } catch (error) {
    if (!isAndroidSnapshotPresentationFailure(error)) throw error;
    return attachAndroidPresentationFailureEvidence({
      failure: error,
      androidSnapshot,
    });
  }
}

function attachAndroidPresentationFailureEvidence(params: {
  failure: AndroidSnapshotPresentationFailure;
  androidSnapshot: AndroidSnapshotBackendMetadata;
}): AndroidSnapshotCapture {
  return createAndroidSnapshotCapture(
    {
      nodes: [],
      truncated: true,
      analysis: params.failure.analysis ?? { rawNodeCount: 0, maxDepth: 0 },
      androidSnapshot: {
        ...params.androidSnapshot,
        presentationFailure: {
          phase: params.failure.details.phase,
          workUnits: params.failure.details.workUnits,
          ...(params.failure.details.maxWorkUnits !== undefined
            ? { maxWorkUnits: params.failure.details.maxWorkUnits }
            : {}),
        },
      },
      quality: {
        state: 'sparse',
        backend: 'android-helper',
        reason: params.failure.message,
        reasonCode: params.failure.qualityReasonCode,
      },
    },
    {
      clickability: {
        kind: 'exact',
        provider: 'android-helper',
        clickableByNodeIndex: new Map(),
      },
    },
  );
}

function mergeAndroidSnapshotTruncation(
  snapshotTruncated: boolean | undefined,
  metadata: AndroidSnapshotBackendMetadata,
): boolean | undefined {
  return snapshotTruncated === true || metadata.helperTruncated === true ? true : snapshotTruncated;
}

function withOcclusionScanDisclosure(
  metadata: AndroidSnapshotBackendMetadata,
  tree: AndroidUiHierarchy,
): AndroidSnapshotBackendMetadata {
  return androidTreeCarriesDrawingOrder(tree) === false
    ? { ...metadata, occlusionScanUnavailable: true }
    : metadata;
}

function androidTreeCarriesDrawingOrder(root: AndroidUiHierarchy): boolean | undefined {
  const pending = [...root.children];
  if (pending.length === 0) return undefined;
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (readAndroidSiblingOrder(node) !== undefined) return true;
    pending.push(...node.children);
  }
  return false;
}

function androidSnapshotTruncationFields(
  truncated: boolean | undefined,
): { truncated: true } | Record<string, never> {
  return truncated === true ? { truncated: true } : {};
}

function applyHiddenContentHintsToInteractiveSnapshot(params: {
  options: AndroidSnapshotOptions;
  tree: AndroidUiHierarchy;
  xml: string;
  interactiveSnapshot: AndroidBuiltSnapshot;
}): void {
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
  const presentationHints = deriveMobileSnapshotHiddenContentHints(attachRefs(fullSnapshot.nodes));
  applyHiddenContentHintsToInteractiveNodes(
    presentationHints,
    fullSnapshot,
    params.interactiveSnapshot,
  );
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
    let previousContentReason: AndroidContentRecoveryReason | undefined;
    for (let attempt = 0; ; attempt += 1) {
      if (attempt > 0) await delayBeforeContentRecapture(options.signal);
      const settled = await captureAndroidHelperContentAttempt({
        options,
        adb,
        adbProvider,
        artifact,
        helperDeviceKey,
        attempt,
        previousContentReason,
      });
      if (settled.outcome === 'captured') return settled.capture;
      if (attempt + 1 >= HELPER_CONTENT_CAPTURE_ATTEMPTS) {
        return await rejectAndroidHelperContentUnavailable({
          contentRecovery: settled.decision,
          attempts: attempt + 1,
          helperDeviceKey,
          artifact,
          adb,
          signal: options.signal,
        });
      }
      previousContentReason = settled.decision.reason;
    }
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
        signal: options.signal,
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
  signal?: AbortSignal;
  adb: AndroidAdbExecutor;
  adbProvider: AndroidAdbProvider;
  artifact: AndroidSnapshotHelperArtifact;
  helperDeviceKey: string;
}): Promise<AndroidSnapshotHelperOutput> {
  const { signal, adb, adbProvider, artifact, helperDeviceKey } = params;
  const captureOptions = buildAndroidSnapshotHelperCaptureOptions({
    adb,
    adbProvider,
    artifact,
    deviceKey: helperDeviceKey,
    signal,
  });
  try {
    const sessionCapture = await withDiagnosticTimer(
      'android_snapshot_helper_session_capture',
      async () => await captureAndroidSnapshotWithHelperSession(captureOptions),
      {
        packageName: artifact.manifest.packageName,
        version: artifact.manifest.version,
        timeoutMs: ANDROID_SNAPSHOT_HELPER_CAPTURE_TIMEOUT_MS,
      },
    );
    if (sessionCapture) return sessionCapture;
  } catch (error) {
    signal?.throwIfAborted();
    if (isAndroidSnapshotHelperRetirementUnconfirmedError(error)) {
      throw error;
    }
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
      timeoutMs: ANDROID_SNAPSHOT_HELPER_CAPTURE_TIMEOUT_MS,
      commandTimeoutMs: ANDROID_SNAPSHOT_HELPER_COMMAND_TIMEOUT_MS,
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

type AndroidHelperContentAttempt =
  | { outcome: 'captured'; capture: { xml: string; metadata: AndroidSnapshotBackendMetadata } }
  | { outcome: 'unusable'; decision: AndroidHelperContentRecoveryDecision };

async function captureAndroidHelperContentAttempt(params: {
  options: AndroidSnapshotOptions;
  adb: AndroidAdbExecutor;
  adbProvider: AndroidAdbProvider;
  artifact: AndroidSnapshotHelperArtifact;
  helperDeviceKey: string;
  attempt: number;
  previousContentReason: AndroidContentRecoveryReason | undefined;
}): Promise<AndroidHelperContentAttempt> {
  const { options, adb, adbProvider, artifact, helperDeviceKey, attempt } = params;
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
      signal: options.signal,
      adb,
      adbProvider,
      artifact,
      helperDeviceKey,
    });
    helperCapture = formatAndroidHelperCaptureResult(capture, artifact, install.reason);
  } catch (error) {
    options.signal?.throwIfAborted();
    return {
      outcome: 'captured',
      capture: await rejectAndroidHelperCaptureFailure({
        error,
        helperDeviceKey,
        artifact,
        adb,
      }),
    };
  }

  const content = classifyAndroidHelperContent(helperCapture.xml, helperCapture.metadata, {
    foregroundAppPackage: options.appBundleId,
  });
  if (content.outcome === 'system-surface-only') {
    emitDiagnostic({
      phase: 'android_snapshot_helper_system_surface',
      data: { foregroundAppPackage: options.appBundleId },
    });
    return {
      outcome: 'captured',
      capture: {
        xml: helperCapture.xml,
        metadata: { ...helperCapture.metadata, systemSurfaceOnly: true },
      },
    };
  }
  if (content.outcome === 'ok') {
    if (attempt > 0) {
      emitDiagnostic({
        phase: 'android_snapshot_helper_content_recaptured',
        data: { attempts: attempt + 1, recoveredFromReason: params.previousContentReason },
      });
    }
    return { outcome: 'captured', capture: helperCapture };
  }
  return { outcome: 'unusable', decision: content.decision };
}

async function delayBeforeContentRecapture(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await sleep(HELPER_CONTENT_RECAPTURE_DELAY_MS);
  signal?.throwIfAborted();
}

async function rejectAndroidHelperContentUnavailable(params: {
  contentRecovery: AndroidHelperContentRecoveryDecision;
  attempts: number;
  helperDeviceKey: string;
  artifact: AndroidSnapshotHelperArtifact;
  adb: AndroidAdbExecutor;
  signal?: AbortSignal;
}): Promise<{ xml: string; metadata: AndroidSnapshotBackendMetadata }> {
  emitDiagnostic({
    level: 'error',
    phase: 'android_snapshot_helper_content_invalid',
    data: {
      reason: params.contentRecovery.reason,
      failureReason: params.contentRecovery.failureReason,
      attempts: params.attempts,
      ...params.contentRecovery.diagnostics,
    },
  });
  await retireAndroidSnapshotHelperAfterContentFailure({
    adb: params.adb,
    deviceKey: params.helperDeviceKey,
    packageName: params.artifact.manifest.packageName,
    signal: params.signal,
    cause: params.contentRecovery.failureReason,
  });
  throw new AppError('COMMAND_FAILED', params.contentRecovery.failureReason, {
    ...params.contentRecovery.diagnostics,
    androidSnapshotHelperFailureReason: params.contentRecovery.reason,
    attempts: params.attempts,
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
  return new AppError(
    toAppErrorCode(normalized.code),
    `Android snapshot helper failed: ${reason}`,
    {
      ...normalized.details,
      ...liftedWireFields(normalized),
      androidSnapshotHelperFailureReason: reason,
      hint: androidSnapshotHelperCaptureHint(normalized),
    },
    error,
  );
}

function androidSnapshotHelperCaptureHint(normalized: NormalizedError): string {
  const busy =
    isStructuredHelperTimeout(normalized.details?.helper, normalized.message) ||
    isKilledHelperInstrumentationFailure(normalized);
  if (busy) {
    return 'Android accessibility snapshots can be blocked by busy or continuously changing app UI. Use screenshot as visual truth after this timeout and report the busy UI if it persists.';
  }
  if (normalized.details?.androidSnapshotHelperInstallFailure === true) {
    return [
      normalized.hint,
      'This is a device-side install failure (adb rejection or OEM policy) — the helper artifact itself is present, this is not a missing/unbuilt build.',
    ]
      .filter(Boolean)
      .join(' ');
  }
  return (
    normalized.hint ??
    'Retry once. If the helper still fails, run agent-device doctor and report the diagnostic log; agent-device does not substitute a second snapshot engine.'
  );
}

// normalizeError hoists these wire-contract fields out of details (ADR 0010;
// the complete set stripDiagnosticMeta removes, minus hint, which
// androidSnapshotHelperCaptureHint owns). A rewrap must put every one back so
// upstream diagnostics and typed signals like `retriable` survive.
function liftedWireFields(normalized: NormalizedError): Record<string, string | boolean> {
  const fields: Record<string, string | boolean> = {};
  if (normalized.diagnosticId !== undefined) fields.diagnosticId = normalized.diagnosticId;
  if (normalized.logPath !== undefined) fields.logPath = normalized.logPath;
  if (normalized.retriable !== undefined) fields.retriable = normalized.retriable;
  if (normalized.supportedOn !== undefined) fields.supportedOn = normalized.supportedOn;
  return fields;
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
    hint: 'Run `pnpm build:android` to build the helper dist for a source checkout — the runtime needs android/snapshot-helper/dist/agent-device-android-snapshot-helper-<version>.manifest.json and the .apk it references. Packaged installs ship these via the prepack script; if they are missing from a packaged install, reinstall agent-device.',
  });
}

// The helper emits `can-scroll-*` for exactly the nodes Android reports as scrollable, so their
// absence means nothing on screen scrolls rather than that scroll state is unknown. A true result
// therefore means the hints parsed from those attributes are already authoritative, and callers
// fall back to guessing hidden content from geometry only when the helper reported no scrollable
// node at all.
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
