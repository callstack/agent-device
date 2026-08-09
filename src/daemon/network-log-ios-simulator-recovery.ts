import { buildSimctlArgs } from '../platforms/apple/core/simctl.ts';
import { runXcrun } from '../platforms/apple/core/tool-provider.ts';

export async function readRecentIosSimulatorLogShowForBundle(params: {
  deviceId: string;
  appBundleId: string;
  executableName?: string;
  startedAt?: number;
  simulatorSetPath?: string;
}): Promise<{ text: string; recoveredLineCount: number } | null> {
  const args = buildSimctlArgs(
    [
      'spawn',
      params.deviceId,
      'log',
      'show',
      '--style',
      'compact',
      '--info',
      '--predicate',
      buildNetworkLogPredicate(params.appBundleId, params.executableName),
    ],
    { simulatorSetPath: params.simulatorSetPath },
  );
  if (
    typeof params.startedAt === 'number' &&
    Number.isFinite(params.startedAt) &&
    params.startedAt > 0
  ) {
    args.push('--start', `@${Math.floor(params.startedAt / 1000)}`);
  } else {
    args.push('--last', '5m');
  }
  const result = await runXcrun(args, { allowFailure: true, timeoutMs: 4_000 });
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) return null;
  const lines = result.stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed.length > 0 && !trimmed.startsWith('Timestamp               Ty Process[PID:TID]')
      );
    });
  return lines.length === 0
    ? null
    : { text: `${lines.join('\n')}\n`, recoveredLineCount: lines.length };
}

function buildNetworkLogPredicate(appBundleId: string, executableName?: string): string {
  const escapedBundleId = escapePredicateString(appBundleId);
  const clauses = [
    `subsystem == "${escapedBundleId}"`,
    `subsystem CONTAINS "${escapedBundleId}"`,
    ...imagePathPredicateClauses(escapedBundleId, false),
  ];
  if (executableName) {
    const escapedExecutable = escapePredicateString(executableName);
    clauses.push(
      `process == "${escapedExecutable}"`,
      ...imagePathPredicateClauses(escapedExecutable, true),
    );
  }
  return clauses.join(' OR ');
}

function imagePathPredicateClauses(value: string, includeAppContainer: boolean): string[] {
  return ['processImagePath', 'senderImagePath'].flatMap((field) => [
    `${field} ENDSWITH[c] "/${value}"`,
    ...(includeAppContainer ? [`${field} CONTAINS[c] "/${value}.app/"`] : []),
  ]);
}

function escapePredicateString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
