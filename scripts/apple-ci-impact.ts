import { pathToFileURL } from 'node:url';
import {
  checkOwnership,
  pullRequestChangedPaths,
  reportSelection,
  selectDeviceLane,
  type Selection,
} from './device-lane-impact.ts';

export function selectIosSmoke(
  eventName: string,
  changedPaths: readonly string[] | null,
): Selection {
  return selectDeviceLane(eventName, changedPaths, ['swift-runner-ios', 'replay-ios']);
}

// The macOS phase also hosts the darwin-only bridge proof, so its inputs keep the phase.
export function selectMacosSmoke(
  eventName: string,
  changedPaths: readonly string[] | null,
): Selection {
  const lanes = selectDeviceLane(eventName, changedPaths, [
    'macos-coverage',
    'packaged-runner-swift',
    'ios-snapshot-differential',
    'swift-runner-macos',
    'macos-helper',
    'replay-macos',
  ]);
  return lanes.run ? lanes : selectAppleBridgeProof(changedPaths);
}

export function selectIosXctests(
  eventName: string,
  changedPaths: readonly string[] | null,
): Selection {
  return selectDeviceLane(eventName, changedPaths, ['swift-runner-ios']);
}

export function selectAppleBridgeProof(changedPaths: readonly string[] | null): Selection {
  const checked = checkOwnership(changedPaths);
  if (checked.early) return checked.early;
  const input = changedPaths.find(
    (file) => file.startsWith('apple/') || file.startsWith('packages/platform-apple/src/'),
  );
  return input
    ? { run: true, reason: `Apple implementation changed: ${input}` }
    : { run: false, reason: 'the PR changed no Apple implementation or gate tooling' };
}

const TARGETS = {
  smoke: { label: 'iOS smoke', select: selectIosSmoke },
  macos: { label: 'macOS smoke', select: selectMacosSmoke },
  xctest: { label: 'iOS XCTest', select: selectIosXctests },
  bridge: {
    label: 'Apple bridge proof',
    select: (_eventName: string, changedPaths: readonly string[] | null) =>
      selectAppleBridgeProof(changedPaths),
  },
} as const;

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const target = process.argv[2] ?? '';
  if (!Object.hasOwn(TARGETS, target)) {
    process.stderr.write(`Expected one of: ${Object.keys(TARGETS).join(', ')}\n`);
    process.exitCode = 2;
  } else {
    const { label, select } = TARGETS[target as keyof typeof TARGETS];
    const eventName = process.env.GITHUB_EVENT_NAME ?? '';
    reportSelection(label, select(eventName, pullRequestChangedPaths(eventName)));
  }
}
