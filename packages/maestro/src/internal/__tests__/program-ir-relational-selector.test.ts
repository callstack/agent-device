import { expect, test } from 'vitest';
import { parseMaestroProgram } from '../program-ir-parser.ts';

test('parses tree relations recursively on every selector-bearing command family', () => {
  const program = parseMaestroProgram(
    [
      '---',
      '- tapOn:',
      '    id: card',
      '    containsChild:',
      '      text: Save',
      '- doubleTapOn:',
      '    text: Save',
      '    childOf:',
      '      id: card',
      '- longPressOn:',
      '    id: card',
      '    containsDescendants:',
      '      - id: icon',
      '- assertVisible:',
      '    text: Save',
      '    childOf:',
      '      id: card',
      '      index: 1',
      '- assertNotVisible:',
      '    id: card',
      '    containsChild:',
      '      id: spinner',
      '- extendedWaitUntil:',
      '    visible:',
      '      id: card',
      '      containsDescendants:',
      '        - id: ready',
      '- scrollUntilVisible:',
      '    element:',
      '      text: Save',
      '      childOf:',
      '        id: card',
      '- swipe:',
      '    from:',
      '      id: card',
      '      containsChild:',
      '        id: handle',
      '    direction: LEFT',
    ].join('\n'),
  );

  expect(program.commands).toMatchObject([
    { target: { selector: { containsChild: { text: 'Save' } } } },
    { target: { selector: { childOf: { id: 'card' } } } },
    { target: { selector: { containsDescendants: [{ id: 'icon' }] } } },
    { target: { childOf: { id: 'card', index: 1 } } },
    { target: { containsChild: { id: 'spinner' } } },
    { visible: { containsDescendants: [{ id: 'ready' }] } },
    { element: { childOf: { id: 'card' } } },
    { gesture: { from: { containsChild: { id: 'handle' } } } },
  ]);
});

test('enforces the pinned tree-relation shapes and index domain recursively', () => {
  expect(() =>
    parseMaestroProgram(['---', '- tapOn:', '    containsChild:', '      - id: child'].join('\n')),
  ).toThrow(/containsChild expects a map/);
  expect(() =>
    parseMaestroProgram(
      ['---', '- tapOn:', '    childOf:', '      id: card', '      index: -1'].join('\n'),
    ),
  ).toThrow(/non-negative integer/);
  expect(() =>
    parseMaestroProgram(['---', '- tapOn:', '    before:', '      text: Save'].join('\n')),
  ).toThrow(/field "before" is not supported/);
  expect(() =>
    parseMaestroProgram(['---', '- tapOn:', '    after:', '      text: Save'].join('\n')),
  ).toThrow(/field "after" is not supported/);
});
