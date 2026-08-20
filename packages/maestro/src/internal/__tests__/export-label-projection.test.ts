import { parseAllDocuments } from 'yaml';
import { expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { SessionAction } from '@agent-device/contracts/session';
import { exportReplayActionsToMaestro, inspectMaestroFlow } from '../../index.ts';
import { MAESTRO_SELECTOR_PROJECTION } from '../selector-vocabulary.ts';
import { projectSelectorExpression } from '@agent-device/selectors';

test('projects native label selectors to text with a warning and self-parses', () => {
  const result = exportReplayActionsToMaestro(
    [action('open', ['com.example.app']), action('click', ['label="Save"'])],
    {
      actionLines: [1, 2],
      resolveSelector: (expression) =>
        projectSelectorExpression(expression, MAESTRO_SELECTOR_PROJECTION),
    },
  );

  expect(parseAllDocuments(result.yaml).map((document) => document.toJSON())).toEqual([
    { appId: 'com.example.app' },
    ['launchApp', { tapOn: { text: 'Save' } }],
  ]);
  expect(result.warnings).toEqual([
    {
      line: 2,
      action: 'click label="Save"',
      message:
        'label= selectors export as Maestro text; Maestro text matching is broader than agent-device label-only matching',
    },
  ]);
  expect(() => inspectMaestroFlow(result.yaml, 'exported.yaml')).not.toThrow();
});

test('keeps compound selectors that include label as hard export errors', () => {
  expect(() =>
    exportReplayActionsToMaestro([action('click', ['role=button label="Save"'])], {
      resolveSelector: (expression) =>
        projectSelectorExpression(expression, MAESTRO_SELECTOR_PROJECTION),
    }),
  ).toThrow(AppError);
});

function action(command: string, positionals: string[]): SessionAction {
  return { ts: 0, command, positionals, flags: {} };
}
