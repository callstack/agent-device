import { describe, expect, test, vi } from 'vitest';
import { executeMaestroProgram } from '../engine.ts';
import type { MaestroRuntimePort } from '../engine-types.ts';
import { parseMaestroProgram } from '../program-ir-parser.ts';
import { compileMaestroReplayPlan, evaluateMaestroReplayResume } from '../replay-plan.ts';

describe('typed Maestro replay plan', () => {
  test('expands static hooks, includes, and repeats while retaining dynamic controls', async () => {
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
      defaults: { BUILTIN: 'default' },
      env: { INCLUDE: 'child.yaml', FLOW: 'runtime' },
      loadProgram,
    });

    expect(plan.steps.map((step) => step.command.kind)).toEqual([
      'inputText',
      'back',
      'back',
      'inputText',
      'retry',
      'runScript',
      'inputText',
    ]);
    expect(plan.steps[3]?.source.path).toBe('/flows/child.yaml');
    expect(plan.steps[4]).toMatchObject({
      kind: 'opaque',
      body: [expect.objectContaining({ command: expect.objectContaining({ kind: 'inputText' }) })],
    });
    expect(plan.initialStaticEnv).toEqual({
      BUILTIN: 'default',
      FLOW: 'runtime',
      INCLUDE: 'child.yaml',
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

    expect(evaluateMaestroReplayResume(plan, { from: 4, planDigest: plan.digest })).toEqual({
      allowed: true,
      startIndex: 3,
    });
    expect(evaluateMaestroReplayResume(plan, { from: 5, planDigest: plan.digest })).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('cannot be resumed'),
    });
    expect(evaluateMaestroReplayResume(plan, { from: 6, planDigest: plan.digest })).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('cannot be skipped'),
    });
  });

  test('executes from a stable plan index and reports plan ordinals', async () => {
    const program = parseMaestroProgram('---\n- inputText: first\n- inputText: second\n');
    const execute = vi.fn(async () => ({ mutated: true }));
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
