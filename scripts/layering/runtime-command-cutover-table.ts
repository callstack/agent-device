import type { MigratedCommandCutover, UnruledViolation } from './runtime-command-cutover-model.ts';
import {
  appLogSessionStateOwnershipViolations,
  devicesGatewayBindingViolations,
  sourceExecutedUsingDeclarationViolations,
} from './runtime-command-cutover-extensions.ts';
import { recordRuntimeDaemonMechanicsViolations } from './record-runtime-mechanics-policy.ts';

/**
 * One row per migrated command (ADR 0019 §8). A new command unit adds a row here; the
 * mechanism in `runtime-command-cutover-policy.ts` carries one planted-red proof for
 * every row, and `cutoverRowDefects` rejects a row that leaves its claims unstated.
 *
 * Rule ids are per row: the layering report groups violations under R20 boot,
 * R21 apps, R17 devices, R14 logs, R15 network, R16 record.
 */
export const MIGRATED_COMMAND_CUTOVERS: readonly MigratedCommandCutover[] = [
  {
    rule: 'R20 boot-runtime-cutover',
    command: 'boot',
    subject: 'device readiness',
    tier: 'request-scoped',
    execution: 'device-runtime',
    legacyRetirement: {
      modulePaths: ['src/platform-runtime-device-readiness-host.ts'],
      routeNames: ['ensureAndroidEmulatorBoot', 'resolveAndroidEmulatorAvdName'],
    },
    admissionMember: {
      forms: ['computed-property'],
      files: ['src/platforms/apple/plugin.ts'],
      message: 'Apple plugin retains legacy boot support or hint closure',
    },
    runtimeTypeNames: ['DeviceReadinessRuntimeOperations'],
    operations: { names: ['bootTarget', 'bootTargetHeadless'] },
    singularExecution: {
      routes: ['handleSessionStateCommands'],
      operations: ['bootTarget', 'bootTargetHeadless'],
      operationOwners: {
        bootTarget: ['handleSessionStateCommands'],
        bootTargetHeadless: ['handleSessionStateCommands'],
      },
    },
  },
  {
    rule: 'R21 apps-runtime-cutover',
    command: 'apps',
    subject: 'app inventory',
    tier: 'request-scoped',
    execution: 'device-runtime',
    legacyRetirement: {
      daemonOnlyRouteNames: [
        'listAndroidApps',
        'listIosApps',
        'listHarmonyApps',
        'resolveInstalledAppForDoctor',
      ],
    },
    admissionMember: {
      forms: ['computed-property'],
      files: ['src/platforms/apple/plugin.ts'],
      message: 'Apple plugin retains legacy apps support or hint closure',
    },
    runtimeTypeNames: ['AppInventoryRuntimeOperations'],
    operations: { names: ['ensureReady', 'listApps'] },
    singularExecution: {
      routes: ['handleAppsInventory'],
      operations: ['ensureReady', 'listApps'],
      operationOwners: {
        ensureReady: ['ensureAppsRuntimeReady'],
        listApps: ['listAppsFromRuntime'],
      },
    },
  },
  {
    rule: 'R17 device-inventory-cutover',
    command: 'devices',
    subject: 'device inventory',
    tier: 'request-scoped',
    execution: 'inventory',
    legacyRetirement: {
      modulePaths: ['src/core/platform-inventory.ts'],
      modulePathPatterns: [/^src\/platforms\/(?:[^/]+\/)*devices\.ts$/],
      importPatterns: [
        /(?:^|\/)core\/platform-inventory(?:\.[cm]?[jt]s)?$/,
        /(?:^|\/)platforms\/(?:[^/]+\/)*devices(?:\.[cm]?[jt]s)?$/,
      ],
      routeNames: [
        'discoverDevices',
        'listAndroidDevices',
        'listAppleDevices',
        'listHarmonyDevices',
        'listHarmonyOsDevices',
        'listLinuxDevices',
        'listMacosDevices',
        'listVegaDevices',
        'listWebDevices',
      ],
    },
    singularExecution: { gatewayProof: devicesGatewayBindingViolations },
  },
  {
    rule: 'R14 logs-runtime-cutover',
    command: 'logs',
    subject: 'logs',
    tier: 'durable-resource',
    execution: 'device-runtime',
    legacyRetirement: {
      routeNames: [
        'startAppLog',
        'stopAppLog',
        'runAppLogDoctor',
        'resolveLogBackend',
        'withAppLogProvider',
        'appLogProvider',
        'AppLogProviderResolver',
        'AppLogProvider',
      ],
      pluginFacetKeys: ['appLog'],
    },
    // Apple logs admission is a computed property key; `PUBLIC_COMMANDS.logs` as a plain
    // member is not an admission signal for this command.
    admissionMember: {
      forms: ['computed-property'],
      message: 'Apple plugin retains legacy logs support or hint closure',
    },
    runtimeTypeNames: ['AppLogRuntimeOperations', 'AppLogLiveHandle'],
    // Input-dependent plan: the logs use narrows to a family, not a fixed operation list.
    operations: { pattern: /^appLog[A-Za-z]+$/ },
    nonNullRepairScope: 'any-operation',
    // The app-log operation set is input-dependent, so only the daemon route is singular.
    singularExecution: { routes: ['handleLogsCommand'] },
    lifecycleProof: appLogSessionStateOwnershipViolations,
    extensions: [sourceExecutedUsingDeclarationViolations],
  },
  {
    rule: 'R15 network-runtime-cutover',
    command: 'network',
    subject: 'network',
    tier: 'request-scoped',
    execution: 'device-runtime',
    legacyRetirement: {
      modulePaths: [
        'src/daemon/network-log.ts',
        'src/daemon/app-log-network-recovery.ts',
        'src/daemon/network-log-android-recovery.ts',
        'src/daemon/network-log-ios-simulator-recovery.ts',
      ],
      daemonOnlyRouteNames: [
        'handleWebNetworkCommand',
        'readSessionNetworkCapture',
        'readRecentNetworkTraffic',
        'readRecentAndroidLogcatForPackage',
        'readRecentIosSimulatorLogShowForBundle',
      ],
      daemonOnlyProviderMethods: ['dumpNetwork'],
    },
    // Scoped to the Apple plugin: elsewhere `PUBLIC_COMMANDS.network` is an identifier,
    // not an admission decision.
    admissionMember: {
      forms: ['public-commands-member'],
      files: ['src/platforms/apple/plugin.ts'],
      message: 'Apple plugin retains legacy network support or hint closure',
    },
    runtimeTypeNames: ['NetworkRuntimeOperations'],
    operations: { names: ['networkDump'] },
    singularExecution: {
      routes: ['handleNetworkCommand'],
      operations: ['networkDump'],
      operationOwners: { networkDump: ['handleNetworkCommand'] },
    },
  },
  {
    rule: 'R16 record-runtime-cutover',
    command: 'record',
    subject: 'recording',
    tier: 'durable-resource',
    execution: 'device-runtime',
    legacyRetirement: {
      modulePaths: ['src/daemon/recording-provider.ts'],
      importPatterns: [/(?:^|\/)recording-provider(?:\.[cm]?[jt]s)?$/],
      routeNames: [
        'resolveRecordingBackendForDevice',
        'stopActiveRecording',
        'RecordingBackend',
        'RecordingStartBackend',
        'RECORDING_BACKENDS_BY_TAG',
        'RecordingBackendTag',
        'RecordingProvider',
        'RecordingProviderResolver',
        'recordingProvider',
        'resolveRecordingProvider',
        'withRecordingProvider',
        'createLocalRecordingProvider',
      ],
      pluginFacetKeys: ['recording'],
    },
    // No admission-member claim: `PUBLIC_COMMANDS.record` is live identifier-only data in
    // the daemon session-event tables, so the member form cannot discriminate here.
    runtimeTypeNames: ['ScreenRecordingRuntimeOperations', 'ScreenRecordingLiveHandle'],
    operations: {
      names: ['screenRecordingStart', 'screenRecordingReattach', 'screenRecordingCleanup'],
    },
    singularExecution: {
      routes: ['handleRecordTraceCommands'],
      operations: ['screenRecordingStart', 'screenRecordingReattach', 'screenRecordingCleanup'],
      operationOwners: {
        screenRecordingStart: ['startRecording'],
        screenRecordingReattach: ['createScreenRecordingRecoveryControl'],
        screenRecordingCleanup: ['createScreenRecordingRecoveryControl'],
      },
    },
    lifecycleProof: recordDaemonMechanicsProof,
  },
];

/** The record mechanics policy predates the row model and reports `path: message`. */
function recordDaemonMechanicsProof(sources: ReadonlyMap<string, string>): UnruledViolation[] {
  const production = [...sources].map(([path, source]) => ({ path, source }));
  return recordRuntimeDaemonMechanicsViolations(production).map((violation) => {
    const separator = violation.indexOf(': ');
    return {
      file: separator < 0 ? '(record runtime)' : violation.slice(0, separator),
      line: 1,
      message: separator < 0 ? violation : violation.slice(separator + 2),
    };
  });
}
