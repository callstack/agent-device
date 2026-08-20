import { expect, test } from 'vitest';
import { parseMaestroProgram } from '../program-ir-parser.ts';

test('parses all positional relations recursively across selector-bearing commands', () => {
  const program = parseMaestroProgram(
    [
      '---',
      '- tapOn:',
      '    below:',
      '      above:',
      '        text: Email',
      '- doubleTapOn:',
      '    above:',
      '      id: submit',
      '- longPressOn:',
      '    leftOf:',
      '      text: Menu',
      '- assertVisible:',
      '    rightOf:',
      '      id: navigation',
      '- extendedWaitUntil:',
      '    visible:',
      '      below:',
      '        text: Complete',
      '- scrollUntilVisible:',
      '    element:',
      '      below:',
      '        text: More',
      '- swipe:',
      '    from:',
      '      rightOf:',
      '        id: rail',
      '    direction: LEFT',
    ].join('\n'),
  );

  expect(program.commands).toMatchObject([
    { target: { selector: { below: { above: { text: 'Email' } } } } },
    { target: { selector: { above: { id: 'submit' } } } },
    { target: { selector: { leftOf: { text: 'Menu' } } } },
    { target: { rightOf: { id: 'navigation' } } },
    { visible: { below: { text: 'Complete' } } },
    { element: { below: { text: 'More' } } },
    { gesture: { from: { rightOf: { id: 'rail' } } } },
  ]);
});

test('keeps empty descendant relations in the recursive selector shape', () => {
  const program = parseMaestroProgram(
    ['---', '- tapOn:', '    id: card', '    containsDescendants: []'].join('\n'),
  );
  expect(program.commands[0]).toMatchObject({
    target: { selector: { id: 'card', containsDescendants: [] } },
  });
});
