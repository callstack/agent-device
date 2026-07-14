import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { parseMaestroProgram } from '../program-ir-parser.ts';
import type { MaestroCommand } from '../program-ir.ts';

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

    const runFlow = commandOfKind(program.commands[0], 'runFlow');
    assert.deepEqual(runFlow.source, { path: '/flows/checkout.yaml', line: 11 });
    assert.deepEqual(runFlow.when, {
      platform: 'ios',
      true: "${maestro.platform == 'ios'}",
    });
    assert.deepEqual(runFlow.env, { CHILD: 'nested' });
    assert.equal(runFlow.include.kind, 'commands');
    const inline = runFlow.include as Extract<typeof runFlow.include, { kind: 'commands' }>;
    assert.deepEqual(
      inline.commands.map((command) => command.source.line),
      [18, 20],
    );
    const repeat = commandOfKind(inline.commands[1], 'repeat');
    assert.equal(repeat.times, '${COUNT}');
    assert.equal(repeat.commands[0]?.kind, 'assertVisible');
    assert.equal(repeat.commands[0]?.source.line, 23);

    const retry = commandOfKind(program.commands[1], 'retry');
    assert.equal(retry.maxRetries, 2);
    assert.equal(retry.commands[0]?.kind, 'pressKey');
    assert.equal(retry.commands[0]?.source.line, 27);
  });

  test('parses flow tags as typed metadata and validates each tag', () => {
    const program = parseMaestroProgram(
      ['name: Pager', 'tags: [smoke, pager]', '---', '- launchApp'].join('\n'),
    );

    assert.deepEqual(program.config.tags, ['smoke', 'pager']);
    assert.throws(
      () => parseMaestroProgram(['tags: [smoke, 7]', '---', '- launchApp'].join('\n')),
      /tags\[1\].*expects a string.*line 1/i,
    );
  });

  test('keeps authored absolute, percentage, and target gesture spaces', () => {
    const program = parseMaestroProgram(`---
- tapOn:
    point: 20%, 30%
- tapOn:
    id: submit
    retryTapIfNoChange: true
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
    const percentTapCommand = commandOfKind(percentTap, 'tapOn');
    const targetTapCommand = commandOfKind(targetTap, 'tapOn');
    const absoluteDoubleTapCommand = commandOfKind(absoluteDoubleTap, 'doubleTapOn');
    const targetLongPressCommand = commandOfKind(targetLongPress, 'longPressOn');
    const absoluteSwipeCommand = commandOfKind(absoluteSwipe, 'swipe');
    const percentSwipeCommand = commandOfKind(percentSwipe, 'swipe');
    const targetSwipeCommand = commandOfKind(targetSwipe, 'swipe');

    assert.deepEqual(percentTapCommand.target, { space: 'percent', x: 20, y: 30 });
    assert.deepEqual(targetTapCommand.target, { space: 'target', selector: { id: 'submit' } });
    assert.equal(targetTapCommand.retryTapIfNoChange, true);
    assert.deepEqual(absoluteDoubleTapCommand.target, { space: 'absolute', x: 100, y: 200 });
    assert.deepEqual(targetLongPressCommand.target, {
      space: 'target',
      selector: { id: 'hold' },
    });
    assert.deepEqual(absoluteSwipeCommand.gesture, {
      kind: 'coordinates',
      start: { space: 'absolute', x: 100, y: 200 },
      end: { space: 'absolute', x: 300, y: 400 },
    });
    assert.deepEqual(percentSwipeCommand.gesture, {
      kind: 'coordinates',
      start: { space: 'percent', x: 90, y: 50 },
      end: { space: 'percent', x: 10, y: 50 },
    });
    assert.deepEqual(targetSwipeCommand.gesture, {
      kind: 'target',
      from: { id: 'handle' },
      direction: 'left',
    });
  });

  test('keeps selector-map keys aligned with the supported command subset', () => {
    const program = parseMaestroProgram(['---', '- tapOn:', '    label: Save'].join('\n'));
    const tap = commandOfKind(program.commands[0], 'tapOn');
    assert.deepEqual(tap.target, { space: 'target', selector: { label: 'Save' } });

    assert.throws(
      () => parseMaestroProgram(['---', '- doubleTapOn:', '    label: Save'].join('\n')),
      /doubleTapOn field "label" is not supported.*line 3/i,
    );
    assert.throws(
      () => parseMaestroProgram(['---', '- assertVisible:', '    label: Save'].join('\n')),
      /assertVisible field "label" is not supported.*line 3/i,
    );
  });

  test('parses optional on assertion and target command maps', () => {
    const program = parseMaestroProgram(
      [
        '---',
        '- assertVisible:',
        '    text: Maybe present',
        '    optional: true',
        '- doubleTapOn:',
        '    id: maybe-present',
        '    optional: true',
        '- scrollUntilVisible:',
        '    element: Maybe visible',
        '    optional: true',
      ].join('\n'),
    );

    assert.deepEqual(program.commands[0], {
      kind: 'assertVisible',
      source: { line: 2 },
      target: { text: 'Maybe present' },
      optional: true,
    });
    assert.deepEqual(program.commands[1], {
      kind: 'doubleTapOn',
      source: { line: 5 },
      target: { space: 'target', selector: { id: 'maybe-present' } },
      optional: true,
    });
    assert.deepEqual(program.commands[2], {
      kind: 'scrollUntilVisible',
      source: { line: 8 },
      element: { text: 'Maybe visible' },
      optional: true,
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

    const include = commandOfKind(program.commands[0], 'runFlow');
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
    const wait = commandOfKind(program.commands[4], 'extendedWaitUntil');
    assert.deepEqual(wait.visible, { id: 'ready' });
    assert.equal(wait.timeout, 2500);
    const scroll = commandOfKind(program.commands[5], 'scrollUntilVisible');
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
- swipe:
    start: 150%,50%
    end: 10%,50%
`),
      /between 0% and 100%.*line 3/i,
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

  test('rejects fractional percentages, directionless target swipes, and pasteText', () => {
    assert.throws(
      () =>
        parseMaestroProgram(`---
- tapOn:
    point: 12.5%, 40%
`),
      /percentage coordinates must be whole numbers.*line 3/i,
    );
    assert.throws(
      () =>
        parseMaestroProgram(`---
- swipe:
    from: Pager
`),
      /target swipe requires direction.*line 2/i,
    );
    assert.throws(
      () =>
        parseMaestroProgram(
          `---
- pasteText: pasted
`,
          { sourcePath: '/flows/paste.yaml' },
        ),
      /command "pasteText" is not supported.*\/flows\/paste\.yaml:line 2/i,
    );
  });

  test('preserves source paths for unsupported and malformed flows', () => {
    const sourcePath = '/flows/includes/child.yaml';
    assert.throws(
      () =>
        parseMaestroProgram(
          `---
- unsupportedCommand: true
`,
          { sourcePath },
        ),
      /unsupported.*\/flows\/includes\/child\.yaml:line 2/i,
    );
    assert.throws(
      () =>
        parseMaestroProgram(
          `---
- tapOn:
    label: Save
    unsupported: true
`,
          { sourcePath },
        ),
      /not supported.*\/flows\/includes\/child\.yaml:line 4/i,
    );
    assert.throws(
      () =>
        parseMaestroProgram(
          `---
- runFlow:
    file: [child.yaml
`,
          { sourcePath },
        ),
      /Invalid Maestro YAML flow[\s\S]*\/flows\/includes\/child\.yaml:line 4/i,
    );
  });
});

function commandOfKind<K extends MaestroCommand['kind']>(
  command: MaestroCommand | undefined,
  kind: K,
): Extract<MaestroCommand, { kind: K }> {
  assert.equal(command?.kind, kind);
  return command as Extract<MaestroCommand, { kind: K }>;
}
