export function buildAppleLogPredicate(appBundleId: string, executableName?: string): string {
  const escapedBundleId = escapePredicateString(appBundleId);
  const clauses = [
    `subsystem == "${escapedBundleId}"`,
    `subsystem CONTAINS "${escapedBundleId}"`,
    `processImagePath ENDSWITH[c] "/${escapedBundleId}"`,
    `senderImagePath ENDSWITH[c] "/${escapedBundleId}"`,
  ];
  if (executableName) {
    const escapedExecutable = escapePredicateString(executableName);
    clauses.push(
      `process == "${escapedExecutable}"`,
      `processImagePath ENDSWITH[c] "/${escapedExecutable}"`,
      `senderImagePath ENDSWITH[c] "/${escapedExecutable}"`,
      `processImagePath CONTAINS[c] "/${escapedExecutable}.app/"`,
      `senderImagePath CONTAINS[c] "/${escapedExecutable}.app/"`,
    );
  }
  return clauses.join(' OR ');
}

export function buildIosSimulatorLogStreamArgs(params: {
  deviceId: string;
  appBundleId: string;
  executableName?: string;
  simulatorSetPath?: string;
}): string[] {
  const simctlPrefix = params.simulatorSetPath
    ? ['simctl', '--set', params.simulatorSetPath]
    : ['simctl'];
  return [
    ...simctlPrefix,
    'spawn',
    params.deviceId,
    'log',
    'stream',
    '--style',
    'compact',
    '--level',
    'info',
    '--predicate',
    buildAppleLogPredicate(params.appBundleId, params.executableName),
  ];
}

export function buildIosDeviceConsoleLaunchArgs(deviceId: string, appBundleId: string): string[] {
  return [
    'devicectl',
    'device',
    'process',
    'launch',
    '--device',
    deviceId,
    '--console',
    '--terminate-existing',
    appBundleId,
  ];
}

function escapePredicateString(value: string): string {
  return value.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`);
}
