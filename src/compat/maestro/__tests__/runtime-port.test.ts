import { describe, expect, test, vi } from 'vitest';
import { parseMaestroProgram } from '../program-ir-parser.ts';
import type { MaestroRuntimeOperations, MaestroTargetMatch } from '../runtime-port-types.ts';
import {
  createMaestroRuntimePort,
  executeMaestroProgram,
  makeOperations,
  record,
  type RecordedCall,
} from './runtime-port-fixtures.ts';

describe('MaestroRuntimePort', () => {
  test('delegates typed lifecycle, input, keyboard, screenshot, and script operations', async () => {
    const calls: RecordedCall[] = [];
    const operations = makeOperations({
      launchApp: vi.fn(async (input, context) => record(calls, 'launchApp', input, context)),
      openLink: vi.fn(async (input, context) => record(calls, 'openLink', input, context)),
      inputText: vi.fn(async (input, context) => record(calls, 'inputText', input, context)),
      eraseText: vi.fn(async (input, context) => record(calls, 'eraseText', input, context)),
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
      executed: 12,
      skipped: 0,
      generation: 10,
      artifactPaths: ['artifact://checkout.png'],
    });
    expect(calls.map(({ kind }) => kind)).toEqual([
      'launchApp',
      'openLink',
      'inputText',
      'eraseText',
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
      generation: 1,
      appId: 'com.example.checkout',
    });
    expect(calls[5]).toMatchObject({
      kind: 'scrollUntilVisible',
      input: {
        selector: { text: 'Checkout' },
        direction: 'up',
        timeoutMs: 1200,
        durationMs: 601,
      },
    });
    expect(calls[6]).toMatchObject({ kind: 'hideKeyboard', input: {}, generation: 7 });
    expect(calls[7]).toMatchObject({ kind: 'pressKey', input: { key: 'enter' }, generation: 8 });
    expect(calls[9]).toMatchObject({
      kind: 'waitForAnimationToEnd',
      input: { timeoutMs: 50 },
      generation: 10,
    });
    expect(calls[11]).toMatchObject({
      kind: 'runScript',
      input: { file: 'setup.js', env: { SEED: 7 } },
      generation: 10,
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
        context: Parameters<MaestroRuntimeOperations['resolveTarget']>[1],
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
      expect.objectContaining({ generation: 1 }),
    );
    expect(gesture).toHaveBeenCalledWith(
      {
        from: { x: 150, y: 240 },
        to: { x: 361, y: 240 },
        durationMs: 400,
      },
      expect.objectContaining({
        generation: 2,
        gestureViewport: { x: 0, y: 0, width: 402, height: 874 },
      }),
    );
    expect(operations.resolveGestureViewport).not.toHaveBeenCalled();
  });

  test('reports optional tap misses to the interpreter without hiding infrastructure failures', async () => {
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

    await expect(
      createMaestroRuntimePort(missingOperations).execute({
        command: command as Extract<typeof command, { kind: 'tapOn' }>,
        generation: 0,
        env: {},
        invalidateObservation: vi.fn(),
      }),
    ).rejects.toMatchObject({ details: { reason: 'maestro-test-failure' } });
    expect(missingOperations.resolveTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'tap',
        selector: { text: 'Missing' },
        timeoutMs: 7_000,
      }),
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

  test('resolves ${VAR} numeric option fields to numbers at runtime', async () => {
    const calls: RecordedCall[] = [];
    const operations = makeOperations({
      tapOn: vi.fn(async (input, context) => record(calls, 'tapOn', input, context)),
      doubleTapOn: vi.fn(async (input, context) => record(calls, 'doubleTapOn', input, context)),
      eraseText: vi.fn(async (input, context) => record(calls, 'eraseText', input, context)),
      scrollUntilVisible: vi.fn(async (input, context) =>
        record(calls, 'scrollUntilVisible', input, context),
      ),
      waitForAnimationToEnd: vi.fn(async (input, context) =>
        record(calls, 'waitForAnimationToEnd', input, context),
      ),
      gesture: vi.fn(async (input, context) => record(calls, 'gesture', input, context)),
    });
    const program = parseMaestroProgram(
      [
        '---',
        '- tapOn:',
        '    id: button',
        '    index: ${INDEX}',
        '    repeat: ${REPEAT}',
        '    delay: ${DELAY}',
        '- doubleTapOn:',
        '    id: button',
        '    delay: ${DELAY}',
        '- eraseText:',
        '    charactersToErase: ${CHARS}',
        '- scrollUntilVisible:',
        '    element: Item',
        '    timeout: ${SCROLL_TIMEOUT}',
        '- waitForAnimationToEnd: ${ANIM_TIMEOUT}',
        '- swipe:',
        '    start: 90%, 50%',
        '    end: 10%, 50%',
        '    duration: ${DURATION}',
      ].join('\n'),
    );

    await executeMaestroProgram(program, createMaestroRuntimePort(operations), {
      env: {
        INDEX: '2',
        REPEAT: '3',
        DELAY: '100',
        CHARS: '4',
        SCROLL_TIMEOUT: '5000',
        ANIM_TIMEOUT: '2000',
        DURATION: '250',
      },
    });

    expect(calls).toHaveLength(6);
    expect(calls[0]).toMatchObject({
      kind: 'tapOn',
      input: { target: expect.anything(), repeat: 3, delay: 100 },
    });
    expect(calls[1]).toMatchObject({
      kind: 'doubleTapOn',
      input: { target: expect.anything(), delay: 100 },
    });
    expect(calls[2]).toMatchObject({
      kind: 'eraseText',
      input: { charactersToErase: 4 },
    });
    expect(calls[3]).toMatchObject({
      kind: 'scrollUntilVisible',
      input: { timeoutMs: 5000 },
    });
    expect(calls[4]).toMatchObject({
      kind: 'waitForAnimationToEnd',
      input: { timeoutMs: 2000 },
    });
    expect(calls[5]).toMatchObject({
      kind: 'gesture',
      input: { durationMs: 250 },
    });
  });

  test('rejects blank or whitespace resolved numeric option values with a clear error', async () => {
    const operations = makeOperations();
    const program = parseMaestroProgram(
      '---\n- extendedWaitUntil:\n    visible: Ready\n    timeout: ${TIMEOUT}\n',
    );

    await expect(
      executeMaestroProgram(program, createMaestroRuntimePort(operations), {
        env: { TIMEOUT: '' },
      }),
    ).rejects.toThrow(/extendedWaitUntil\.timeout must be a non-negative finite number/);

    await expect(
      executeMaestroProgram(program, createMaestroRuntimePort(operations), {
        env: { TIMEOUT: '   ' },
      }),
    ).rejects.toThrow(/extendedWaitUntil\.timeout must be a non-negative finite number/);
  });

  test('applies the default delay for doubleTapOn when none is specified', async () => {
    const calls: RecordedCall[] = [];
    const operations = makeOperations({
      doubleTapOn: vi.fn(async (input, context) => record(calls, 'doubleTapOn', input, context)),
    });
    const program = parseMaestroProgram('---\n- doubleTapOn:\n    id: button\n');

    await executeMaestroProgram(program, createMaestroRuntimePort(operations), {});

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'doubleTapOn', input: { delay: 100 } });
  });

  test('resolves tapOn.index into the target query', async () => {
    const resolveTarget = vi.fn(
      async (_input: unknown, context: { generation: number }): Promise<MaestroTargetMatch> => ({
        generation: context.generation,
        matched: true,
        visible: true,
        candidateCount: 1,
        rect: { x: 0, y: 0, width: 100, height: 50 },
        viewport: { x: 0, y: 0, width: 400, height: 800 },
        ref: 'button',
      }),
    );
    const tapOn = vi.fn();
    const operations = makeOperations({ resolveTarget, tapOn });
    const program = parseMaestroProgram('---\n- tapOn:\n    id: button\n    index: ${INDEX}\n');

    await executeMaestroProgram(program, createMaestroRuntimePort(operations), {
      env: { INDEX: '2' },
    });

    expect(resolveTarget).toHaveBeenCalledWith(
      expect.objectContaining({ index: 2 }),
      expect.anything(),
    );
    expect(tapOn).toHaveBeenCalled();
  });

  test('rejects negative, huge, and accepts whitespace-padded resolved numeric values', async () => {
    const operations = makeOperations();
    const negative = parseMaestroProgram(
      '---\n- extendedWaitUntil:\n    visible: Ready\n    timeout: ${TIMEOUT}\n',
    );

    await expect(
      executeMaestroProgram(negative, createMaestroRuntimePort(operations), {
        env: { TIMEOUT: '-1' },
      }),
    ).rejects.toThrow(/extendedWaitUntil\.timeout must be a non-negative finite number/);

    const huge = parseMaestroProgram(
      '---\n- extendedWaitUntil:\n    visible: Ready\n    timeout: ${TIMEOUT}\n',
    );

    await expect(
      executeMaestroProgram(huge, createMaestroRuntimePort(operations), {
        env: { TIMEOUT: '99999999999999999' },
      }),
    ).rejects.toThrow(/extendedWaitUntil\.timeout must be a non-negative finite number/);

    const padded = parseMaestroProgram('---\n- waitForAnimationToEnd: ${TIMEOUT}\n');

    await expect(
      executeMaestroProgram(padded, createMaestroRuntimePort(operations), {
        env: { TIMEOUT: '  1000  ' },
      }),
    ).resolves.toBeDefined();
  });
});
