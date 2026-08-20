import { expect, test } from 'vitest';
import { parseMaestroProgram } from '../program-ir-parser.ts';

test('keeps outer labels as command metadata across supported command forms', () => {
  const program = parseMaestroProgram(
    [
      '---',
      '- tapOn:',
      '    text: Save',
      '    label: save tap',
      '- tapOn:',
      '    point: 20,30',
      '    label: coordinate tap',
      '- doubleTapOn:',
      '    text: Save',
      '    label: save twice',
      '- longPressOn:',
      '    text: Hold',
      '    label: hold action',
      '- assertVisible:',
      '    text: Ready',
      '    label: ready assertion',
      '- assertNotVisible:',
      '    text: Gone',
      '    label: gone assertion',
      '- extendedWaitUntil:',
      '    visible:',
      '      text: Loaded',
      '    label: loaded wait',
      '- scrollUntilVisible:',
      '    element:',
      '      text: Item',
      '    label: item scroll',
      '- swipe:',
      '    from:',
      '      text: Card',
      '    direction: LEFT',
      '    label: card swipe',
      '- inputText:',
      '    text: value',
      '    label: field input',
      '- runFlow:',
      '    commands:',
      '      - scroll',
      '    label: nested flow',
    ].join('\n'),
  );

  expect(
    program.commands.map((command) => ('label' in command ? command.label : undefined)),
  ).toEqual([
    'save tap',
    'coordinate tap',
    'save twice',
    'hold action',
    'ready assertion',
    'gone assertion',
    'loaded wait',
    'item scroll',
    'card swipe',
    'field input',
    'nested flow',
  ]);
  expect(program.commands[0]).toMatchObject({
    target: { space: 'target', selector: { text: 'Save' } },
  });
  expect(program.commands[4]).toMatchObject({ target: { text: 'Ready' } });
  expect(program.commands[6]).toMatchObject({ visible: { text: 'Loaded' } });
  expect(program.commands[7]).toMatchObject({ element: { text: 'Item' } });
  expect(program.commands[8]).toMatchObject({ gesture: { from: { text: 'Card' } } });
});

test('does not accept a label-only map as a selector', () => {
  expect(() => parseMaestroProgram(['---', '- tapOn:', '    label: Save'].join('\n'))).toThrow(
    /selector is empty|selector must contain a selector value/,
  );
});

test('does not reinterpret a nested selector label as command metadata', () => {
  expect(() =>
    parseMaestroProgram(
      [
        '---',
        '- extendedWaitUntil:',
        '    visible:',
        '      text: Loaded',
        '      label: nested label',
      ].join('\n'),
    ),
  ).toThrow(/visible field "label" is not supported/);
});
