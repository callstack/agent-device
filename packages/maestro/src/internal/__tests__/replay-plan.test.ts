import { describe, expect, test, vi } from 'vitest';
import type { MaestroRuntimePort } from '../engine-types.ts';
import { parseMaestroProgram } from '../program-ir-parser.ts';
import { compileMaestroReplayPlan, evaluateMaestroReplayResume } from '../replay-plan.ts';
import { executeMaestroProgram } from './runtime-port-fixtures.ts';

describe('typed Maestro replay plan', () => {
  test('expands static hooks and includes while retaining runtime controls', async () => {
    const child = parseMaestroProgram('---\n- inputText: child\n', {
      sourcePath: '/flows/child.yaml',
    });
    const program = parseMaestroProgram(
      [
        'appId: com.example.app',
        'env:',
        '  FLOW: config',
        'onFlowStart:',
        '  - inputText: start',
        'onFlowComplete:',
        '  - inputText: complete',
        '---',
        '- repeat:',
        '    times: 2',
        '    commands:',
        '      - back',
        '- runFlow: ${INCLUDE}',
        '- runFlow:',
        '    when:',
        '      platform: iOS',
        '    commands:',
        '      - inputText: omitted',
        '- retry:',
        '    maxRetries: 1',
        '    commands:',
        '      - inputText: retry-body',
        '- runScript: setup.js',
      ].join('\n'),
      { sourcePath: '/flows/main.yaml' },
    );
    const loadProgram = vi.fn(async () => child);

    const plan = await compileMaestroReplayPlan(program, {
      platform: 'android',
      target: 'simulator',
      runtimeHints: { platform: 'android', metroHost: '127.0.0.1', metroPort: 8083 },
      defaults: { BUILTIN: 'default' },
      env: { INCLUDE: 'child.yaml', FLOW: 'runtime' },
      loadProgram,
    });

    expect(plan.steps.map((step) => step.command.kind)).toEqual([
      'inputText',
      'repeat',
      'inputText',
      'retry',
      'runScript',
      'inputText',
    ]);
    expect(plan.steps[1]).toMatchObject({
      kind: 'opaque',
      command: { kind: 'repeat', times: 2 },
      body: [expect.objectContaining({ command: expect.objectContaining({ kind: 'back' }) })],
    });
    expect(plan.steps[1]?.command).not.toHaveProperty('commands');
    expect(plan.steps[2]?.source.path).toBe('/flows/child.yaml');
    expect(plan.steps[3]).toMatchObject({
      kind: 'opaque',
      command: { kind: 'retry', maxRetries: 1 },
      body: [expect.objectContaining({ command: expect.objectContaining({ kind: 'inputText' }) })],
    });
    expect(plan.steps[3]?.command).not.toHaveProperty('commands');
    expect(plan.initialStaticEnv).toEqual({
      BUILTIN: 'default',
      FLOW: 'runtime',
      INCLUDE: 'child.yaml',
    });
    expect(plan.runtimeHints).toEqual({
      platform: 'android',
      metroHost: '127.0.0.1',
      metroPort: 8083,
    });
    expect(loadProgram).toHaveBeenCalledWith('child.yaml', '/flows/main.yaml');
    expect(Object.isFrozen(plan)).toBe(true);

    const changed = await compileMaestroReplayPlan(program, {
      platform: 'android',
      target: 'simulator',
      env: { INCLUDE: 'other.yaml' },
      loadProgram,
    });
    expect(changed.digest).not.toBe(plan.digest);

    const changedRuntime = await compileMaestroReplayPlan(program, {
      platform: 'android',
      target: 'simulator',
      runtimeHints: { platform: 'android', metroHost: '127.0.0.1', metroPort: 8084 },
      defaults: { BUILTIN: 'default' },
      env: { INCLUDE: 'child.yaml', FLOW: 'runtime' },
      loadProgram,
    });
    expect(changedRuntime.digest).not.toBe(plan.digest);

    expect(evaluateMaestroReplayResume(plan, { from: 2, planDigest: plan.digest })).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('cannot be resumed'),
    });
    expect(evaluateMaestroReplayResume(plan, { from: 3, planDigest: plan.digest })).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('cannot be skipped safely'),
    });
  });

  test('executes from a stable plan index and reports plan ordinals', async () => {
    const program = parseMaestroProgram('---\n- inputText: first\n- inputText: second\n');
    const execute = vi.fn(async (request) => {
      request.invalidateObservation();
      return {};
    });
    const observer = { commandStarted: vi.fn() };
    const port: MaestroRuntimePort = {
      execute,
      observe: vi.fn(async ({ generation }) => ({ generation, matched: true })),
    };

    const initialPlan = await compileMaestroReplayPlan(program);
    await executeMaestroProgram(program, port, {
      from: 2,
      planDigest: initialPlan.digest,
      observer,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ text: 'second' }),
        env: {},
      }),
    );
    expect(observer.commandStarted).toHaveBeenCalledWith(
      expect.objectContaining({ stepIndex: 2, stepTotal: 2 }),
    );
  });
});
