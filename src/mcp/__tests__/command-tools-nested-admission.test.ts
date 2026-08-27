import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceClient } from '../../client/client-types.ts';
import { STRUCTURED_BATCH_COMMAND_NAMES } from '../../core/batch-policy.ts';
import { findCommandMetadata } from '../../commands/command-metadata.ts';
import { createCommandToolExecutor } from '../command-tools.ts';

// `batch` is the one tool whose input nests another command's input, and its
// step object is free-form by necessity (the accepted keys depend on the sibling
// `command`, which JSON Schema cannot express). The flat admission scan looked
// straight past it, so every key refused on a flat call was admitted one level
// in — and `readBatchDaemonStep` projects a step's input into per-step daemon
// request FLAGS, where `iosSimulatorDeviceSet` selects the simulator device set
// `resolveTargetDevice` searches and `iosXctestrunFile` selects the `.xctestrun`
// the Apple runner launches.
//
// The invariant these tests hold is a PARITY, not a key list: a batch step's
// input admits exactly what the nested command's own tool admits. Stated that
// way, a key added to `OPERATOR_INPUT_GUIDANCE` — or a whole new operator
// classification — is covered the day it lands, with nothing here to update.
const OPERATOR_PROBES: Readonly<Record<string, string>> = {
  daemonAuthToken: 'stolen-token',
  daemonBaseUrl: 'http://attacker.example:9000',
  stateDir: '/attacker/state-dir',
  cwd: '/attacker/cwd',
  iosSimulatorDeviceSet: '/attacker/device-set',
  iosXctestrunFile: '/attacker/run.xctestrun',
  iosXctestDerivedDataPath: '/attacker/derived',
  iosXctestEnvDir: '/attacker/env',
  config: '/attacker/config.json',
  remoteConfig: '/attacker/remote.json',
  totallyUnknownKey: 'x',
};

function createProbeExecutor() {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async (_client, name, input) => {
      calls.push({ name, input: input as Record<string, unknown> });
      return { total: 0, executed: 0, totalDurationMs: 0, results: [] };
    },
  });
  return { calls, executor };
}

test('a batch step admits exactly what the nested command tool admits', async () => {
  const { calls, executor } = createProbeExecutor();

  for (const command of STRUCTURED_BATCH_COMMAND_NAMES) {
    for (const [key, probe] of Object.entries(OPERATOR_PROBES)) {
      const flat = await executor.execute(command, { [key]: probe });
      calls.length = 0;
      const nested = await executor.execute('batch', {
        steps: [{ command, input: { [key]: probe } }],
      });
      assert.equal(
        nested.isError,
        flat.isError,
        `${command}: nested ${key} must be admitted iff flat ${key} is`,
      );
      if (!flat.isError) continue;
      assert.deepEqual(calls, [], `${command}: a refused nested ${key} must not be dispatched`);
      assert.match(
        nested.content[0]?.text ?? '',
        new RegExp(`batch\\.steps\\[0\\]\\.input: ${key} is not`),
        `${command}: nested ${key} must be refused with the flat guidance, located`,
      );
    }
  }
});

test('a refused step is refused wherever it sits in the batch', async () => {
  const { calls, executor } = createProbeExecutor();

  const result = await executor.execute('batch', {
    steps: [
      { command: 'snapshot', input: {} },
      { command: 'tap', input: { target: { kind: 'selector', selector: 'text=OK' } } },
      { command: 'snapshot', input: { iosXctestrunFile: '/attacker/run.xctestrun' } },
    ],
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /batch\.steps\[2\]\.input: iosXctestrunFile is not/);
  assert.match(result.content[0]?.text ?? '', /AGENT_DEVICE_IOS_XCTESTRUN_FILE/);
  assert.deepEqual(calls, [], 'no step runs when one is refused');
});

test('nested admission leaves legitimate batch input untouched', async () => {
  const { calls, executor } = createProbeExecutor();

  const steps = [
    { command: 'open', input: { app: 'settings' } },
    { command: 'snapshot', input: { interactiveOnly: true, noRecord: true } },
    { command: 'tap', input: { target: { kind: 'selector', selector: 'text=OK' } } },
    { command: 'type', input: { text: 'hello' }, runtime: { platform: 'ios' } },
    { command: 'wait', input: { kind: 'duration', durationMs: 100, session: 'sim' } },
  ];
  const result = await executor.execute('batch', { steps });

  assert.equal(result.isError, false, result.content[0]?.text);
  assert.deepEqual(calls[0]?.input.steps, steps);
});

// A step is NORMALIZED before it runs (`resolveStructuredBatchCommandName`
// trims and lowercases), so an admission boundary that matched the raw value
// exactly would see ` SNAPSHOT ` as no command at all, check nothing, and let
// the daemon run `snapshot` with the operator paths still aboard. Admission and
// the reader must resolve a name identically or the boundary guards a different
// command than the one that runs.
const COMMAND_SPELLINGS = [
  'snapshot',
  ' snapshot',
  'snapshot ',
  ' SNAPSHOT ',
  'SnApShOt',
  '\tsnapshot\n',
] as const;

test('a step is admitted as the command it will run as, however it is spelled', async () => {
  const { calls, executor } = createProbeExecutor();

  for (const command of COMMAND_SPELLINGS) {
    const steps = [{ command, input: { iosXctestrunFile: '/attacker/run.xctestrun' } }];
    calls.length = 0;
    const result = await executor.execute('batch', { steps });

    assert.equal(result.isError, true, `${JSON.stringify(command)} must be refused`);
    assert.match(
      result.content[0]?.text ?? '',
      /batch\.steps\[0\]\.input: iosXctestrunFile is not/,
      `${JSON.stringify(command)} must be refused as the command it resolves to`,
    );
    assert.deepEqual(calls, [], `${JSON.stringify(command)} must not be dispatched`);
  }
});

// The drift guard behind the case above: whatever spelling the reader accepts,
// admission must have checked. Stated against the reader itself, so a change to
// how a step name is normalized cannot quietly reopen the gap.
test('admission refuses every spelling the batch reader resolves', async () => {
  const { executor } = createProbeExecutor();
  const readBatch = findCommandMetadata('batch').readInput;

  for (const command of [...COMMAND_SPELLINGS, 'not-a-command', 'batch', '', '  ']) {
    const steps = [{ command, input: { iosXctestrunFile: '/attacker/run.xctestrun' } }];
    let resolves = true;
    try {
      readBatch({ steps });
    } catch {
      resolves = false;
    }
    const result = await executor.execute('batch', { steps });
    assert.equal(
      result.isError,
      resolves,
      `${JSON.stringify(command)}: admission must refuse it iff the reader runs it`,
    );
  }
});

// A step whose command cannot be resolved has no schema to check its input
// against — and needs none, because that step cannot run. Admission must fall
// through to the reader that owns the error instead of answering with a key
// complaint that would bury it.
test('an unresolvable step command is left to the batch reader', async () => {
  const { calls, executor } = createProbeExecutor();
  const steps = [
    { command: 'not-a-command', input: { iosXctestrunFile: '/attacker/run.xctestrun' } },
  ];

  const result = await executor.execute('batch', { steps });

  assert.equal(result.isError, false, 'admission has no verdict to give here');
  assert.deepEqual(calls[0]?.input.steps, steps);

  // And the reader that does own it still refuses the step, so the unchecked
  // input never reaches a daemon request flag.
  assert.throws(
    () => findCommandMetadata('batch').readInput({ steps }),
    /not available through command batch/,
  );
});
