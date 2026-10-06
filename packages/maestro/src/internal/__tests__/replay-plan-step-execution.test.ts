import { describe, expect, test, vi } from 'vitest';
import { MAESTRO_COMPATIBILITY_PRESETS } from '../compatibility-policy.ts';
import { parseMaestroProgram } from '../program-ir-parser.ts';
import type { MaestroRuntimePort } from '../engine-types.ts';
import { executeMaestroProgram, makePort } from './runtime-port-fixtures.ts';

describe('repeat and condition execution', () => {
  test('repeat while evaluates JavaScript expressions and retains output updates', async () => {
    const texts: string[] = [];
    const port = makePort({
      execute: vi.fn(async (request) => {
        if (request.command.kind === 'inputText') texts.push(request.command.text);
        request.invalidateObservation();
        return {};
      }),
    });
    const program = parseMaestroProgram(
      [
        '---',
        '- evalScript: ${output.counter = 0}',
        '- repeat:',
        '    while:',
        '      true: "${output.counter < 3}"',
        '    commands:',
        '      - inputText: loop',
        '      - evalScript: ${output.counter++}',
      ].join('\n'),
    );

    await executeMaestroProgram(program, port);

    expect(texts).toEqual(['loop', 'loop', 'loop']);
  });

  test('repeat while observes selectors once per iteration and stops when false', async () => {
    let checks = 0;
    const observe = vi.fn(async ({ generation }: Parameters<MaestroRuntimePort['observe']>[0]) => ({
      generation,
      matched: ++checks < 3,
    }));
    const port = makePort({ observe });
    const program = parseMaestroProgram(
      [
        '---',
        '- repeat:',
        '    times: 10',
        '    while:',
        '      platform: Android',
        '      notVisible: ValueX',
        '    commands:',
        '      - inputText: loop',
      ].join('\n'),
    );

    await executeMaestroProgram(program, port, { platform: 'android' });

    expect(port.execute).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenCalledTimes(3);
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        condition: { kind: 'notVisible', selector: { text: 'ValueX' } },
        timeoutMs: MAESTRO_COMPATIBILITY_PRESETS.command.optionalTargetLookupTimeoutMs,
      }),
    );
  });

  test('repeat while stops at the times limit even while its condition remains true', async () => {
    const port = makePort();
    const program = parseMaestroProgram(
      [
        '---',
        '- repeat:',
        '    times: 2',
        '    while:',
        '      true: true',
        '    commands:',
        '      - inputText: loop',
      ].join('\n'),
    );

    await executeMaestroProgram(program, port);

    expect(port.execute).toHaveBeenCalledTimes(2);
  });

  test('repeat while expressions are refused for remote untrusted flows', async () => {
    const program = parseMaestroProgram(
      [
        '---',
        '- repeat:',
        '    while:',
        '      true: "${output.counter < 3}"',
        '    commands:',
        '      - inputText: loop',
      ].join('\n'),
    );

    await expect(
      executeMaestroProgram(program, makePort(), { trustedScripts: false }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  test('repeat while true binds maestro.platform in JavaScript expressions', async () => {
    const port = makePort();
    const program = parseMaestroProgram(
      [
        '---',
        '- evalScript: ${output.n = 0}',
        '- repeat:',
        '    while:',
        `      true: "\${maestro.platform === 'ios' && output.n < 2}"`,
        '    commands:',
        '      - inputText: loop',
        '      - evalScript: ${output.n++}',
      ].join('\n'),
    );

    await executeMaestroProgram(program, port, { platform: 'ios' });

    expect(port.execute).toHaveBeenCalledTimes(2);
  });

  test('repeat while true accepts plain literals and platform comparisons without scripts', async () => {
    const port = makePort();
    const program = parseMaestroProgram(
      [
        '---',
        '- repeat:',
        '    times: 2',
        '    while:',
        '      true: yes',
        '    commands:',
        '      - inputText: literal',
        '- repeat:',
        '    times: 2',
        '    while:',
        `      true: "\${maestro.platform == 'android'}"`,
        '    commands:',
        '      - inputText: platform',
      ].join('\n'),
    );

    await executeMaestroProgram(program, port, { platform: 'ios', trustedScripts: false });

    expect(port.execute).toHaveBeenCalledTimes(2);
  });

  test('runFlow when true shares the repeat while JavaScript evaluator', async () => {
    const port = makePort();
    const program = parseMaestroProgram(
      [
        '---',
        '- evalScript: ${output.n = 2}',
        '- runFlow:',
        '    when:',
        '      true: "${output.n > 1}"',
        '    commands:',
        '      - inputText: ran',
      ].join('\n'),
    );

    await executeMaestroProgram(program, port);

    expect(port.execute).toHaveBeenCalledTimes(1);
  });

  test('repeat while re-resolves condition selectors before every check', async () => {
    const observe = vi.fn(async ({ generation }: Parameters<MaestroRuntimePort['observe']>[0]) => ({
      generation,
      matched: true,
    }));
    const port = makePort({ observe });
    const program = parseMaestroProgram(
      [
        '---',
        '- evalScript: ${output.target = "first"}',
        '- repeat:',
        '    times: 2',
        '    while:',
        '      visible: ${output.target}',
        '    commands:',
        '      - evalScript: ${output.target = "second"}',
      ].join('\n'),
    );

    await executeMaestroProgram(program, port);

    expect(observe.mock.calls.map(([request]) => request.condition)).toEqual([
      { kind: 'visible', selector: { text: 'first' } },
      { kind: 'visible', selector: { text: 'second' } },
    ]);
  });

  test('an unbounded synchronous repeat still yields to cancellation timers', async () => {
    const controller = new AbortController();
    const program = parseMaestroProgram(
      ['---', '- repeat:', '    while:', '      true: true', '    commands: []'].join('\n'),
    );
    setTimeout(() => controller.abort(), 10);

    await expect(
      executeMaestroProgram(program, makePort(), { signal: controller.signal }),
    ).rejects.toMatchObject({ details: { reason: 'request_canceled' } });
  });
});
