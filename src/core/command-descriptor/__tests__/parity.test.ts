import assert from 'node:assert/strict';
import { test } from 'vitest';
import { STRUCTURED_BATCH_COMMAND_NAMES } from '../../../batch-policy.ts';
import { PUBLIC_COMMANDS } from '../../../command-catalog.ts';
import { BASE_COMMAND_CAPABILITY_MATRIX } from '../../capabilities.ts';
import {
  DAEMON_COMMAND_DESCRIPTORS,
  type DaemonCommandDescriptor,
} from '../../../daemon/daemon-command-registry.ts';
import type { DaemonRequest } from '../../../daemon/types.ts';
import { deriveDaemonCommandDescriptors, deriveStructuredBatchCommandNames } from '../derive.ts';
import { commandDescriptors } from '../registry.ts';

// Function-valued traits cannot be deep-equaled across re-authored closures, so
// (mirroring daemon-command-registry.test.ts) they are compared by presence and
// by behavior on a representative sample, while every other field is deepEqual'd.
const DAEMON_FUNCTION_TRAITS = [
  'allowSessionlessDefaultDevice',
  'skipSessionlessProviderDevice',
] as const;

// Public commands that intentionally have no daemon route — they live only in the
// capability/batch tables, so the daemon registry has never covered them.
const UNROUTED_PUBLIC_COMMANDS = new Set<string>([
  PUBLIC_COMMANDS.appSwitcher,
  PUBLIC_COMMANDS.installFromSource,
]);

// Public commands that intentionally carry no capability entry — pure control-plane
// or always-admitted commands, so the capability matrix has never covered them.
const NO_CAPABILITY_PUBLIC_COMMANDS = new Set<string>([
  PUBLIC_COMMANDS.appState,
  PUBLIC_COMMANDS.batch,
  PUBLIC_COMMANDS.devices,
  PUBLIC_COMMANDS.gesture,
  PUBLIC_COMMANDS.prepare,
  PUBLIC_COMMANDS.replay,
  PUBLIC_COMMANDS.test,
  PUBLIC_COMMANDS.trace,
]);

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

test('derived daemon registry holds its routing invariants', () => {
  // The daemon registry is now BUILT from these derived descriptors (the
  // hand-authored literal was deleted after #906 proved byte-equality), so a
  // derived-vs-DAEMON_COMMAND_DESCRIPTORS comparison would be a tautology.
  // Instead assert the structural invariants the daemon depends on: every
  // descriptor has a route, command names are unique, and the command set still
  // covers every public command (the prior coverage floor).
  const derived = deriveDaemonCommandDescriptors(commandDescriptors);
  assert.ok(derived.length > 0, 'derived descriptors present');

  const names = derived.map((descriptor) => descriptor.command);
  assert.equal(new Set(names).size, names.length, 'no duplicate daemon command names');

  for (const descriptor of derived) {
    assert.ok(descriptor.route, `${descriptor.command} has a route`);
  }

  const nameSet = new Set(names);
  for (const command of Object.values(PUBLIC_COMMANDS)) {
    if (UNROUTED_PUBLIC_COMMANDS.has(command)) continue;
    assert.ok(nameSet.has(command), `daemon registry covers public command ${command}`);
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

test('capability matrix holds its admission invariants', () => {
  // BASE_COMMAND_CAPABILITY_MATRIX is now BUILT from these derived descriptors
  // (the hand-authored literal was deleted after #906 proved byte-equality,
  // including the supports/unsupportedHint closures across the sample-device
  // matrix), so a derived-vs-BASE comparison would be a tautology. Instead assert
  // the invariants the admission path depends on: every entry is selectable (has a
  // platform bucket or a supports predicate) and the public-command coverage floor
  // is unchanged.
  const entries = Object.entries(BASE_COMMAND_CAPABILITY_MATRIX);
  assert.ok(entries.length > 0, 'capability matrix present');

  for (const [command, capability] of entries) {
    const hasPlatformBucket = Boolean(
      capability.apple || capability.android || capability.linux || capability.web,
    );
    assert.ok(
      hasPlatformBucket || typeof capability.supports === 'function',
      `${command} has a platform bucket or a supports predicate`,
    );
  }

  const covered = new Set(Object.keys(BASE_COMMAND_CAPABILITY_MATRIX));
  for (const command of Object.values(PUBLIC_COMMANDS)) {
    if (NO_CAPABILITY_PUBLIC_COMMANDS.has(command)) continue;
    assert.ok(covered.has(command), `capability matrix covers public command ${command}`);
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
