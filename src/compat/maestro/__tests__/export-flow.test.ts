import { parseAllDocuments } from 'yaml';
import { describe, expect, test } from 'vitest';
import { AppError } from '../../../kernel/errors.ts';
import { exportReplayScriptToMaestro } from '../export-flow.ts';
import { parseMaestroProgram } from '../program-ir-parser.ts';

describe('exportReplayScriptToMaestro', () => {
  test('exports app launch, selectors, input, keyboard, assertions, and screenshots', () => {
    const result = exportReplayScriptToMaestro(`env USER="Ada"
context platform=ios target=mobile
open com.example.app --relaunch
click id="email"
fill id="email" "ada@example.com"
keyboard dismiss
find text "Continue" exists
screenshot "./artifacts/checkout"
`);

    const docs = parseYamlDocs(result.yaml);
    expect(() => parseMaestroProgram(result.yaml)).not.toThrow();
    expect(docs).toEqual([
      { appId: 'com.example.app', env: { USER: 'Ada' } },
      [
        { launchApp: { appId: 'com.example.app', stopApp: true } },
        { tapOn: { id: 'email' } },
        { tapOn: { id: 'email' } },
        { inputText: 'ada@example.com' },
        'hideKeyboard',
        { assertVisible: 'Continue' },
        { takeScreenshot: './artifacts/checkout' },
      ],
    ]);
    expect(result.warnings).toEqual([
      {
        line: 5,
        action: 'fill id="email" ada@example.com',
        message:
          'fill exports as tapOn + inputText; Maestro may append text instead of replacing existing field contents',
      },
    ]);
  });

  test('exports coordinate gestures and sleep waits with warnings', () => {
    const result = exportReplayScriptToMaestro(`open com.example.app
click 120 240
swipe 200 700 200 200 300 --count 2
wait 500
`);

    expect(parseYamlDocs(result.yaml)).toEqual([
      { appId: 'com.example.app' },
      [
        'launchApp',
        { tapOn: { point: '120,240' } },
        { swipe: { start: '200,700', end: '200,200', duration: 300 } },
        { swipe: { start: '200,700', end: '200,200', duration: 300 } },
        { waitForAnimationToEnd: { timeout: 500 } },
      ],
    ]);
    expect(result.warnings).toEqual([
      {
        line: 4,
        action: 'wait 500',
        message:
          'wait <ms> exports as waitForAnimationToEnd and may return before the full duration',
      },
    ]);
  });

  test('warns when explicit long-press durations export to Maestro defaults', () => {
    const result = exportReplayScriptToMaestro(`open com.example.app
longpress "label=\\"Last message\\"" 800
click id="hold-button" --hold-ms 1200
press text="Retry" --hold-ms 1500
`);

    expect(parseYamlDocs(result.yaml)).toEqual([
      { appId: 'com.example.app' },
      [
        'launchApp',
        { longPressOn: { label: 'Last message' } },
        { longPressOn: { id: 'hold-button' } },
        { longPressOn: { text: 'Retry' } },
      ],
    ]);
    expect(result.warnings).toEqual([
      {
        line: 2,
        action: 'longpress label="Last message" 800',
        message:
          'long-press duration exports as Maestro longPressOn; Maestro uses its default long-press duration instead of 800ms',
      },
      {
        line: 3,
        action: 'click id="hold-button"',
        message:
          'long-press duration exports as Maestro longPressOn; Maestro uses its default long-press duration instead of 1200ms',
      },
      {
        line: 4,
        action: 'press text="Retry"',
        message:
          'long-press duration exports as Maestro longPressOn; Maestro uses its default long-press duration instead of 1500ms',
      },
    ]);
  });

  test('warns when double-tap and hold exports ignore repeated tap options', () => {
    const result = exportReplayScriptToMaestro(`open com.example.app
click id="retry" --double-tap --count 2 --interval-ms 200
press text="Hold" --hold-ms 1000 --count 3 --interval-ms 150
`);

    expect(parseYamlDocs(result.yaml)).toEqual([
      { appId: 'com.example.app' },
      ['launchApp', { doubleTapOn: { id: 'retry' } }, { longPressOn: { text: 'Hold' } }],
    ]);
    expect(result.warnings).toEqual([
      {
        line: 2,
        action: 'click id="retry"',
        message: 'tap --count 2 is not represented by Maestro doubleTapOn',
      },
      {
        line: 2,
        action: 'click id="retry"',
        message: 'tap --interval-ms 200 is not represented by Maestro doubleTapOn',
      },
      {
        line: 3,
        action: 'press text="Hold"',
        message:
          'long-press duration exports as Maestro longPressOn; Maestro uses its default long-press duration instead of 1000ms',
      },
      {
        line: 3,
        action: 'press text="Hold"',
        message: 'tap --count 3 is not represented by Maestro longPressOn',
      },
      {
        line: 3,
        action: 'press text="Hold"',
        message: 'tap --interval-ms 150 is not represented by Maestro longPressOn',
      },
    ]);
  });

  test('rejects native-only replay actions', () => {
    expect(() =>
      exportReplayScriptToMaestro(`open com.example.app
snapshot -i
get text id="status"
`),
    ).toThrowError(AppError);
    try {
      exportReplayScriptToMaestro(`open com.example.app
snapshot -i
get text id="status"
`);
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).message).toContain('line 2 (snapshot)');
      expect((error as AppError).message).toContain('line 3 (get text id="status")');
    }
  });
});

function parseYamlDocs(script: string): unknown[] {
  return parseAllDocuments(script).map((doc) => doc.toJSON());
}
