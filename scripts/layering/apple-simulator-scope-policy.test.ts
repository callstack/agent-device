import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appleSimulatorScopeViolations,
  isPolicedSimulatorScopeFile,
} from './apple-simulator-scope-policy.ts';

const APPLE_SRC = 'packages/platform-apple/src/';
const HAND_BUILT_MESSAGE =
  /^hands xcrun an argv whose tool is not a literal non-simctl name; build a simctl argv with buildSimctlArgsForDevice or buildSimctlArgsForAddress$/;
const FORGED_MESSAGE =
  /^forges a simulator-scope brand outside core\/simctl\.ts and core\/tool-provider\.ts; mint it with simulatorAddressFor, scopeSimctlArgsForDevice or buildSimctlArgsForDevice$/;

function violationsFor(file: string, source: string) {
  return appleSimulatorScopeViolations(new Map([[file, source]]));
}

function assertFlagged(file: string, source: string, message: RegExp): void {
  const violations = violationsFor(file, source);
  assert.equal(violations.length, 1, `${file}: ${source}`);
  assert.equal(violations[0]!.rule, 'R79 apple-simulator-scope');
  assert.equal(violations[0]!.file, file);
  assert.match(violations[0]!.message, message);
}

const HAND_BUILT_BRIDGE = "runCmdBackground('xcrun', ['simctl', 'spawn', udid, bridge]);\n";
const FORGED_ARGV =
  "resolveAppleToolProvider().simctl.run(['spawn', udid, bin] as unknown as ScopedSimctlArgs);\n";
const FORGED_ADDRESS = 'const address = { udid, simulatorSetPath } as SimulatorAddress;\n';

test('the #2818 bridge spawn through a plain xcrun executor is refused', () => {
  assertFlagged(`${APPLE_SRC}snapshot-source/host.ts`, HAND_BUILT_BRIDGE, HAND_BUILT_MESSAGE);
});

test('an xcrun argv must name its tool as a literal other than simctl', () => {
  for (const source of [
    "const tool = 'simctl';\nrunCmd('xcrun', [tool, 'spawn', udid, bin]);\n",
    "runCmd('xcrun', [`simctl`, 'boot', udid]);\n",
    "host.commands.run({ executable: 'xcrun', args: ['simctl', 'spawn', udid, 'log', 'stream'] });\n",
  ]) {
    assertFlagged(`${APPLE_SRC}logs/start.ts`, source, HAND_BUILT_MESSAGE);
  }
});

test('the tool provider has no exemption for a hand-built simctl argv', () => {
  assertFlagged(
    `${APPLE_SRC}core/tool-provider.ts`,
    "runCmd('xcrun', ['simctl', ...args]);\n",
    HAND_BUILT_MESSAGE,
  );
});

test('a cast to a simulator-scope brand is refused outside the mint modules', () => {
  assertFlagged('src/platform-runtime-planted.ts', FORGED_ARGV, FORGED_MESSAGE);
  assertFlagged(
    `${APPLE_SRC}core/simulator.ts`,
    'return argv as ScopedSimctlCommand;\n',
    FORGED_MESSAGE,
  );
  assertFlagged(`${APPLE_SRC}foldable/simulator-hid.ts`, FORGED_ADDRESS, FORGED_MESSAGE);
  assertFlagged(
    `${APPLE_SRC}foldable/simulator-hid.ts`,
    'const address = <SimulatorAddress>{ udid, simulatorSetPath };\n',
    FORGED_MESSAGE,
  );
});

test('the mint modules may cast to the brands they mint', () => {
  for (const mint of [`${APPLE_SRC}core/simctl.ts`, `${APPLE_SRC}core/tool-provider.ts`]) {
    assert.deepEqual(violationsFor(mint, FORGED_ARGV + FORGED_ADDRESS), [], mint);
  }
});

test('named tools, builder output, pass-through argv and simctl text elsewhere are not violations', () => {
  assert.deepEqual(
    violationsFor(
      `${APPLE_SRC}core/tool-provider.ts`,
      [
        "runCmd('xcrun', ['devicectl', ...args]);",
        "runCmd('xcrun', ['--find', name]);",
        "runCmd('xcrun', simctlCommand(args));",
        "runCmd('xcrun', [...argv]);",
        "runCmdBackground('xcrun', args);",
        "runCmdBackground('xcrun', buildSimctlArgsForAddress(simulator, ['spawn', simulator.udid]));",
        "host.commands.run({ executable: 'log', args: ['stream'] });",
        "host.appleTools.run({ tool: 'simctl', args: scopeSimctlArgsForDevice(device, ['boot', id]) });",
        "const tools = ['simctl', 'devicectl'];",
        "if (args.includes('--set') || tool === 'simctl') note(tool);",
      ].join('\n'),
    ),
    [],
  );
});

test('tests, fixtures and scripts are not policed', () => {
  for (const file of [
    `${APPLE_SRC}foldable/simulator-hid.test.ts`,
    `${APPLE_SRC}core/__tests__/simctl.test.ts`,
    `${APPLE_SRC}runtime.fixtures.ts`,
    'scripts/ios-snapshot-benchmark/lifecycle.ts',
    'test/integration/provider-scenarios/providers.ts',
  ]) {
    assert.equal(isPolicedSimulatorScopeFile(file), false, file);
    assert.deepEqual(violationsFor(file, HAND_BUILT_BRIDGE + FORGED_ADDRESS), [], file);
  }
  assert.equal(isPolicedSimulatorScopeFile(`${APPLE_SRC}foldable/simulator-hid.ts`), true);
  assert.equal(isPolicedSimulatorScopeFile('src/platform-runtime-apple-tool-host.ts'), true);
});

test('a violation reports the line of the offending argv', () => {
  const [violation] = violationsFor(
    `${APPLE_SRC}snapshot-source/host.ts`,
    `const a = 1;\n\n${HAND_BUILT_BRIDGE}`,
  );
  assert.equal(violation!.line, 3);
});
