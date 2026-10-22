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
        standaloneCommand: expect.stringContaining(`agent-device ${command}`),
      });
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
  const world = await resourceAdmissionWorld('capture', [], { device: WEB_DESKTOP_DEVICE });
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
      standaloneCommand: 'agent-device prepare --session resource-session',
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
        standaloneCommand: `agent-device ${command} ${args.join(' ')} --session resource-session`,
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
  const world = await resourceAdmissionWorld('capture', [], { device: IOS_SIMULATOR });
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
        standaloneCommand: 'agent-device record start --session resource-session',
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

test('a completed snapshot precedes a refused record step with its public options', async () => {
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
      standaloneCommand:
        "agent-device record start 'clips/record a.mp4' --fps 30 --session resource-session",
      partialResults: [{ command: 'snapshot', ok: true }],
    });
    expect(world.native).not.toHaveBeenCalled();
    expect(world.finish).not.toHaveBeenCalled();
  } finally {
    await world.daemon.close();
  }
});

test('replay projects daemon perf positionals into public --kind form', async () => {
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
      standaloneCommand:
        'agent-device perf cpu profile start --kind xctrace --session resource-session',
      divergence: { step: { source: { path: script, line: 2 } } },
    });
    expect(world.native).not.toHaveBeenCalled();
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
    expect(JSON.stringify(nested.json)).toContain('agent-device test');
    expect(JSON.stringify(nested.json)).toContain('--session resource-session');
    const nestedDetails = nested.json.result.data.results[0].data.failures[0].error.details;
    expect(nestedDetails.standaloneCommand).toContain(`agent-device test ${script}`);
    expect(nestedDetails.divergence.cause.hint).toContain('agent-device test');
    expect(nestedDetails.divergence.cause.hint).not.toContain('agent-device perf');
    expect(world.native).not.toHaveBeenCalled();
    const direct = await world.call('test', [script], flags);
    expect(JSON.stringify(direct.json)).not.toContain('bounded_composite_resource_unsupported');
    expect(world.native).toHaveBeenCalledOnce();
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
    expect(JSON.stringify(response.json)).toContain('agent-device test');
    expect(JSON.stringify(response.json)).toContain('--session resource-session');
    const details = response.json.result.data.results[0].data.failures[0].error.details;
    expect(details.standaloneCommand).toContain(`agent-device test ${script}`);
    expect(details.divergence.cause.hint).toContain('agent-device test');
    expect(details.divergence.cause.hint).not.toContain('agent-device perf');
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
    const world = await resourceAdmissionWorld('capture', [], { providerOwned: true });
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
  const world = await resourceAdmissionWorld('query', [], { device: WEB_DESKTOP_DEVICE });
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
