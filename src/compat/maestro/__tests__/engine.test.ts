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
        const observation = { generation, matched: true, evidence: { generation } };
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
