import { screenshotFlagsFromOptions } from '../contracts/screenshot.ts';
import type { CommandFlags } from '../core/dispatch-context.ts';
import { leaseScopeFromOptions, leaseScopeToCommandFlags } from '../core/lease-scope.ts';
import { stripUndefined } from '../utils/parsing.ts';
import { getFlagDefinitions } from './cli-grammar/flag-registry.ts';
import type { InternalRequestOptions } from '../client/client-types.ts';
import type { CommandMetadata } from './command-contract.ts';

const CLI_FLAG_KEYS: ReadonlySet<string> = new Set(
  getFlagDefinitions().map((definition) => definition.key),
);

function buildFlags(options: InternalRequestOptions): CommandFlags {
  const leaseScope = leaseScopeFromOptions(options);
  return stripUndefined({
    stateDir: options.stateDir,
    daemonBaseUrl: options.daemonBaseUrl,
    daemonAuthToken: options.daemonAuthToken,
    daemonTransport: options.daemonTransport,
    daemonServerMode: options.daemonServerMode,
    ...leaseScopeToCommandFlags(leaseScope),
    provider: options.provider,
    providerSessionId: options.providerSessionId,
    providerApp: options.providerApp,
    providerOsVersion: options.providerOsVersion,
    providerProject: options.providerProject,
    providerBuild: options.providerBuild,
    providerSessionName: options.providerSessionName,
    awsProjectArn: options.awsProjectArn,
    awsDeviceArn: options.awsDeviceArn,
    awsAppArn: options.awsAppArn,
    awsRegion: options.awsRegion,
    awsInteractionMode: options.awsInteractionMode,
    sessionIsolation: options.sessionIsolation,
    platform: options.platform,
    target: options.target,
    device: options.device,
    udid: options.udid,
    serial: options.serial,
    iosSimulatorDeviceSet: options.iosSimulatorDeviceSet,
    iosXctestrunFile: options.iosXctestrunFile,
    iosXctestDerivedDataPath: options.iosXctestDerivedDataPath,
    iosXctestEnvDir: options.iosXctestEnvDir,
    androidDeviceAllowlist: options.androidDeviceAllowlist,
    surface: options.surface,
    activity: options.activity,
    launchConsole: options.launchConsole,
    launchArgs: options.launchArgs,
    relaunch: options.relaunch,
    shutdown: options.shutdown,
    saveScript: options.saveScript,
    deviceHub: options.deviceHub,
    testIme: options.testIme,
    noRecord: options.noRecord,
    backMode: options.backMode,
    metroHost: options.metroHost,
    metroPort: options.metroPort,
    bundleUrl: options.bundleUrl,
    launchUrl: options.launchUrl,
    snapshotInteractiveOnly: options.interactiveOnly,
    snapshotDepth: options.depth,
    snapshotScope: options.scope,
    snapshotRaw: options.raw,
    snapshotForceFull: options.forceFull,
    ...screenshotFlagsFromOptions(options),
    appsFilter: options.appsFilter,
    kind: options.kind,
    out: options.out,
    count: options.count,
    fps: options.fps,
    screenshotMaxSize: options.maxSize,
    quality: options.quality,
    hideTouches: options.hideTouches,
    recordingScope: options.recordingScope,
    intervalMs: options.intervalMs,
    delayMs: options.delayMs,
    durationMs: options.durationMs,
    holdMs: options.holdMs,
    jitterPx: options.jitterPx,
    pixels: options.pixels,
    doubleTap: options.doubleTap,
    verify: options.verify,
    settle: options.settle,
    settleQuietMs: options.settleQuietMs,
    clickButton: options.clickButton,
    pauseMs: options.pauseMs,
    pattern: options.pattern,
    headless: options.headless,
    restart: options.restart,
    replayUpdate: options.replayUpdate,
    replayBackend: options.replayBackend,
    replayEnv: options.replayEnv,
    replayShellEnv: options.replayShellEnv,
    failFast: options.failFast,
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    recordVideo: options.recordVideo,
    artifactsDir: options.artifactsDir,
    shardAll: options.shardAll,
    shardSplit: options.shardSplit,
    findFirst: options.findFirst,
    findLast: options.findLast,
    networkInclude: options.networkInclude,
    batchOnError: options.batchOnError,
    batchMaxSteps: options.batchMaxSteps,
    batchSteps: options.batchSteps,
    verbose: options.debug,
  }) as CommandFlags;
}

export function buildRequestFlags(
  options: InternalRequestOptions,
  metadataFlags: Partial<CommandFlags> | undefined,
): CommandFlags {
  return {
    ...buildFlags(options),
    ...metadataFlags,
  };
}

export function readMetadataCommandFlags(
  metadata: Pick<CommandMetadata<string, unknown>, 'inputSchema'>,
  options: InternalRequestOptions,
): Partial<CommandFlags> {
  const properties = metadata.inputSchema.properties;
  if (!properties) return {};

  const flags: Record<string, unknown> = {};
  const record = options as Record<string, unknown>;
  for (const key of Object.keys(properties)) {
    if (!CLI_FLAG_KEYS.has(key)) continue;
    const value = record[key];
    if (isMetadataFlagValue(value)) flags[key] = value;
  }
  return flags as Partial<CommandFlags>;
}

function isMetadataFlagValue(value: unknown): value is boolean | number | string {
  return typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string';
}
