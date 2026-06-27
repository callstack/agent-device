import assert from 'node:assert/strict';
import { test } from 'vitest';
import { STRUCTURED_BATCH_COMMAND_NAMES } from '../../../batch-policy.ts';
import { PUBLIC_COMMANDS } from '../../../command-catalog.ts';
import { BASE_COMMAND_CAPABILITY_MATRIX, type CommandCapability } from '../../capabilities.ts';
import {
  DAEMON_COMMAND_DESCRIPTORS,
  type DaemonCommandDescriptor,
} from '../../../daemon/daemon-command-registry.ts';
import type { DaemonRequest } from '../../../daemon/types.ts';
import type { DeviceInfo } from '../../../utils/device.ts';
import {
  deriveCapabilityMatrix,
  deriveDaemonCommandDescriptors,
  deriveStructuredBatchCommandNames,
} from '../derive.ts';
import { commandDescriptors } from '../registry.ts';

// Function-valued traits cannot be deep-equaled across re-authored closures, so
// (mirroring daemon-command-registry.test.ts) they are compared by presence and
// by behavior on a representative sample, while every other field is deepEqual'd.
const DAEMON_FUNCTION_TRAITS = [
  'allowSessionlessDefaultDevice',
  'skipSessionlessProviderDevice',
] as const;
const CAPABILITY_FUNCTION_TRAITS = ['supports', 'unsupportedHint'] as const;

function stripFunctions<T extends Record<string, unknown>>(value: T): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'function') result[key] = entry;
  }
  return result as Partial<T>;
}

function makeRequest(command: string, positionals: string[] = []): DaemonRequest {
  return { command, token: 'parity-token', session: 'parity-session', positionals, flags: {} };
}

// Sample requests that exercise both closure traits' branches for any command.
function sampleRequests(command: string): DaemonRequest[] {
  return [
    makeRequest(command),
    makeRequest(command, ['start']),
    makeRequest(command, ['stop']),
    makeRequest(command, ['START']),
    { ...makeRequest(command), flags: { shardAll: 2 } },
    { ...makeRequest(command), flags: { shardSplit: 3 } },
    { ...makeRequest(PUBLIC_COMMANDS.test), flags: { shardAll: 2 } },
    { ...makeRequest(PUBLIC_COMMANDS.test), flags: { shardSplit: 1 } },
  ];
}

function device(partial: Partial<DeviceInfo> & Pick<DeviceInfo, 'platform' | 'kind'>): DeviceInfo {
  return { id: 'parity-id', name: 'parity-device', ...partial };
}

const SAMPLE_DEVICES: DeviceInfo[] = [
  device({ platform: 'ios', kind: 'simulator' }),
  device({ platform: 'ios', kind: 'simulator', target: 'tv' }),
  device({ platform: 'ios', kind: 'device' }),
  device({ platform: 'ios', kind: 'device', target: 'tv' }),
  device({ platform: 'macos', kind: 'device' }),
  device({ platform: 'macos', kind: 'simulator' }),
  device({ platform: 'android', kind: 'emulator' }),
  device({ platform: 'android', kind: 'device' }),
  device({ platform: 'android', kind: 'simulator' }),
  device({ platform: 'linux', kind: 'device' }),
  device({ platform: 'web', kind: 'device' }),
];

test('derived daemon descriptors match the hand table (non-function traits, in order)', () => {
  const derived = deriveDaemonCommandDescriptors(commandDescriptors);
  assert.equal(derived.length, DAEMON_COMMAND_DESCRIPTORS.length, 'descriptor count');
  for (let index = 0; index < derived.length; index++) {
    const live = DAEMON_COMMAND_DESCRIPTORS[index] as DaemonCommandDescriptor;
    const next = derived[index];
    assert.ok(next, `index ${index} derived descriptor present`);
    assert.equal(next.command, live.command, `index ${index} command order`);
    assert.deepEqual(
      stripFunctions(next),
      stripFunctions(live),
      `${live.command} non-function daemon traits`,
    );
  }
});

test('derived daemon descriptors preserve closure traits by presence and behavior', () => {
  const liveByCommand = new Map(
    DAEMON_COMMAND_DESCRIPTORS.map((d) => [d.command, d as DaemonCommandDescriptor]),
  );
  for (const derived of deriveDaemonCommandDescriptors(commandDescriptors)) {
    const live = liveByCommand.get(derived.command);
    assert.ok(live, `${derived.command} present in hand table`);
    for (const trait of DAEMON_FUNCTION_TRAITS) {
      const derivedFn = derived[trait] as ((req: DaemonRequest) => boolean) | undefined;
      const liveFn = live[trait] as ((req: DaemonRequest) => boolean) | undefined;
      assert.equal(typeof derivedFn, typeof liveFn, `${derived.command} ${trait} presence`);
      if (typeof liveFn === 'function' && typeof derivedFn === 'function') {
        for (const request of sampleRequests(derived.command)) {
          assert.equal(derivedFn(request), liveFn(request), `${derived.command} ${trait} behavior`);
        }
      }
    }
  }
});

test('derived capability matrix matches the hand table (non-function fields)', () => {
  const derived = deriveCapabilityMatrix(commandDescriptors);
  assert.deepEqual(
    Object.keys(derived).sort(),
    Object.keys(BASE_COMMAND_CAPABILITY_MATRIX).sort(),
    'capability command coverage',
  );
  for (const [command, live] of Object.entries(BASE_COMMAND_CAPABILITY_MATRIX)) {
    assert.deepEqual(
      stripFunctions(derived[command] as CommandCapability),
      stripFunctions(live),
      `${command} non-function capability fields`,
    );
  }
});

test('derived capability matrix preserves supports/unsupportedHint by presence and behavior', () => {
  const derived = deriveCapabilityMatrix(commandDescriptors);
  for (const [command, live] of Object.entries(BASE_COMMAND_CAPABILITY_MATRIX)) {
    const derivedCapability = derived[command] as CommandCapability;
    for (const trait of CAPABILITY_FUNCTION_TRAITS) {
      const derivedFn = derivedCapability[trait] as ((device: DeviceInfo) => unknown) | undefined;
      const liveFn = live[trait] as ((device: DeviceInfo) => unknown) | undefined;
      assert.equal(typeof derivedFn, typeof liveFn, `${command} ${trait} presence`);
      if (typeof liveFn === 'function' && typeof derivedFn === 'function') {
        for (const sample of SAMPLE_DEVICES) {
          assert.equal(
            derivedFn(sample),
            liveFn(sample),
            `${command} ${trait} on ${sample.platform}/${sample.kind}/${sample.target ?? 'mobile'}`,
          );
        }
      }
    }
  }
});

test('derived structured-batch command names match the hand table (membership)', () => {
  // Membership, not order: STRUCTURED_BATCH_COMMAND_NAMES and
  // DAEMON_COMMAND_DESCRIPTORS are independently hand-ordered, so a single
  // registry table cannot reproduce both array orders. The batchable flags are
  // proven byte-equal as a set; ordering is cosmetic (the consumer dedupes into
  // a Set) and is deferred to a later slice.
  const derived = deriveStructuredBatchCommandNames(commandDescriptors);
  assert.equal(new Set(derived).size, derived.length, 'no duplicate batchable names');
  assert.deepEqual(
    [...derived].sort(),
    [...STRUCTURED_BATCH_COMMAND_NAMES].sort(),
    'structured-batch membership',
  );
});
