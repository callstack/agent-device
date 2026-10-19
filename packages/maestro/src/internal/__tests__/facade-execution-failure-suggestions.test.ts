import { describe, expect, test } from 'vitest';
import type { SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import {
  collectMaestroFailureSuggestions,
  executeMaestroFlow,
  inspectMaestroFlow,
  type MaestroRuntimePort,
} from '../../index.ts';

/**
 * Drives `collectMaestroFailureSuggestions` through the real engine: the flow is parsed, planned,
 * and executed against a port whose every call fails, so the failure event carries the same
 * runtime command the daemon's divergence report ranks against a snapshot.
 */

const noMaestroSources = () => {
  throw new Error('test flows declare no includes');
};

function failingPort(): MaestroRuntimePort {
  const error = new Error('fixture command failed');
  return {
    execute: async () => {
      throw error;
    },
    observe: async () => {
      throw error;
    },
  };
}

function snapshot(nodes: SnapshotNode[]): SnapshotState {
  return { createdAt: 0, nodes };
}

const saveButton: SnapshotNode = {
  ref: 'e1',
  index: 0,
  type: 'Button',
  identifier: 'save',
  label: 'Save',
  rect: { x: 0, y: 0, width: 100, height: 40 },
  hittable: true,
};

async function suggestionsFor(
  flowYaml: string,
  platform: 'android' | 'ios' | 'web',
  nodes: SnapshotNode[],
) {
  const flow = inspectMaestroFlow(flowYaml, '/flows/suggestions.yaml');
  const outcome = await executeMaestroFlow(flow, failingPort(), {
    platform,
    readSource: noMaestroSources,
  });
  if (outcome.ok || !outcome.failure) throw new Error('expected the flow to fail');
  return collectMaestroFailureSuggestions(outcome.failure, snapshot(nodes));
}

describe('Maestro failure suggestion queries', () => {
  test('a target tapOn suggests ranked candidates for its selector', async () => {
    const suggestions = await suggestionsFor(
      ['appId: com.example.app', '---', '- tapOn:', '    id: save', ''].join('\n'),
      'android',
      [saveButton],
    );
    expect(suggestions.map(({ node, basis }) => [node.ref, basis])).toEqual([['e1', 'id']]);
  });

  test('a coordinate tapOn has no selector to suggest from', async () => {
    const suggestions = await suggestionsFor(
      ['appId: com.example.app', '---', '- tapOn:', '    point: 50%,50%', ''].join('\n'),
      'android',
      [saveButton],
    );
    expect(suggestions).toEqual([]);
  });

  test.each([
    ['doubleTapOn', '- doubleTapOn:\n    id: save\n'],
    ['longPressOn', '- longPressOn:\n    id: save\n'],
    ['assertVisible', '- assertVisible:\n    id: save\n'],
    ['assertNotVisible', '- assertNotVisible:\n    id: save\n'],
    ['scrollUntilVisible', '- scrollUntilVisible:\n    element:\n      id: save\n'],
  ])('%s failure suggests from its target selector', async (_name, authored) => {
    const suggestions = await suggestionsFor(
      `appId: com.example.app\n---\n${authored}`,
      'android',
      [saveButton],
    );
    expect(suggestions.map(({ node, basis }) => [node.ref, basis])).toEqual([['e1', 'id']]);
  });

  test('a coordinate doubleTapOn has no selector to suggest from', async () => {
    const suggestions = await suggestionsFor(
      ['appId: com.example.app', '---', '- doubleTapOn:', '    point: 100,200', ''].join('\n'),
      'android',
      [saveButton],
    );
    expect(suggestions).toEqual([]);
  });

  test('extendedWaitUntil suggests from its visible condition', async () => {
    const suggestions = await suggestionsFor(
      [
        'appId: com.example.app',
        '---',
        '- extendedWaitUntil:',
        '    visible:',
        '      id: save',
        '    timeout: 1',
        '',
      ].join('\n'),
      'android',
      [saveButton],
    );
    expect(suggestions.map(({ node }) => node.ref)).toEqual(['e1']);
  });

  test('extendedWaitUntil falls back to its notVisible condition', async () => {
    const suggestions = await suggestionsFor(
      [
        'appId: com.example.app',
        '---',
        '- extendedWaitUntil:',
        '    notVisible:',
        '      id: save',
        '    timeout: 1',
        '',
      ].join('\n'),
      'android',
      [saveButton],
    );
    expect(suggestions.map(({ node }) => node.ref)).toEqual(['e1']);
  });

  test('a target swipe suggests from its from-selector', async () => {
    const suggestions = await suggestionsFor(
      [
        'appId: com.example.app',
        '---',
        '- swipe:',
        '    direction: UP',
        '    from:',
        '      id: save',
        '',
      ].join('\n'),
      'android',
      [saveButton],
    );
    expect(suggestions.map(({ node }) => node.ref)).toEqual(['e1']);
  });

  test('a screen swipe has no selector to suggest from', async () => {
    const suggestions = await suggestionsFor(
      ['appId: com.example.app', '---', '- swipe:', '    direction: UP', ''].join('\n'),
      'android',
      [saveButton],
    );
    expect(suggestions).toEqual([]);
  });

  test('a command without any target yields no suggestions', async () => {
    const suggestions = await suggestionsFor(
      ['appId: com.example.app', '---', '- back', ''].join('\n'),
      'android',
      [saveButton],
    );
    expect(suggestions).toEqual([]);
  });

  test('suggestions stay empty on a platform the snapshot ranking does not cover', async () => {
    const suggestions = await suggestionsFor(
      ['appId: com.example.app', '---', '- assertVisible:', '    id: save', ''].join('\n'),
      'web',
      [saveButton],
    );
    expect(suggestions).toEqual([]);
  });

  test('a text selector against a label match reports the `label` basis', async () => {
    const suggestions = await suggestionsFor(
      ['appId: com.example.app', '---', '- assertVisible:', '    text: Save', ''].join('\n'),
      'android',
      [{ ...saveButton, identifier: undefined }],
    );
    // With no identifier to match, the candidate matches on its label, so the basis is `label`.
    expect(suggestions.map(({ basis }) => basis)).toEqual(['label']);
  });

  test('a text selector the candidate carries as visible text reports the `id` basis', async () => {
    const suggestions = await suggestionsFor(
      ['appId: com.example.app', '---', '- assertVisible:', '    text: Save', ''].join('\n'),
      'android',
      [
        {
          ref: 'e1',
          index: 0,
          type: 'Button',
          // No label: the text "Save" is the node's identifier, i.e. its visible text.
          identifier: 'Save',
          rect: { x: 0, y: 0, width: 100, height: 40 },
          hittable: true,
        },
      ],
    );
    expect(suggestions.map(({ basis }) => basis)).toEqual(['id']);
  });

  test('a selector with neither text nor id still ranks nodes under the `other` basis', async () => {
    const suggestions = await suggestionsFor(
      ['appId: com.example.app', '---', '- assertVisible:', '    enabled: true', ''].join('\n'),
      'android',
      [{ ...saveButton, identifier: undefined }],
    );
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.every(({ basis }) => basis === 'other')).toBe(true);
  });
});
