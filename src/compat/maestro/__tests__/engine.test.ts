import { describe, expect, test, vi } from 'vitest';
import { AppError } from '../../../kernel/errors.ts';
import { maestroTestFailure } from '../compatibility-errors.ts';
import { parseMaestroProgram } from '../program-ir-parser.ts';
import type {
  MaestroObservation,
  MaestroRuntimePort,
  MaestroRuntimeRequest,
  MaestroRuntimeResult,
} from '../engine-types.ts';
import { executeMaestroProgram } from './runtime-port-fixtures.ts';

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
      env: {},
      generation: 0,
      invalidateObservation: expect.any(Function),
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

  test('continues after optional assertion and target misses', async () => {
    const execute = vi.fn(async (request: MaestroRuntimeRequest) => {
      request.invalidateObservation();
      return {};
    });
    const port = makePort({
      observe: vi.fn(async ({ generation }) => ({ generation, matched: false })),
      execute,
    });
    const program = parseMaestroProgram(
      [
        '---',
        '- assertVisible:',
        '    text: Missing assertion',
        '    optional: true',
        '- doubleTapOn:',
        '    text: Missing target',
        '    optional: true',
        '- inputText: continued',
      ].join('\n'),
    );
    execute.mockImplementationOnce(async () => {
      throw maestroTestFailure('Maestro target did not resolve to a visible element.');
    });

    const result = await executeMaestroProgram(program, port);

    expect(result).toMatchObject({
      executed: 1,
      skipped: 2,
    });
    expect(result.warnings).toEqual([
      expect.stringMatching(/Optional Maestro assertVisible skipped at line 2/),
      expect.stringMatching(/Optional Maestro doubleTapOn skipped at line 5/),
    ]);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ kind: 'inputText', text: 'continued' }),
      }),
    );
  });

  test('continues after optional scrollUntilVisible and extendedWaitUntil misses', async () => {
    const execute = vi.fn(async (request: MaestroRuntimeRequest) => {
      request.invalidateObservation();
      return {};
    });
    const port = makePort({
      observe: vi.fn(async ({ generation }) => ({ generation, matched: false })),
      execute,
    });
    const program = parseMaestroProgram(
      [
        '---',
        '- scrollUntilVisible:',
        '    element:',
        '      id: missing',
        '      optional: true',
        '- extendedWaitUntil:',
        '    visible:',
        '      text: Missing',
        '      optional: true',
        '    timeout: 1',
        '- inputText: continued',
      ].join('\n'),
    );
    execute.mockImplementationOnce(async () => {
      throw maestroTestFailure('Maestro scrollUntilVisible target did not become visible.');
    });

    const result = await executeMaestroProgram(program, port);

    expect(result).toMatchObject({
      executed: 1,
      skipped: 2,
    });
    expect(result.warnings).toEqual([
      expect.stringMatching(/Optional Maestro scrollUntilVisible skipped at line 2/),
      expect.stringMatching(/Optional Maestro extendedWaitUntil skipped at line 6/),
    ]);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ kind: 'inputText', text: 'continued' }),
      }),
    );
  });

  test('propagates AMBIGUOUS_MATCH from an optional target command', async () => {
    const ambiguous = new AppError('AMBIGUOUS_MATCH', 'multiple target matches');
    const execute = vi.fn(async () => {
      throw ambiguous;
    });
    const program = parseMaestroProgram(
      ['---', '- doubleTapOn:', '    text: Submit', '    optional: true'].join('\n'),
    );

    await expect(executeMaestroProgram(program, makePort({ execute }))).rejects.toMatchObject({
      code: 'AMBIGUOUS_MATCH',
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  test('invalidates cached observations when a failed runtime operation says it may have changed', async () => {
    const attempts: MaestroRuntimeRequest[] = [];
    const observation: MaestroObservation = { generation: 0, matched: true };
    const port = makePort({
      observe: vi.fn(async () => observation),
      execute: vi.fn(async (request) => {
        attempts.push(request);
        if (attempts.length === 1) {
          request.invalidateObservation();
          throw maestroTestFailure('retry me');
        }
        request.invalidateObservation();
        return {};
      }),
    });
    const program = parseMaestroProgram(
      [
        '---',
        '- assertVisible: Ready',
        '- retry:',
        '    maxRetries: 1',
        '    commands:',
        '      - tapOn: Retry',
      ].join('\n'),
    );

    const result = await executeMaestroProgram(program, port);

    expect(attempts[0]).toMatchObject({ generation: 0, cachedObservation: observation });
    expect(attempts[1]).toMatchObject({ generation: 1 });
    expect(attempts[1]).not.toHaveProperty('cachedObservation');
    expect(result.generation).toBe(2);
  });

  test('caps retry blocks at the upstream Maestro retry preset', async () => {
    const execute = vi.fn(async (request: MaestroRuntimeRequest) => {
      request.invalidateObservation();
      throw maestroTestFailure('retry me');
    });
    const program = parseMaestroProgram(
      ['---', '- retry:', '    maxRetries: 99', '    commands:', '      - tapOn: Retry'].join('\n'),
    );

    await expect(executeMaestroProgram(program, makePort({ execute }))).rejects.toThrow('retry me');

    expect(execute).toHaveBeenCalledTimes(4);
  });

  test('does not retry infrastructure or ambiguous dispatch failures', async () => {
    const execute = vi.fn(async () => {
      throw new AppError('COMMAND_FAILED', 'dispatch outcome is unknown');
    });
    const program = parseMaestroProgram(
      ['---', '- retry:', '    maxRetries: 3', '    commands:', '      - tapOn: Submit'].join('\n'),
    );

    await expect(executeMaestroProgram(program, makePort({ execute }))).rejects.toThrow(
      'dispatch outcome is unknown',
    );
    expect(execute).toHaveBeenCalledOnce();
  });

  test('observer callbacks cannot alter successful execution', async () => {
    const observer = {
      commandStarted: vi.fn(() => {
        throw new Error('start observer failed');
      }),
      commandCompleted: vi.fn(() => {
        throw new Error('complete observer failed');
      }),
    };
    const program = parseMaestroProgram('---\n- back\n');

    await expect(executeMaestroProgram(program, makePort(), { observer })).resolves.toMatchObject({
      executed: 1,
    });
    expect(observer.commandStarted).toHaveBeenCalledOnce();
    expect(observer.commandCompleted).toHaveBeenCalledOnce();
  });

  test('observer failure cannot mask nested leaf failure provenance', async () => {
    const execute = vi.fn(async (request: MaestroRuntimeRequest) => {
      request.invalidateObservation();
      throw new AppError('COMMAND_FAILED', 'leaf command failed');
    });
    const observer = {
      commandFailed: vi.fn(() => {
        throw new Error('failure observer failed');
      }),
    };
    const program = parseMaestroProgram(
      ['---', '- retry:', '    maxRetries: 0', '    commands:', '      - tapOn: Leaf'].join('\n'),
    );

    await expect(
      executeMaestroProgram(program, makePort({ execute }), { observer }),
    ).rejects.toThrow('leaf command failed');
    expect(observer.commandFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ kind: 'tapOn' }),
        source: { line: 5 },
      }),
    );
  });

  test('owns hooks, includes, scoped env, output env, repeat, and retry', async () => {
    const executed: MaestroRuntimeRequest[] = [];
    let failingAttempts = 0;
    const port = makePort({
      execute: vi.fn(async (request) => {
        executed.push(request);
        if (request.command.kind === 'runScript') {
          return { outputEnv: { TOKEN: 'generated' } };
        }
        if (
          request.command.kind === 'tapOn' &&
          request.command.target.space === 'target' &&
          request.command.target.selector.text === 'Retry'
        ) {
          failingAttempts += 1;
          if (failingAttempts === 1) throw maestroTestFailure('retry me');
        }
        if (request.command.kind !== 'takeScreenshot') request.invalidateObservation();
        return {};
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
          return { outputEnv: { OUTPUT: 'generated' } };
        }
        request.invalidateObservation();
        return {};
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

  test('resolves script output inside an opaque control body only after the script executes', async () => {
    const texts: string[] = [];
    const port = makePort({
      execute: vi.fn(async (request) => {
        if (request.command.kind === 'runScript') {
          return { outputEnv: { 'output.token': 'ready' } };
        }
        if (request.command.kind === 'inputText') texts.push(request.command.text);
        request.invalidateObservation();
        return {};
      }),
    });
    const program = parseMaestroProgram(
      [
        '---',
        '- repeat:',
        '    times: 1',
        '    commands:',
        '      - runScript: setup.js',
        '      - inputText: ${output.token}',
      ].join('\n'),
    );

    await executeMaestroProgram(program, port);

    expect(texts).toEqual(['ready']);
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
      return {};
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
    execute: vi.fn(async (request): Promise<MaestroRuntimeResult> => {
      const { command } = request;
      if (
        command.kind !== 'takeScreenshot' &&
        command.kind !== 'runScript' &&
        command.kind !== 'waitForAnimationToEnd'
      ) {
        request.invalidateObservation();
      }
      return command.kind === 'takeScreenshot' ? { artifactPaths: [command.path] } : {};
    }),
    observe: vi.fn(async ({ generation }) => ({ generation, matched: true })),
    ...overrides,
  };
}
