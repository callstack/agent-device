// Parser fuzz targets (#1414).
//
// Every target takes one string case and calls a real parser. The harness owns the
// invariant (typed AppError with a non-empty hint, no hang); a target only says how a
// case string reaches its parser, and supplies the seed inputs the mutator chews on.
//
// Keep targets pure and synchronous: the hang watchdog (scripts/fuzz/worker.ts) can only
// attribute a stall to a case if the case runs to completion in one tick.

import { parseArgs } from '../../src/cli/parser/args.ts';
import { validateSelectorExpression } from '@agent-device/selectors';
import { parseReplayScriptDetailed } from '@agent-device/ad-script';
import { readCliBatchStepsJson } from '../../src/cli/batch-steps.ts';
import { inspectMaestroFlow } from '@agent-device/maestro';
import type { FuzzTarget } from './target-types.ts';
import { acceptCase, makeValidationCheck, rejectCase } from './validation-case.ts';

// argv is carried as one string so a case (and its corpus entry, artifact, and repro
// command) stays a single copy-pasteable value. Splitting on spaces is deliberate: the
// fuzzer wants odd tokens, not a faithful shell grammar.
function toArgv(input: string): string[] {
  return input.split(' ').filter((token) => token.length > 0);
}

export const FUZZ_TARGETS: readonly FuzzTarget[] = [
  {
    name: 'cli-args',
    description: 'parseArgs (strict flags)',
    run: (input) => void parseArgs(toArgv(input), { strictFlags: true }),
    seeds: [
      'click --selector text=Login',
      'open com.example.app --platform ios --json',
      'snapshot --depth 3 --format text',
      'fill @e1 --text hello --submit',
      'batch --steps [] --timeout 1000',
      'devices --platform android --json --debug',
      'wait --selector role=button --timeout-ms 500',
      'test replays -- --raw --passthrough',
      'click --selector',
      '--json',
      '',
    ],
  },
  {
    name: 'selector',
    description: 'validateSelectorExpression',
    run: (input) => void validateSelectorExpression(input),
    seeds: [
      'text=Login',
      'label="Sign in" && role=button',
      'text=Save || label=Done',
      'id=com.example:id/button[2]',
      'role=button and is=enabled',
      'text~=partial',
      'label="quoted \\"inner\\" value"',
      '@e1',
      'text=🚀',
      'text=',
      '',
    ],
  },
  {
    name: 'replay-script',
    description: 'parseReplayScriptDetailed (.ad scripts)',
    run: (input) => void parseReplayScriptDetailed(input),
    seeds: [
      'open com.example.app\nclick text=Login\nclose\n',
      '# context platform=ios target=mobile\nopen com.example.app\n',
      '# context timeoutMs=1000 retries=2\nsnapshot\n',
      '# target-v1 role=button label=Login\nclick @e1\n',
      'fill @e1 --text "hello world"\nassert text=Welcome\n',
      'swipe 10 20 30 40\nwait 250\n',
      'env FOO=bar\nclick text=${FOO}\n',
      'screenshot --quality low\n',
      '# target-v1 role=button\n\nclick @e1\n',
      '',
    ],
  },
  {
    name: 'batch-steps',
    description: 'readCliBatchStepsJson (batch --steps)',
    run: (input) => void readCliBatchStepsJson(input),
    seeds: [
      '[{"command":"snapshot","input":{}}]',
      '[{"command":"click","input":{"selector":"text=Login"}}]',
      '[{"command":"open","positionals":["com.example.app"],"flags":{"json":true}}]',
      '[{"command":"snapshot","input":{}},{"command":"close","input":{}}]',
      '[{"command":"wait","input":{"timeoutMs":250}}]',
      '[]',
      '{}',
      'not json',
      '',
    ],
  },
  {
    // Expectation-carrying cases built from the CLI schema registry (#1781 B2): each case is a
    // JSON envelope (validation-case.ts) whose argv tokenizes cleanly, so the planted violation
    // surfaces in command validation and is asserted against its specific error code. `run`
    // exists for the classic path only; `check` owns the judgment.
    name: 'cli-validation',
    description: 'parseArgs via schema-derived command lines with expected outcomes',
    run: (input) => void runCliValidationPayload(JSON.parse(input).payload as string[]),
    check: makeValidationCheck('cli-validation', (payload) =>
      runCliValidationPayload(payload as string[]),
    ),
    seeds: [
      acceptCase(['open', 'com.example.app']),
      acceptCase(['click', 'text=Login', '--json']),
      rejectCase(['devices', '--platform=bogus'], 'bad-enum-value'),
      rejectCase(['snapshot', '--depth'], 'missing-flag-value'),
      // Two command-validation rules whose entire input space is a handful of strings: `batch` is
      // the only command with a step-source rule, and `backMode` the only flag key reachable
      // through two tokens. Generating them re-executed ~15 payloads thousands of times a night
      // for no added reach, so they are pinned here and run verbatim once per run, before any
      // generated case. They are seed regressions, not generated reach — #1781's table says so.
      rejectCase(['batch'], 'batch-step-source-none'),
      rejectCase(['batch', '--steps=[]', '--steps-file=steps.json'], 'batch-step-source-both'),
      rejectCase(['back', '--in-app', '--system'], 'conflicting-flag-tokens'),
      rejectCase(['back', '--system', '--in-app'], 'conflicting-flag-tokens'),
    ],
  },
  {
    // Same contract for Maestro flows: shape-valid YAML with one planted violation, so the
    // failure surfaces in the command-shape validation behind the YAML tokenizer.
    name: 'maestro-validation',
    description: 'inspectMaestroFlow via shape-derived flows with expected outcomes',
    run: (input) => void inspectMaestroFlow(JSON.parse(input).payload as string, 'fuzz.yaml'),
    check: makeValidationCheck(
      'maestro-validation',
      (payload) => void inspectMaestroFlow(payload as string, 'fuzz.yaml'),
    ),
    seeds: [
      acceptCase('appId: com.example.app\n---\n- launchApp\n- tapOn: "Login"\n'),
      rejectCase('appId: com.example.app\n---\n- clickOn: "Login"\n', 'unsupported-command'),
      rejectCase('appId: com.example.app\n---\n- tapOn:\n bogusField: "x"\n', 'unsupported-field'),
    ],
  },
  {
    name: 'maestro',
    description: 'parseMaestroProgram (Maestro compat)',
    run: (input) => void inspectMaestroFlow(input, 'fuzz.yaml'),
    seeds: [
      'appId: com.example.app\n---\n- launchApp\n- tapOn: "Login"\n',
      'appId: com.example.app\n---\n- tapOn:\n    id: "login"\n',
      'appId: com.example.app\n---\n- inputText: "hello"\n- assertVisible: "Welcome"\n',
      'appId: com.example.app\n---\n- swipe:\n    direction: UP\n',
      'appId: com.example.app\n---\n- runFlow: other.yaml\n',
      'appId: com.example.app\n---\n- repeat:\n    times: 2\n    commands:\n      - back\n',
      '- launchApp\n',
      'appId: com.example.app\n---\n',
      '',
    ],
  },
];

function runCliValidationPayload(argv: readonly string[]): void {
  void parseArgs([...argv], { strictFlags: true });
}
