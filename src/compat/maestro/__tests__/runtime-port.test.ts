import { describe, expect, test, vi } from 'vitest';
import { executeMaestroProgram } from '../engine.ts';
import { parseMaestroProgram } from '../program-ir-parser.ts';
import { createMaestroRuntimePort } from '../runtime-port.ts';
import type {
  MaestroRuntimeOperationContext,
  MaestroRuntimeOperations,
  MaestroTargetMatch,
} from '../runtime-port-types.ts';
import { makeOperations, record, type RecordedCall } from './runtime-port-fixtures.ts';

describe('MaestroRuntimePort', () => {
  test('delegates typed lifecycle, input, keyboard, screenshot, and script operations', async () => {
    const calls: RecordedCall[] = [];
    const operations = makeOperations({
      launchApp: vi.fn(async (input, context) => record(calls, 'launchApp', input, context)),
      openLink: vi.fn(async (input, context) => record(calls, 'openLink', input, context)),
      inputText: vi.fn(async (input, context) => record(calls, 'inputText', input, context)),
      eraseText: vi.fn(async (input, context) => record(calls, 'eraseText', input, context)),
      pasteText: vi.fn(async (input, context) => record(calls, 'pasteText', input, context)),
      scroll: vi.fn(async (input, context) => record(calls, 'scroll', input, context)),
      scrollUntilVisible: vi.fn(async (input, context) =>
        record(calls, 'scrollUntilVisible', input, context),
      ),
      hideKeyboard: vi.fn(async (input, context) => record(calls, 'hideKeyboard', input, context)),
      pressKey: vi.fn(async (input, context) => record(calls, 'pressKey', input, context)),
      back: vi.fn(async (input, context) => record(calls, 'back', input, context)),
      waitForAnimationToEnd: vi.fn(async (input, context) =>
        record(calls, 'waitForAnimationToEnd', input, context),
      ),
      takeScreenshot: vi.fn(async (input, context) => {
        record(calls, 'takeScreenshot', input, context);
        return { artifactPaths: ['artifact://checkout.png'] };
      }),
      runScript: vi.fn(async (input, context) => {
        record(calls, 'runScript', input, context);
        return { outputEnv: { TOKEN: 'generated' } };
      }),
    });
    const program = parseMaestroProgram(
      [
        'appId: com.example.checkout',
        '---',
        '- launchApp:',
        '    clearState: true',
        '    launchArguments:',
        '      seed: 7',
        '- openLink: https://example.test/checkout',
        '- inputText:',
        '    text: ada@example.com',
        '    label: email',
        '- eraseText:',
        '    charactersToErase: 3',
        '- pasteText: pasted',
        '- scroll',
        '- scrollUntilVisible:',
        '    element: Checkout',
        '    direction: up',
        '    timeout: 1200',
        '- hideKeyboard',
        '- pressKey: Enter',
        '- back',
        '- waitForAnimationToEnd: 50',
        '- takeScreenshot: checkout.png',
        '- runScript:',
        '    file: setup.js',
        '    env:',
        '      SEED: 7',
      ].join('\n'),
    );

    const result = await executeMaestroProgram(program, createMaestroRuntimePort(operations));

    expect(result).toEqual({
      executed: 13,
      skipped: 0,
      generation: 11,
      artifactPaths: ['artifact://checkout.png'],
    });
    expect(calls.map(({ kind }) => kind)).toEqual([
      'launchApp',
      'openLink',
      'inputText',
      'eraseText',
      'pasteText',
      'scroll',
      'scrollUntilVisible',
      'hideKeyboard',
      'pressKey',
      'back',
      'waitForAnimationToEnd',
      'takeScreenshot',
      'runScript',
    ]);
    expect(calls[0]).toMatchObject({
      kind: 'launchApp',
      input: {
        appId: 'com.example.checkout',
        clearState: true,
        launchArguments: { kind: 'map', values: { seed: 7 } },
      },
      generation: 0,
      appId: 'com.example.checkout',
    });
    expect(calls[6]).toMatchObject({
      kind: 'scrollUntilVisible',
      input: {
        selector: { text: 'Checkout' },
        direction: 'up',
        timeoutMs: 1200,
        durationMs: 601,
      },
    });
    expect(calls[7]).toMatchObject({ kind: 'hideKeyboard', input: {}, generation: 7 });
    expect(calls[8]).toMatchObject({ kind: 'pressKey', input: { key: 'enter' }, generation: 8 });
    expect(calls[10]).toMatchObject({
      kind: 'waitForAnimationToEnd',
      input: { timeoutMs: 50 },
      generation: 10,
    });
    expect(calls[12]).toMatchObject({
      kind: 'runScript',
      input: { file: 'setup.js', env: { SEED: 7 } },
      generation: 11,
    });
  });

  test('describes observation validity after successful waits and scripts', async () => {
    const waitInvalidation = vi.fn();
    const scriptInvalidation = vi.fn();
    const operations = makeOperations({
      waitForAnimationToEnd: vi.fn(async () => undefined),
      runScript: vi.fn(async () => undefined),
    });
    const port = createMaestroRuntimePort(operations);

    await expect(
      port.execute({
        command: { kind: 'waitForAnimationToEnd', source: { line: 2 }, timeout: 50 },
        generation: 4,
        env: {},
        invalidateObservation: waitInvalidation,
      }),
    ).resolves.toEqual({});
    await expect(
      port.execute({
        command: { kind: 'runScript', source: { line: 3 }, file: 'setup.js' },
        generation: 5,
        env: {},
        invalidateObservation: scriptInvalidation,
      }),
    ).resolves.toEqual({});
    expect(waitInvalidation).toHaveBeenCalledOnce();
    expect(scriptInvalidation).not.toHaveBeenCalled();
  });

  test('invalidates retained observations after target preparation and before dispatch', async () => {
    const events: string[] = [];
    const operations = makeOperations({
      resolveTarget: vi.fn(async ({ selector }, context) => {
        events.push('resolve');
        return {
          generation: context.generation,
          matched: true,
          visible: true,
          candidateCount: 1,
          rect: { x: 0, y: 0, width: 20, height: 20 },
          dispatchSelector: { key: 'id' as const, value: selector.id! },
        };
      }),
      tapOn: vi.fn(async () => {
        events.push('dispatch');
        throw new Error('dispatch failed');
      }),
    });

    await expect(
      createMaestroRuntimePort(operations).execute({
        command: {
          kind: 'tapOn',
          source: { line: 2 },
          target: {
            space: 'target',
            selector: { id: 'continue' },
          },
        },
        generation: 0,
        env: {},
        invalidateObservation: () => events.push('invalidate'),
      }),
    ).rejects.toThrow('dispatch failed');

    expect(events).toEqual(['resolve', 'invalidate', 'dispatch']);
  });

  test('keeps action geometry local while preserving semantic selector evidence', async () => {
    const resolved: Record<string, MaestroTargetMatch> = {
      ready: {
        generation: 0,
        matched: true,
        visible: true,
        candidateCount: 1,
        rect: { x: 24, y: 44, width: 120, height: 48 },
        viewport: { x: 0, y: 0, width: 402, height: 874 },
        ref: 'e5',
      },
      pager: {
        generation: 1,
        matched: true,
        visible: true,
        candidateCount: 1,
        rect: { x: 100, y: 200, width: 100, height: 80 },
        viewport: { x: 0, y: 0, width: 402, height: 874 },
        ref: 'e12',
      },
    };
    const observe = vi.fn(
      async ({ condition }: Parameters<MaestroRuntimeOperations['observe']>[0]) => ({
        generation: 0,
        matched: true,
        visible: true,
        candidateCount: 1,
        rect: { x: 20, y: 40, width: 120, height: 48 },
        viewport: { x: 0, y: 0, width: 402, height: 874 },
        ref: condition.selector.id === 'ready' ? 'e4' : undefined,
      }),
    );
    const resolveTarget = vi.fn(
      async (
        { selector }: Parameters<MaestroRuntimeOperations['resolveTarget']>[0],
        context: MaestroRuntimeOperationContext,
      ) => ({
        ...(resolved[selector.id ?? selector.text ?? ''] ?? {
          generation: context.generation,
          matched: false,
          visible: false,
          candidateCount: 0,
        }),
      }),
    );
    const tapOn = vi.fn(async () => undefined);
    const gesture = vi.fn(async () => undefined);
    const operations = makeOperations({
      observe,
      resolveTarget,
      tapOn,
      gesture,
      resolveGestureViewport: vi.fn(async () => ({ x: 0, y: 0, width: 402, height: 874 })),
    });
    const program = parseMaestroProgram(
      [
        '---',
        '- assertVisible:',
        '    id: ready',
        '- tapOn:',
        '    id: ready',
        '- swipe:',
        '    from:',
        '      id: pager',
        '    direction: right',
      ].join('\n'),
    );

    const result = await executeMaestroProgram(program, createMaestroRuntimePort(operations));

    expect(result.generation).toBe(2);
    const observed = await createMaestroRuntimePort(operations).observe({
      condition: { kind: 'visible', selector: { id: 'ready' } },
      timeoutMs: 0,
      generation: 0,
      env: {},
    });
    expect(observed.evidence).not.toHaveProperty('frame');
    expect(resolveTarget).toHaveBeenCalledTimes(2);
    expect(tapOn).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          point: { x: 84, y: 68 },
          resolution: expect.objectContaining({
            ref: 'e5',
            rect: { x: 24, y: 44, width: 120, height: 48 },
          }),
        }),
      }),
      expect.objectContaining({ generation: 0 }),
    );
    expect(gesture).toHaveBeenCalledWith(
      {
        from: { x: 150, y: 240 },
        to: { x: 361, y: 240 },
        durationMs: 400,
      },
      expect.objectContaining({
        generation: 1,
        gestureViewport: { x: 0, y: 0, width: 402, height: 874 },
      }),
    );
    expect(operations.resolveGestureViewport).not.toHaveBeenCalled();
  });

  test('skips an absent optional tap without hiding resolver infrastructure failures', async () => {
    const tapOn = vi.fn(async () => undefined);
    const missingOperations = makeOperations({
      resolveTarget: vi.fn(async ({ purpose }, context) => ({
        generation: context.generation,
        matched: false,
        visible: false,
        candidateCount: 0,
        ...(purpose === 'tap' ? {} : { ref: 'unexpected' }),
      })),
      tapOn,
    });
    const command = parseMaestroProgram('---\n- tapOn:\n    text: Missing\n    optional: true\n')
      .commands[0]!;

    const result = await createMaestroRuntimePort(missingOperations).execute({
      command: command as Extract<typeof command, { kind: 'tapOn' }>,
      generation: 0,
      env: {},
      invalidateObservation: vi.fn(),
    });

    expect(result).toEqual({});
    expect(missingOperations.resolveTarget).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'tap', selector: { text: 'Missing' } }),
      expect.any(Object),
    );
    expect(tapOn).not.toHaveBeenCalled();

    const failure = new Error('snapshot transport failed');
    const failingOperations = makeOperations({
      resolveTarget: vi.fn(async () => {
        throw failure;
      }),
      tapOn,
    });
    await expect(
      createMaestroRuntimePort(failingOperations).execute({
        command: command as Extract<typeof command, { kind: 'tapOn' }>,
        generation: 0,
        env: {},
        invalidateObservation: vi.fn(),
      }),
    ).rejects.toBe(failure);
  });
});
