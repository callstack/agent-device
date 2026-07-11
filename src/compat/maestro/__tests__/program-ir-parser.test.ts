import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { parseMaestroProgram } from '../program-ir-parser.ts';

describe('parseMaestroProgram', () => {
  test('preserves config, hooks, conditions, nested blocks, and source lines', () => {
    const program = parseMaestroProgram(
      [
        'name: Checkout',
        'appId: example.app',
        'env:',
        '  COUNT: ${COUNT}',
        'onFlowStart:',
        '  - launchApp:',
        '      clearState: true',
        'onFlowComplete:',
        '  - takeScreenshot: final.png',
        '---',
        '- runFlow:',
        '    when:',
        '      platform: iOS',
        '      true: "${maestro.platform == \'ios\'}"',
        '    env:',
        '      CHILD: nested',
        '    commands:',
        '      - tapOn:',
        '          id: checkout-form',
        '      - repeat:',
        '          times: ${COUNT}',
        '          commands:',
        '            - assertVisible: Ready',
        '- retry:',
        '    maxRetries: 2',
        '    commands:',
        '      - pressKey: Enter',
      ].join('\n'),
      { sourcePath: '/flows/checkout.yaml' },
    );

    assert.deepEqual(program.source, { path: '/flows/checkout.yaml', line: 1 });
    assert.deepEqual(program.config.env, { COUNT: '${COUNT}' });
    assert.equal(program.config.onFlowStart?.[0]?.kind, 'launchApp');
    assert.deepEqual(program.config.onFlowStart?.[0]?.source, {
      path: '/flows/checkout.yaml',
      line: 6,
    });
    assert.equal(program.config.onFlowComplete?.[0]?.kind, 'takeScreenshot');
    assert.deepEqual(
      program.commands.map((command) => command.kind),
      ['runFlow', 'retry'],
    );

    const runFlow = program.commands[0];
    if (runFlow?.kind !== 'runFlow') throw new Error('expected runFlow');
    assert.deepEqual(runFlow.source, { path: '/flows/checkout.yaml', line: 11 });
    assert.deepEqual(runFlow.when, {
      platform: 'ios',
      true: "${maestro.platform == 'ios'}",
    });
    assert.deepEqual(runFlow.env, { CHILD: 'nested' });
    assert.deepEqual(runFlow.include.kind, 'commands');
    if (runFlow.include.kind !== 'commands') throw new Error('expected inline commands');
    assert.deepEqual(
      runFlow.include.commands.map((command) => command.source.line),
      [18, 20],
    );
    const repeat = runFlow.include.commands[1];
    if (repeat?.kind !== 'repeat') throw new Error('expected repeat');
    assert.equal(repeat.times, '${COUNT}');
    assert.equal(repeat.commands[0]?.kind, 'assertVisible');
    assert.equal(repeat.commands[0]?.source.line, 23);

    const retry = program.commands[1];
    if (retry?.kind !== 'retry') throw new Error('expected retry');
    assert.equal(retry.maxRetries, 2);
    assert.equal(retry.commands[0]?.kind, 'pressKey');
    assert.equal(retry.commands[0]?.source.line, 27);
  });

  test('keeps authored absolute, percentage, and target gesture spaces', () => {
    const program = parseMaestroProgram(`---
- tapOn:
    point: 20%, 30%
- tapOn:
    id: submit
- doubleTapOn:
    point: 100,200
- longPressOn:
    id: hold
- swipe:
    start: 100, 200
    end: 300, 400
- swipe:
    start: 90%, 50%
    end: 10%, 50%
- swipe:
    from:
      id: handle
    direction: LEFT
`);

    const [
      percentTap,
      targetTap,
      absoluteDoubleTap,
      targetLongPress,
      absoluteSwipe,
      percentSwipe,
      targetSwipe,
    ] = program.commands;
    if (percentTap?.kind !== 'tapOn') throw new Error('expected percentage tap');
    if (targetTap?.kind !== 'tapOn') throw new Error('expected target tap');
    if (absoluteDoubleTap?.kind !== 'doubleTapOn') throw new Error('expected absolute double tap');
    if (targetLongPress?.kind !== 'longPressOn') throw new Error('expected target long press');
    if (absoluteSwipe?.kind !== 'swipe') throw new Error('expected absolute swipe');
    if (percentSwipe?.kind !== 'swipe') throw new Error('expected percentage swipe');
    if (targetSwipe?.kind !== 'swipe') throw new Error('expected target swipe');

    assert.deepEqual(percentTap.target, { space: 'percent', x: 20, y: 30 });
    assert.deepEqual(targetTap.target, { space: 'target', selector: { id: 'submit' } });
    assert.deepEqual(absoluteDoubleTap.target, { space: 'absolute', x: 100, y: 200 });
    assert.deepEqual(targetLongPress.target, { space: 'target', selector: { id: 'hold' } });
    assert.deepEqual(absoluteSwipe.gesture, {
      kind: 'coordinates',
      start: { space: 'absolute', x: 100, y: 200 },
      end: { space: 'absolute', x: 300, y: 400 },
    });
    assert.deepEqual(percentSwipe.gesture, {
      kind: 'coordinates',
      start: { space: 'percent', x: 90, y: 50 },
      end: { space: 'percent', x: 10, y: 50 },
    });
    assert.deepEqual(targetSwipe.gesture, {
      kind: 'target',
      from: { id: 'handle' },
      direction: 'left',
    });
  });

  test('preserves an include boundary and the authored include path', () => {
    const program = parseMaestroProgram(
      `appId: example.app
---
- runFlow: helpers/child.yaml
- tapOn: Continue
`,
      { sourcePath: '/flows/main.yaml' },
    );

    const include = program.commands[0];
    if (include?.kind !== 'runFlow') throw new Error('expected runFlow');
    assert.deepEqual(include.include, { kind: 'file', path: 'helpers/child.yaml' });
    assert.deepEqual(include.source, { path: '/flows/main.yaml', line: 3 });
    assert.deepEqual(program.commands[1]?.source, { path: '/flows/main.yaml', line: 4 });
  });

  test('keeps supported command values typed instead of lowering them to arguments', () => {
    const program = parseMaestroProgram(`appId: example.app
---
- launchApp:
    appId: child.app
    stopApp: false
    arguments:
      - --mode
      - preview
    launchArguments:
      feature: true
- inputText:
    text: Ada \${USER}
    label: Full name
- eraseText:
    charactersToErase: 4
- openLink:
    link: https://example.test
- extendedWaitUntil:
    visible:
      id: ready
    timeout: 2500
- scrollUntilVisible:
    element: Checkout
    direction: DOWN
    timeout: 5000
- runScript:
    file: setup.js
    env:
      SERVER: local
`);

    assert.deepEqual(program.commands[0], {
      kind: 'launchApp',
      source: { line: 3 },
      appId: 'child.app',
      stopApp: false,
      arguments: { kind: 'list', values: ['--mode', 'preview'] },
      launchArguments: { kind: 'map', values: { feature: true } },
    });
    assert.deepEqual(program.commands[1], {
      kind: 'inputText',
      source: { line: 11 },
      text: 'Ada ${USER}',
      label: 'Full name',
    });
    assert.deepEqual(program.commands[3], {
      kind: 'openLink',
      source: { line: 16 },
      link: 'https://example.test',
    });
    const wait = program.commands[4];
    if (wait?.kind !== 'extendedWaitUntil') throw new Error('expected extended wait');
    assert.deepEqual(wait.visible, { id: 'ready' });
    assert.equal(wait.timeout, 2500);
    const scroll = program.commands[5];
    if (scroll?.kind !== 'scrollUntilVisible') throw new Error('expected scroll wait');
    assert.equal(scroll.direction, 'down');
    assert.equal(scroll.timeout, 5000);
    assert.deepEqual(program.commands[6], {
      kind: 'runScript',
      source: { line: 26 },
      file: 'setup.js',
      env: { SERVER: 'local' },
    });
  });

  test('reports source lines for unsupported and invalid command shapes', () => {
    assert.throws(
      () =>
        parseMaestroProgram(`---
- unsupportedCommand: true
`),
      /unsupported.*line 2/i,
    );
    assert.throws(
      () =>
        parseMaestroProgram(`---
- swipe:
    start: 10,20
    end: 50%,60%
`),
      /same coordinate space.*line 2/i,
    );
    assert.throws(
      () =>
        parseMaestroProgram(`---
- runFlow:
    when: {}
    commands: []
`),
      /when cannot be empty.*line 3/i,
    );
  });
});
