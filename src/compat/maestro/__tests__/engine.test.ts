import { describe, expect, test, vi } from 'vitest';
import { AppError } from '../../../kernel/errors.ts';
import { executeMaestroProgram } from '../engine.ts';
import { parseMaestroProgram } from '../program-ir-parser.ts';
import type {
  MaestroObservation,
  MaestroRuntimePort,
  MaestroRuntimeRequest,
  MaestroRuntimeResult,
} from '../engine-types.ts';

describe('executeMaestroProgram', () => {
  test('preserves authored percentage swipe intent without observing', async () => {
    const port = makePort();
    const program = parseMaestroProgram(
      ['---', '- swipe:', '    start: 90%, 50%', '    end: 10%, 50%', '    duration: 100'].join(
        '\n',
      ),
    );

    const result = await executeMaestroProgram(program, port);

    expect(port.execute).toHaveBeenCalledWith({
      command: {
        kind: 'swipe',
        source: { line: 2 },
        gesture: {
          kind: 'coordinates',
          start: { space: 'percent', x: 90, y: 50 },
          end: { space: 'percent', x: 10, y: 50 },
          duration: 100,
        },
      },
      generation: 0,
    });
    expect(port.observe).not.toHaveBeenCalled();
    expect(result).toEqual({ executed: 1, skipped: 0, generation: 1, artifactPaths: [] });
  });

  test('reuses observations within a generation and invalidates them after mutation', async () => {
    const observations: MaestroObservation[] = [];
    const port = makePort({
      observe: vi.fn(async ({ generation }) => {
        const observation = {
          generation,
          matched: true,
          evidence: {
            kind: 'selector' as const,
            selector: { text: 'Ready' },
            visible: true,
            candidateCount: 1,
          },
        };
        observations.push(observation);
        return observation;
      }),
    });
    const program = parseMaestroProgram(
      [
        '---',
        '- assertVisible: Ready',
        '- assertVisible:',
        '    id: ready',
        '- tapOn:',
        '    id: continue',
        '- assertVisible: Done',
      ].join('\n'),
    );

    const result = await executeMaestroProgram(program, port);

    expect(port.observe).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ generation: 0, cachedObservation: observations[0] }),
    );
    expect(port.execute).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 0, cachedObservation: observations[1] }),
    );
    expect(port.observe).toHaveBeenNthCalledWith(
      3,
      expect.not.objectContaining({ cachedObservation: expect.anything() }),
    );
    expect(result.generation).toBe(1);
  });

  test('owns hooks, includes, scoped env, output env, repeat, and retry', async () => {
    const executed: MaestroRuntimeRequest[] = [];
    let failingAttempts = 0;
    const port = makePort({
      execute: vi.fn(async (request) => {
        executed.push(request);
        if (request.command.kind === 'runScript') {
          return { mutated: false, outputEnv: { TOKEN: 'generated' } };
        }
        if (
          request.command.kind === 'tapOn' &&
          request.command.target.space === 'target' &&
          request.command.target.selector.text === 'Retry'
        ) {
          failingAttempts += 1;
          if (failingAttempts === 1) throw new AppError('COMMAND_FAILED', 'retry me');
        }
        return { mutated: request.command.kind !== 'takeScreenshot' };
      }),
    });
    const main = parseMaestroProgram(
      [
        'appId: root.app',
        'env:',
        '  COUNT: 2',
        'onFlowStart:',
        '  - launchApp',
        'onFlowComplete:',
        '  - takeScreenshot: final.png',
        '---',
        '- runScript: setup.js',
        '- runFlow:',
        '    file: child.yaml',
        '    env:',
        '      LABEL: ${TOKEN}',
      ].join('\n'),
      { sourcePath: '/flows/main.yaml' },
    );
    const child = parseMaestroProgram(
      [
        '---',
        '- repeat:',
        '    times: ${COUNT}',
        '    commands:',
        '      - tapOn: ${LABEL}',
        '- retry:',
        '    maxRetries: 1',
        '    commands:',
        '      - tapOn: Retry',
      ].join('\n'),
    );

    const result = await executeMaestroProgram(main, port, {
      loadProgram: vi.fn(async () => child),
    });

    expect(executed.filter((entry) => entry.command.kind === 'tapOn')).toHaveLength(4);
    expect(executed[0]).toEqual(
      expect.objectContaining({
        appId: 'root.app',
        command: expect.objectContaining({ kind: 'launchApp' }),
      }),
    );
    expect(
      executed.some(
        (entry) =>
          entry.command.kind === 'tapOn' &&
          entry.command.target.space === 'target' &&
          entry.command.target.selector.text === 'generated',
      ),
    ).toBe(true);
    expect(result.artifactPaths).toEqual([]);
    expect(executed.at(-1)?.command.kind).toBe('takeScreenshot');
  });

  test('skips false conditions without loading their programs', async () => {
    const loadProgram = vi.fn();
    const port = makePort();
    const program = parseMaestroProgram(
      ['---', '- runFlow:', '    file: ios.yaml', '    when:', '      platform: iOS'].join('\n'),
    );

    const result = await executeMaestroProgram(program, port, {
      platform: 'android',
      loadProgram,
    });

    expect(loadProgram).not.toHaveBeenCalled();
    expect(port.execute).not.toHaveBeenCalled();
    expect(result).toEqual({ executed: 0, skipped: 1, generation: 0, artifactPaths: [] });
  });

  test('rejects stale runtime observations with source context', async () => {
    const port = makePort({
      observe: vi.fn(async () => ({ generation: 9, matched: true })),
    });
    const program = parseMaestroProgram('---\n- assertVisible: Ready\n', {
      sourcePath: '/flows/stale.yaml',
    });

    await expect(executeMaestroProgram(program, port)).rejects.toThrow(
      /observation generation 9.*\/flows\/stale\.yaml:line 2/i,
    );
  });

  test('uses injected timing and deterministic when.true grammar', async () => {
    const controller = new AbortController();
    const observe = vi.fn(
      async ({ generation, condition }: Parameters<MaestroRuntimePort['observe']>[0]) => ({
        generation,
        matched: true,
        evidence: {
          kind: 'selector' as const,
          selector: condition.selector,
          visible: condition.kind === 'visible',
          candidateCount: 1,
        },
      }),
    );
    const port = makePort({ observe });
    const program = parseMaestroProgram(
      [
        '---',
        '- assertVisible: Ready',
        '- assertNotVisible: Gone',
        '- extendedWaitUntil:',
        '    visible: Done',
        '- runFlow:',
        '    when:',
        '      true: "${maestro.platform == \'ios\' && (true || false)}"',
        '      visible: Gate',
        '    commands:',
        '      - inputText: included',
        '- runFlow:',
        '    when:',
        '      true: "${maestro.platform == \'android\'}"',
        '    commands:',
        '      - inputText: skipped',
      ].join('\n'),
    );

    await executeMaestroProgram(program, port, {
      platform: 'ios',
      timing: {
        assertVisibleTimeoutMs: 101,
        assertNotVisibleTimeoutMs: 202,
        extendedWaitUntilTimeoutMs: 303,
        runFlowConditionTimeoutMs: 404,
      },
      signal: controller.signal,
    });

    expect(observe.mock.calls.map(([request]) => request.timeoutMs)).toEqual([101, 202, 303, 404]);
    expect(observe.mock.calls[0]?.[0].signal).toBe(controller.signal);
    expect(port.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ kind: 'inputText', text: 'included' }),
      }),
    );
    expect(port.execute).not.toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ kind: 'inputText', text: 'skipped' }),
      }),
    );
  });

  test('preserves output variables across scopes while runtime env wins', async () => {
    const seenTexts: string[] = [];
    const child = parseMaestroProgram(
      [
        'env:',
        '  CHILD_CONFIG: ${CHILD}',
        '  OVERRIDE: child',
        '---',
        '- inputText: ${CHILD_CONFIG}',
        '- inputText: ${OVERRIDE}',
        '- runScript: child.js',
      ].join('\n'),
    );
    const port = makePort({
      execute: vi.fn(async (request) => {
        if (request.command.kind === 'inputText') seenTexts.push(request.command.text);
        if (request.command.kind === 'runScript') {
          return { mutated: false, outputEnv: { OUTPUT: 'generated' } };
        }
        return { mutated: true };
      }),
    });
    const program = parseMaestroProgram(
      [
        'env:',
        '  BASE: parent',
        '  OVERRIDE: flow',
        '---',
        '- runFlow:',
        '    file: child.yaml',
        '    env:',
        '      CHILD: ${BASE}',
        '- inputText: ${OUTPUT}',
        '- inputText: ${OVERRIDE}',
      ].join('\n'),
    );

    await executeMaestroProgram(program, port, {
      env: { OVERRIDE: 'runtime' },
      loadProgram: vi.fn(async () => child),
    });

    expect(seenTexts).toEqual(['parent', 'runtime', 'generated', 'runtime']);
  });

  test('rejects recursive file includes before loading the child', async () => {
    const loadProgram = vi.fn();
    const program = parseMaestroProgram('---\n- runFlow: ./main.yaml\n', {
      sourcePath: '/flows/main.yaml',
    });

    await expect(executeMaestroProgram(program, makePort(), { loadProgram })).rejects.toThrow(
      /runFlow cycle detected.*\/flows\/main\.yaml/i,
    );
    expect(loadProgram).not.toHaveBeenCalled();
  });

  test('forwards AbortSignal and stops at the next cancellation checkpoint', async () => {
    const controller = new AbortController();
    const execute = vi.fn(async (_request: MaestroRuntimeRequest) => {
      controller.abort();
      return { mutated: false };
    });
    const port = makePort({ execute });
    const program = parseMaestroProgram('---\n- inputText: first\n- inputText: second\n');

    await expect(
      executeMaestroProgram(program, port, { signal: controller.signal }),
    ).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { reason: 'request_canceled' },
    });
    expect(port.execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0].signal).toBe(controller.signal);
  });
});

function makePort(overrides: Partial<MaestroRuntimePort> = {}): MaestroRuntimePort {
  return {
    execute: vi.fn(
      async ({ command }): Promise<MaestroRuntimeResult> => ({
        mutated:
          command.kind !== 'takeScreenshot' &&
          command.kind !== 'runScript' &&
          command.kind !== 'waitForAnimationToEnd',
        ...(command.kind === 'takeScreenshot' ? { artifactPaths: [command.path] } : {}),
      }),
    ),
    observe: vi.fn(async ({ generation }) => ({ generation, matched: true })),
    ...overrides,
  };
}
