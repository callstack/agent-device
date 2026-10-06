import { expect, test } from 'vitest';
import { canonicalizeAgentCommands, canonicalizeUpstreamFlow } from '../conformance-normalize.ts';
import {
  canonicalizeAgentSelector,
  canonicalizeUpstreamSelector,
} from '../conformance-selector-projection.ts';
import { parseMaestroProgram } from '../program-ir-parser.ts';

test('canonicalizes command labels separately from selector identity', () => {
  const program = parseMaestroProgram(
    ['---', '- tapOn:', '    text: Save', '    label: save action'].join('\n'),
  );

  expect(canonicalizeAgentCommands(program)).toEqual([
    {
      kind: 'tap',
      longPress: false,
      repeat: 1,
      label: 'save action',
      target: { selector: { text: 'Save' } },
    },
  ]);
  expect(
    canonicalizeUpstreamFlow([
      {
        type: 'TapOnElementCommand',
        fields: {
          label: 'save action',
          selector: { textRegex: 'Save', label: 'must not match' },
          longPress: false,
          repeat: null,
        },
      },
    ]),
  ).toEqual([
    {
      kind: 'tap',
      longPress: false,
      repeat: 1,
      label: 'save action',
      target: { selector: { text: 'Save' } },
    },
  ]);
});

test('selector projection drops metadata-shaped label fields', () => {
  expect(canonicalizeUpstreamSelector({ textRegex: 'Save', label: 'command metadata' })).toEqual({
    text: 'Save',
  });
  expect(canonicalizeAgentSelector({ text: 'Save' })).toEqual({ text: 'Save' });
});

test('canonical selector projection preserves recursive tree relations', () => {
  expect(
    canonicalizeAgentSelector({
      id: 'card',
      index: 1,
      childOf: { id: 'screen' },
      below: { text: 'Caption' },
      above: { id: 'header' },
      leftOf: { id: 'rail' },
      rightOf: { text: 'Menu' },
      containsChild: { id: 'title' },
      containsDescendants: [{ text: 'Save', childOf: { id: 'body' } }],
    }),
  ).toEqual({
    id: 'card',
    index: 1,
    childOf: { id: 'screen' },
    below: { text: 'Caption' },
    above: { id: 'header' },
    leftOf: { id: 'rail' },
    rightOf: { text: 'Menu' },
    containsChild: { id: 'title' },
    containsDescendants: [{ text: 'Save', childOf: { id: 'body' } }],
  });
});

test('canonicalizes repeat conditions from agent and upstream command shapes', () => {
  const program = parseMaestroProgram(
    [
      '---',
      '- repeat:',
      '    while:',
      '      platform: Android',
      '      notVisible: Ready',
      '    commands: []',
      '- repeat:',
      '    times: 4',
      '    while:',
      '      true: "${output.counter < 3}"',
      '    commands: []',
      '- repeat:',
      '    times: 2',
      '    while:',
      '      true: true',
      '    commands: []',
    ].join('\n'),
  );

  expect(canonicalizeAgentCommands(program)).toEqual([
    { kind: 'repeat', while: { platform: 'android', notVisible: { text: 'Ready' } } },
    { kind: 'repeat', times: 4, while: { true: '${output.counter < 3}' } },
    { kind: 'repeat', times: 2, while: { true: 'true' } },
  ]);
  expect(
    canonicalizeUpstreamFlow([
      {
        type: 'RepeatCommand',
        fields: {
          times: null,
          condition: {
            platform: 'Android',
            visible: null,
            notVisible: { textRegex: 'Ready' },
            scriptCondition: null,
          },
        },
      },
      {
        type: 'RepeatCommand',
        fields: {
          times: '4',
          condition: {
            visible: null,
            notVisible: null,
            scriptCondition: '${output.counter < 3}',
          },
        },
      },
      {
        type: 'RepeatCommand',
        fields: {
          times: '2',
          condition: { visible: null, notVisible: null, scriptCondition: 'true' },
        },
      },
    ]),
  ).toEqual([
    { kind: 'repeat', while: { platform: 'android', notVisible: { text: 'Ready' } } },
    { kind: 'repeat', times: 4, while: { true: '${output.counter < 3}' } },
    { kind: 'repeat', times: 2, while: { true: 'true' } },
  ]);
});
