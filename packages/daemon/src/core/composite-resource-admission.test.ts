import path from 'node:path';
import { seedExistingCapture } from './composite-resource-existing.fixtures.ts';
import fs from 'node:fs';
import { IOS_SIMULATOR, WEB_DESKTOP_DEVICE } from '@agent-device/test-kit';
import { expect, test, vi } from 'vitest';
import { resourceAdmissionWorld, assertRpcOk } from './composite-resource-admission.fixtures.ts';

const unsupported = [
  ['perf', ['memory', 'snapshot'], 'perf:memory-snapshot'],
  ['perf', ['cpu', 'profile', 'start', 'simpleperf'], 'perf:capture-start'],
  ['perf', ['cpu', 'profile', 'stop', 'simpleperf'], 'perf:capture-stop'],
  ['perf', ['cpu', 'profile', 'report', 'simpleperf'], 'perf:profile-report'],
  ['perf', ['trace', 'start', 'perfetto'], 'perf:capture-start'],
  ['perf', ['trace', 'stop', 'perfetto'], 'perf:capture-stop'],
  ['record', ['start'], 'record:start'],
  ['record', ['stop'], 'record:stop-recovery'],
  ['audio', ['probe', 'start'], 'audio:capture-start'],
  ['logs', ['start'], 'logs:start'],
  ['logs', ['stop'], 'logs:stop'],
  ['logs', ['clear'], 'logs:clear-restart'],
  ['trace', ['start'], 'trace:start'],
  ['trace', ['stop'], 'trace:stop'],
] as const;

test.each(unsupported)(
  'batch refuses %s %j before runtime admission or effects',
  async (command, args, shape) => {
    const world = await resourceAdmissionWorld();
    try {
      const response = await world.call('batch', [], {
        batchSteps: [
          {
            command,
            positionals: [...args],
            ...(shape === 'logs:clear-restart' ? { flags: { restart: true } } : {}),
          },
        ],
      });
      expect(response.json.error?.data?.details).toMatchObject({
        reason: 'bounded_composite_resource_unsupported',
        shape,
        executed: 0,
        dispatched: 'no',
        standaloneCommandName: command,
      });
      expect(response.json.error?.data?.hint).toContain('same --session value');
      expect(world.bind).not.toHaveBeenCalled();
      expect(world.inspectFacts).not.toHaveBeenCalled();
      expect(world.native).not.toHaveBeenCalled();
      expect(world.finish).not.toHaveBeenCalled();
      expect(world.forceCleanup).not.toHaveBeenCalled();
    } finally {
      await world.daemon.close();
    }
  },
);

test('bounded replay preserves viewport dispatch through the descriptor guard', async () => {
  const world = await resourceAdmissionWorld('capture', { device: WEB_DESKTOP_DEVICE });
  try {
    const script = path.join(world.daemon.stateDir, 'viewport.ad');
    const source = 'viewport 640 480\n';
    const response = await world.call('replay', [script], {
      replayScriptSource: { entry: script, files: { [script]: source } },
    });
    assertRpcOk(response);
    expect(world.setViewport).toHaveBeenCalledExactlyOnceWith({ width: 640, height: 480 });
  } finally {
    await world.daemon.close();
  }
});

test('replay refuses an authored command without a resource classification before admission', async () => {
  const world = await resourceAdmissionWorld();
  try {
    const script = path.join(world.daemon.stateDir, 'unclassified.ad');
    const response = await world.call('replay', [script], {
      replayScriptSource: { entry: script, files: { [script]: 'prepare\n' } },
    });
    expect(response.json.error?.data?.details).toMatchObject({
      reason: 'bounded_composite_resource_unsupported',
      shape: 'prepare:unclassified',
      standaloneCommandName: 'prepare',
      dispatched: 'no',
      divergence: { step: { source: { path: script, line: 1 } } },
    });
    expect(world.bind).not.toHaveBeenCalled();
    expect(world.inspectFacts).not.toHaveBeenCalled();
    expect(world.native).not.toHaveBeenCalled();
  } finally {
    await world.daemon.close();
  }
});

test.each([
  ['logs', ['path'], 'logs:path:unverified-owner'],
  ['audio', ['probe', 'status'], 'audio:unverified-owner'],
] as const)(
  '%s without a verified session owner refuses the typed shape',
  async (command, args, shape) => {
    const world = await resourceAdmissionWorld();
    try {
      world.sessionStore.retire(world.ref);
      const response = await world.call('batch', [], {
        batchSteps: [{ command, positionals: [...args] }],
      });
      expect(response.json.error?.data?.details).toMatchObject({
        reason: 'bounded_composite_resource_unsupported',
        shape,
        dispatched: 'no',
        standaloneCommandName: command,
        executed: 0,
      });
      expect(world.bind).not.toHaveBeenCalled();
      expect(world.inspectFacts).not.toHaveBeenCalled();
      expect(world.native).not.toHaveBeenCalled();
    } finally {
      await world.daemon.close();
    }
  },
);

test('an iOS local log path remains admissible inside batch', async () => {
  const world = await resourceAdmissionWorld('capture', { device: IOS_SIMULATOR });
  try {
    assertRpcOk(
      await world.call('batch', [], {
        batchSteps: [{ command: 'logs', positionals: ['path'] }],
      }),
    );
  } finally {
    await world.daemon.close();
  }
});

test.each(['batch', 'replay'] as const)(
  '%s retains completed progress/source on resource refusal',
  async (composite) => {
    const world = await resourceAdmissionWorld();
    try {
      const script = path.join(world.daemon.stateDir, 'resource.ad');
      const response = await world.call(
        composite,
        composite === 'batch' ? [] : [script],
        composite === 'batch'
          ? {
              batchSteps: [
                { command: 'home' },
                { command: 'perf', positionals: ['memory', 'snapshot'] },
              ],
            }
          : {
              replayScriptSource: {
                entry: script,
                files: {
                  [script]: '# resource admission\nhome\nperf memory snapshot\n',
                },
              },
            },
      );
      expect(response.json.error?.data?.details).toMatchObject({
        reason: 'bounded_composite_resource_unsupported',
        shape: 'perf:memory-snapshot',
      });
      if (composite === 'batch')
        expect(response.json.error.data.details).toMatchObject({
          executed: 1,
          step: 2,
          partialResults: [{ command: 'home', ok: true }],
        });
      else
        expect(response.json.error.data.details).toMatchObject({
          divergence: { step: { source: { path: script, line: 3 } } },
        });
      expect(world.sessionStore.requireCurrent(world.ref).appLog).toBeUndefined();
      expect(world.native).not.toHaveBeenCalled();
    } finally {
      await world.daemon.close();
    }
  },
);

test.each(['batch', 'replay'] as const)(
  '%s keeps the refused step undispatched after a completed device mutation',
  async (composite) => {
    const world = await resourceAdmissionWorld();
    try {
      const script = path.join(world.daemon.stateDir, 'mutated-before-refusal.ad');
      const response = await world.call(
        composite,
        composite === 'batch' ? [] : [script],
        composite === 'batch'
          ? {
              batchSteps: [{ command: 'home' }, { command: 'record', positionals: ['start'] }],
            }
          : {
              replayScriptSource: {
                entry: script,
                files: { [script]: 'home\nrecord start\n' },
              },
            },
      );
      expect(world.home).toHaveBeenCalledOnce();
      expect(response.json.error?.data?.details).toMatchObject({
        reason: 'bounded_composite_resource_unsupported',
        shape: 'record:start',
        standaloneCommandName: 'record',
        dispatched: 'no',
        dispatchedSteps: 1,
      });
      if (composite === 'replay') {
        expect(response.json.error.data.details).toMatchObject({
          divergence: {
            step: { source: { path: script, line: 2 } },
            screen: { state: 'unavailable', reason: 'bounded-composite-resource-unsupported' },
          },
        });
      }
      expect(world.bind).toHaveBeenCalledOnce();
      expect(world.inspectFacts).toHaveBeenCalledOnce();
      expect(world.native).not.toHaveBeenCalled();
    } finally {
      await world.daemon.close();
    }
  },
);

test('a completed snapshot precedes a refused record step with original input guidance', async () => {
  const world = await resourceAdmissionWorld();
  try {
    const response = await world.call('batch', [], {
      batchSteps: [
        { command: 'snapshot' },
        { command: 'record', positionals: ['start', 'clips/record a.mp4'], flags: { fps: 30 } },
      ],
    });
    expect(response.json.error?.data?.details).toMatchObject({
      reason: 'bounded_composite_resource_unsupported',
      shape: 'record:start',
      dispatched: 'no',
      executed: 1,
      standaloneCommandName: 'record',
      partialResults: [{ command: 'snapshot', ok: true }],
    });
    expect(response.json.error?.data?.hint).toContain('original arguments and options');
    expect(response.json.error.data.details).not.toHaveProperty('standaloneCommand');
    expect(world.native).not.toHaveBeenCalled();
    expect(world.finish).not.toHaveBeenCalled();
  } finally {
    await world.daemon.close();
  }
});

test('replay refusal keeps failed-step recovery without reconstructing CLI arguments', async () => {
  const world = await resourceAdmissionWorld();
  try {
    const script = path.join(world.daemon.stateDir, 'profile.ad');
    const response = await world.call('replay', [script], {
      replayScriptSource: {
        entry: script,
        files: { [script]: 'home\nperf cpu profile start xctrace\n' },
      },
    });
    expect(response.json.error?.data?.details).toMatchObject({
      reason: 'bounded_composite_resource_unsupported',
      shape: 'perf:capture-start',
      dispatched: 'no',
      dispatchedSteps: 1,
      standaloneCommandName: 'perf',
      divergence: {
        step: { index: 2, source: { path: script, line: 2 } },
        resume: { allowed: true, from: 2 },
      },
    });
    expect(response.json.error.data.details).not.toHaveProperty('standaloneCommand');
    expect(response.json.error.data.details.divergence.resume.planDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(world.native).not.toHaveBeenCalled();
  } finally {
    await world.daemon.close();
  }
});

test('agent completes a refused replay step directly, then resumes without repeating the prefix', async () => {
  const world = await resourceAdmissionWorld();
  try {
    const script = path.join(world.daemon.stateDir, 'resume-resource.ad');
    const replayScriptSource = {
      entry: script,
      files: { [script]: 'home\nlogs start\nhome\n' },
    };
    const refused = await world.call('replay', [script], { replayScriptSource });
    const details = refused.json.error?.data?.details;
    expect(details).toMatchObject({
      reason: 'bounded_composite_resource_unsupported',
      shape: 'logs:start',
      dispatched: 'no',
      standaloneCommandName: 'logs',
      dispatchedSteps: 1,
      divergence: {
        step: { index: 2, source: { path: script, line: 2 } },
        resume: { allowed: true, from: 2, alternateFrom: 3 },
        screen: { state: 'unavailable', reason: 'bounded-composite-resource-unsupported' },
      },
    });
    expect(world.home).toHaveBeenCalledOnce();
    expect(world.sessionStore.requireCurrent(world.ref).appLog).toBeUndefined();
    assertRpcOk(await world.call('logs', ['start']));
    const log = world.sessionStore.requireCurrent(world.ref).appLog;
    const resumed = await world.call('replay', [script], {
      replayScriptSource,
      replayFrom: details.divergence.resume.alternateFrom,
      replayPlanDigest: details.divergence.resume.planDigest,
    });
    assertRpcOk(resumed);
    expect(world.home).toHaveBeenCalledTimes(2);
    expect(world.sessionStore.requireCurrent(world.ref).appLog).toBe(log);
    expect(world.finish).not.toHaveBeenCalled();
  } finally {
    await world.daemon.close();
  }
});

test('Android observations remain standalone and bounded shapes refuse before facts', async () => {
  const world = await resourceAdmissionWorld();
  try {
    for (const positionals of [['frames'], ['memory', 'sample']]) {
      assertRpcOk(await world.call('perf', positionals));
      const bindings = world.bind.mock.calls.length;
      const facts = world.inspectFacts.mock.calls.length;
      const bounded = await world.call('batch', [], {
        batchSteps: [{ command: 'perf', positionals }],
      });
      expect(bounded.json.error?.data?.details).toMatchObject({
        reason: 'bounded_composite_resource_unsupported',
        dispatched: 'no',
      });
      expect(world.bind).toHaveBeenCalledTimes(bindings);
      expect(world.inspectFacts).toHaveBeenCalledTimes(facts);
    }
    expect(world.sample).toHaveBeenCalledTimes(2);
    for (const positionals of [['path'], ['mark', 'resource-proof'], ['clear'], ['doctor']]) {
      assertRpcOk(await world.call('logs', positionals));
      const bindings = world.bind.mock.calls.length;
      const facts = world.inspectFacts.mock.calls.length;
      const bounded = await world.call('batch', [], {
        batchSteps: [{ command: 'logs', positionals }],
      });
      expect(bounded.json.error?.data?.details).toMatchObject({
        reason: 'bounded_composite_resource_unsupported',
        dispatched: 'no',
      });
      expect(world.bind).toHaveBeenCalledTimes(bindings);
      expect(world.inspectFacts).toHaveBeenCalledTimes(facts);
    }
    const response = await world.call('perf', ['memory', 'snapshot']);
    expect(response.json.error?.data?.details?.reason).not.toBe(
      'bounded_composite_resource_unsupported',
    );
    expect(world.native).toHaveBeenCalledOnce();
  } finally {
    await world.daemon.close();
  }
});

test('nested bounded test refuses resource work while direct test retains native authority', async () => {
  const world = await resourceAdmissionWorld();
  try {
    world.sessionStore.retire(world.ref);
    const script = path.join(world.daemon.stateDir, 'suite-resource.ad');
    const source = {
      entry: script,
      files: { [script]: 'open com.android.settings\nperf memory snapshot\n' },
    };
    fs.writeFileSync(script, 'open com.android.settings\nperf memory snapshot\n');
    const flags = {
      replayScriptSources: [source],
      artifactsDir: path.join(world.daemon.stateDir, 'suite-artifacts'),
    };
    const nested = await world.call('batch', [], {
      batchSteps: [{ command: 'test', positionals: [script], flags }],
    });
    expect(JSON.stringify(nested.json)).toContain('bounded_composite_resource_unsupported');
    const nestedDetails = nested.json.result.data.results[0].data.failures[0].error.details;
    expect(nestedDetails.standaloneCommandName).toBe('test');
    expect(nestedDetails).not.toHaveProperty('standaloneCommand');
    expect(nestedDetails.divergence.cause.hint).toContain('original test');
    expect(nestedDetails.divergence.cause.hint).toContain('live outer session');
    expect(nestedDetails.divergence.cause.hint).not.toContain('attempt-1');
    expect(nestedDetails.divergence.screen.hint).toBe(nestedDetails.divergence.cause.hint);
    expect(world.native).not.toHaveBeenCalled();
    const direct = await world.call('test', [script], flags);
    expect(JSON.stringify(direct.json)).not.toContain('bounded_composite_resource_unsupported');
    expect(world.native).toHaveBeenCalledOnce();
  } finally {
    await world.daemon.close();
  }
});

test.each(['cli', 'manifest'] as const)(
  'bounded nested test stops after typed resource refusal with %s retries',
  async (retrySource) => {
    const world = await resourceAdmissionWorld();
    try {
      world.sessionStore.retire(world.ref);
      const script = path.join(world.daemon.stateDir, 'retry-resource.ad');
      const contents =
        `context platform=android${retrySource === 'manifest' ? ' retries=2' : ''}\n` +
        'open com.android.settings\nhome\nperf memory snapshot\n';
      fs.writeFileSync(script, contents);
      const response = await world.call('batch', [], {
        batchSteps: [
          {
            command: 'test',
            positionals: [script],
            flags: {
              replayScriptSources: [{ entry: script, files: { [script]: contents } }],
              artifactsDir: path.join(world.daemon.stateDir, 'retry-artifacts'),
              ...(retrySource === 'cli' ? { retries: 2 } : {}),
            },
          },
        ],
      });
      const suite = response.json.result.data.results[0].data;
      expect(suite).toMatchObject({ failed: 1, executed: 1 });
      expect(world.home).toHaveBeenCalledOnce();
      expect(suite.failures[0]).toMatchObject({
        attempts: 1,
        error: {
          details: {
            reason: 'bounded_composite_resource_unsupported',
            shape: 'perf:memory-snapshot',
            dispatched: 'no',
            divergence: {
              step: { index: 3, source: { path: script, line: 4 } },
              screen: { state: 'unavailable', reason: 'bounded-composite-resource-unsupported' },
            },
          },
        },
      });
      expect(suite.failures[0].error.details.divergence.cause.hint).toContain('original test');
      expect(suite.failures[0].error.details.divergence.cause.hint).not.toContain('attempt-1');
      expect(world.native).not.toHaveBeenCalled();
      expect(world.sessionStore.listRefs()).toHaveLength(0);
    } finally {
      await world.daemon.close();
    }
  },
);

test('direct unbounded test keeps ordinary retries after a resource step fails', async () => {
  const world = await resourceAdmissionWorld();
  try {
    world.sessionStore.retire(world.ref);
    const script = path.join(world.daemon.stateDir, 'direct-retry-resource.ad');
    const contents =
      'context platform=android\nopen com.android.settings\nhome\nperf memory snapshot\n';
    fs.writeFileSync(script, contents);
    const response = await world.call('test', [script], {
      retries: 2,
      replayScriptSources: [{ entry: script, files: { [script]: contents } }],
      artifactsDir: path.join(world.daemon.stateDir, 'direct-retry-artifacts'),
    });
    const suite = response.json.result.data;
    expect(suite).toMatchObject({ failed: 1, executed: 1 });
    expect(suite.failures[0]).toMatchObject({ attempts: 3 });
    expect(suite.failures[0].error.details?.reason).not.toBe(
      'bounded_composite_resource_unsupported',
    );
    expect(world.home).toHaveBeenCalledTimes(3);
    expect(world.native).toHaveBeenCalledTimes(3);
    expect(world.sessionStore.listRefs()).toHaveLength(0);
  } finally {
    await world.daemon.close();
  }
});

test('resource-free nested test keeps retries for an ordinary failure', async () => {
  const world = await resourceAdmissionWorld();
  try {
    world.sessionStore.retire(world.ref);
    const script = path.join(world.daemon.stateDir, 'nested-ordinary-retry.ad');
    const contents =
      'context platform=android\nopen com.android.settings\nhome\npress id="never-present"\n';
    fs.writeFileSync(script, contents);
    const response = await world.call('batch', [], {
      batchSteps: [
        {
          command: 'test',
          positionals: [script],
          flags: {
            retries: 2,
            replayScriptSources: [{ entry: script, files: { [script]: contents } }],
            artifactsDir: path.join(world.daemon.stateDir, 'ordinary-retry-artifacts'),
          },
        },
      ],
    });
    const suite = response.json.result.data.results[0].data;
    expect(suite.failures[0]).toMatchObject({ attempts: 3 });
    expect(suite.failures[0].error.details?.reason).not.toBe(
      'bounded_composite_resource_unsupported',
    );
    expect(world.home).toHaveBeenCalledTimes(3);
    expect(world.sessionStore.listRefs()).toHaveLength(0);
  } finally {
    await world.daemon.close();
  }
});

test('bounded test cleanup retires an attempt with another durable resource and keeps the primary refusal', async () => {
  const world = await resourceAdmissionWorld();
  try {
    world.sessionStore.retire(world.ref);
    const publish = world.sessionStore.publish.bind(world.sessionStore);
    const adopted: ReturnType<typeof seedExistingCapture>[] = [];
    vi.spyOn(world.sessionStore, 'publish').mockImplementation((address, session) => {
      const ref = publish(address, session);
      if (address !== world.ref.address)
        adopted.push(seedExistingCapture(world, 'audio-probe', ref));
      return ref;
    });
    const script = path.join(world.daemon.stateDir, 'suite-extra-resource.ad');
    const contents = 'open com.android.settings\nperf memory snapshot\n';
    fs.writeFileSync(script, contents);
    const response = await world.call('batch', [], {
      batchSteps: [
        {
          command: 'test',
          positionals: [script],
          flags: {
            replayScriptSources: [{ entry: script, files: { [script]: contents } }],
            artifactsDir: path.join(world.daemon.stateDir, 'suite-extra-resource-artifacts'),
          },
        },
      ],
    });
    expect(JSON.stringify(response.json)).toContain('bounded_composite_resource_unsupported');
    expect(JSON.stringify(response.json)).toContain('perf:memory-snapshot');
    const details = response.json.result.data.results[0].data.failures[0].error.details;
    expect(details.standaloneCommandName).toBe('test');
    expect(details).not.toHaveProperty('standaloneCommand');
    expect(details.divergence.cause.hint).toContain('original test');
    expect(details.divergence.cause.hint).toContain('live outer session');
    expect(details.divergence.cause.hint).not.toContain('attempt-1');
    expect(details.divergence.screen.hint).toBe(details.divergence.cause.hint);
    expect(adopted).toHaveLength(1);
    expect(adopted[0]!.finish).toHaveBeenCalled();
    expect(world.sessionStore.listRefs()).toHaveLength(0);
    expect(world.native).not.toHaveBeenCalled();
  } finally {
    await world.daemon.close();
  }
});

test.each(['attempt-timeout', 'record-video'] as const)(
  'bounded test refuses %s before suite/native effects',
  async (shape) => {
    const world = await resourceAdmissionWorld();
    try {
      const response = await world.call('batch', [], {
        batchSteps: [
          {
            command: 'test',
            positionals: ['/unused.ad'],
            flags: shape === 'attempt-timeout' ? { timeoutMs: 1 } : { recordVideo: true },
          },
        ],
      });
      expect(response.json.error?.data?.details).toMatchObject({
        reason: 'bounded_composite_resource_unsupported',
        shape: `test:${shape}`,
        executed: 0,
      });
      expect(world.bind).not.toHaveBeenCalled();
      expect(world.native).not.toHaveBeenCalled();
    } finally {
      await world.daemon.close();
    }
  },
);

test.each([
  ['context', 'context timeout=4000\nopen com.android.settings\n'],
  ['split header', 'context platform=android\ncontext timeout=4000\nopen com.android.settings\n'],
] as const)(
  'bounded test inspects %s timeout in a later source before any attempt',
  async (_kind, timedScript) => {
    const world = await resourceAdmissionWorld();
    try {
      const first = path.join(world.daemon.stateDir, 'first.ad');
      const second = path.join(world.daemon.stateDir, 'second.ad');
      const response = await world.call('batch', [], {
        batchSteps: [
          {
            command: 'test',
            positionals: [first, second],
            flags: {
              replayScriptSources: [
                { entry: first, files: { [first]: 'open com.android.settings\n' } },
                {
                  entry: second,
                  files: {
                    [second]: timedScript,
                  },
                },
              ],
              artifactsDir: path.join(world.daemon.stateDir, 'suite-artifacts'),
            },
          },
        ],
      });
      expect(response.json.error?.data?.details).toMatchObject({
        reason: 'bounded_composite_resource_unsupported',
        shape: 'test:attempt-timeout',
        dispatched: 'no',
        executed: 0,
      });
      expect(world.bind).not.toHaveBeenCalled();
      expect(world.native).not.toHaveBeenCalled();
    } finally {
      await world.daemon.close();
    }
  },
);

test.each(['batch', 'replay'] as const)(
  '%s refuses its first resource step after normal outer lease admission and no step admission',
  async (composite) => {
    const allowed = await resourceAdmissionWorld();
    const refused = await resourceAdmissionWorld();
    try {
      const attachLease = (world: typeof allowed) => {
        const lease = world.leaseRegistry.allocateLease({ tenantId: 'tenant-a', runId: 'run-a' });
        world.sessionStore.update(world.ref, {
          lease: {
            leaseId: lease.leaseId,
            tenantId: lease.tenantId,
            runId: lease.runId,
            leaseBackend: lease.backend,
          },
        });
        return lease;
      };
      const allowedLease = attachLease(allowed);
      const refusedLease = attachLease(refused);
      const allowedHeartbeat = vi.spyOn(allowed.leaseRegistry, 'heartbeatLease');
      const refusedHeartbeat = vi.spyOn(refused.leaseRegistry, 'heartbeatLease');
      const refusedConsume = vi.spyOn(refused.leaseRegistry, 'consumeExpiredLease');
      assertRpcOk(
        await allowed.call('batch', [], {
          batchSteps: [{ command: 'home' }],
        }),
      );
      const script = path.join(refused.daemon.stateDir, 'first-resource.ad');
      const response = await refused.call(
        composite,
        composite === 'batch' ? [] : [script],
        composite === 'batch'
          ? { batchSteps: [{ command: 'record', positionals: ['start'] }] }
          : {
              replayScriptSource: {
                entry: script,
                files: { [script]: 'record start\n' },
              },
            },
      );
      expect(response.json.error?.data?.details).toMatchObject({
        reason: 'bounded_composite_resource_unsupported',
        shape: 'record:start',
        dispatched: 'no',
      });
      if (composite === 'batch') {
        expect(response.json.error.data.details).toMatchObject({ executed: 0 });
      } else {
        expect(response.json.error.data.details).toMatchObject({
          divergence: { step: { source: { path: script, line: 1 } } },
        });
      }
      expect(allowedHeartbeat).toHaveBeenCalledTimes(2);
      expect(refusedHeartbeat).toHaveBeenCalledOnce();
      expect(refusedHeartbeat).toHaveBeenCalledWith(
        expect.objectContaining({ leaseId: refusedLease.leaseId }),
      );
      expect(refusedConsume).toHaveBeenCalledOnce();
      expect(refused.leaseRegistry.getLease(refusedLease)).toMatchObject({
        leaseId: refusedLease.leaseId,
      });
      expect(allowed.leaseRegistry.getLease(allowedLease)).toMatchObject({
        leaseId: allowedLease.leaseId,
      });
      expect(allowed.sessionStore.requireCurrent(allowed.ref)).toMatchObject({
        lastActivityAtMs: expect.any(Number),
      });
      expect(refused.sessionStore.requireCurrent(refused.ref)).toMatchObject({
        lease: { leaseId: refusedLease.leaseId },
        lastActivityAtMs: expect.any(Number),
      });
      expect(refused.sessionStore.requireCurrent(refused.ref).screenRecording).toBeUndefined();
      expect(refused.bind).not.toHaveBeenCalled();
      expect(refused.native).not.toHaveBeenCalled();
      expect(refused.finish).not.toHaveBeenCalled();
      expect(refused.forceCleanup).not.toHaveBeenCalled();
    } finally {
      await refused.daemon.close();
      await allowed.daemon.close();
    }
  },
);

test.each(['status', 'stop'] as const)(
  'audio capture %s refuses before a completed probe can dispose',
  async (action) => {
    const world = await resourceAdmissionWorld();
    try {
      const owned = seedExistingCapture(world, 'audio-probe');
      const status = world.sessionStore.requireCurrent(world.ref).audioProbe!.handle.status;
      const response = await world.call('batch', [], {
        batchSteps: [{ command: 'audio', positionals: ['probe', action] }],
      });
      expect(response.json.error?.data?.details).toMatchObject({
        reason: 'bounded_composite_resource_unsupported',
        shape: `audio:capture-${action}`,
      });
      expect(status).not.toHaveBeenCalled();
      expect(owned.finish).not.toHaveBeenCalled();
      expect(owned.forceCleanup).not.toHaveBeenCalled();
      expect(world.bind).not.toHaveBeenCalled();
    } finally {
      await world.daemon.close();
    }
  },
);

test('record stop-live is refused before export or native stop', async () => {
  const world = await resourceAdmissionWorld();
  try {
    const owned = seedExistingCapture(world, 'screen-recording');
    const response = await world.call('batch', [], {
      batchSteps: [{ command: 'record', positionals: ['stop'] }],
    });
    expect(response.json.error?.data?.details).toMatchObject({
      reason: 'bounded_composite_resource_unsupported',
      shape: 'record:stop-live',
    });
    expect(owned.finish).not.toHaveBeenCalled();
    expect(owned.forceCleanup).not.toHaveBeenCalled();
    expect(world.bind).not.toHaveBeenCalled();
  } finally {
    await world.daemon.close();
  }
});

test.each(['frames', 'memory-sample'] as const)(
  'unproven provider-native perf %s refuses before binding',
  async (shape) => {
    const world = await resourceAdmissionWorld('capture', { providerOwned: true });
    try {
      const response = await world.call('batch', [], {
        batchSteps: [
          { command: 'perf', positionals: shape === 'frames' ? ['frames'] : ['memory', 'sample'] },
        ],
      });
      expect(response.json.error?.data?.details).toMatchObject({
        reason: 'bounded_composite_resource_unsupported',
        shape: `perf:${shape}`,
      });
      expect(world.bind).not.toHaveBeenCalled();
      expect(world.sample).not.toHaveBeenCalled();
    } finally {
      await world.daemon.close();
    }
  },
);

test('web audio query is assessed separately from capture and refuses before binding', async () => {
  const world = await resourceAdmissionWorld('query', { device: WEB_DESKTOP_DEVICE });
  try {
    const response = await world.call('batch', [], {
      batchSteps: [{ command: 'audio', positionals: ['probe', 'status'] }],
    });
    expect(response.json.error?.data?.details).toMatchObject({
      reason: 'bounded_composite_resource_unsupported',
      shape: 'audio:query',
    });
    expect(world.bind).not.toHaveBeenCalled();
    expect(world.inspectFacts).not.toHaveBeenCalled();
    expect(world.native).not.toHaveBeenCalled();
  } finally {
    await world.daemon.close();
  }
});
