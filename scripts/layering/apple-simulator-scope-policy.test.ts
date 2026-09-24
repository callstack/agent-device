import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appleSimulatorScopeViolations,
  isPolicedSimulatorScopeFile,
} from './apple-simulator-scope-policy.ts';

const APPLE_SRC = 'packages/platform-apple/src/';
const ARGV_MESSAGE =
  /^builds or forges simctl argv outside core\/simctl\.ts; use scopeSimctlArgsForDevice\/runSimctlForDevice or a SimulatorAddress from simulatorAddressFor\(device\)$/;
const SET_SCOPE_MESSAGE =
  /^set-scope simctl builder outside its owners; a call that names a udid takes its set from the device \(scopeSimctlArgsForDevice\) or its SimulatorAddress$/;

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

const HAND_BUILT_SPAWN = "runXcrun(['simctl', 'spawn', udid, binary]);\n";
const HAND_BUILT_BRIDGE = "runCmdBackground('xcrun', ['simctl', 'spawn', udid, bridge]);\n";
const EXPLICIT_DEFAULT_SET =
  "scopeSimctlArgs(['spawn', udid, bin], { simulatorSetPath: undefined });\n";
const ALIASED_SET_SCOPE = "import { scopeSimctlArgs as scope } from '../core/simctl.ts';\n";
const FORGED_ARGV =
  "resolveAppleToolProvider().simctl.run(['spawn', udid, bin] as unknown as ScopedSimctlArgs);\n";
const FORGED_ADDRESS = 'const address = { udid, simulatorSetPath } as SimulatorAddress;\n';
const HAND_PREFIX = "const args = ['--set', path, ...args];\n";

test('the two #2818 hand-built simctl spawns are refused', () => {
  assertFlagged(`${APPLE_SRC}foldable/simulator-hid.ts`, HAND_BUILT_SPAWN, ARGV_MESSAGE);
  assertFlagged(`${APPLE_SRC}snapshot-source/host.ts`, HAND_BUILT_BRIDGE, ARGV_MESSAGE);
});

test('the set-scope builder is refused outside its owners, aliased or not', () => {
  assertFlagged(`${APPLE_SRC}foldable/simulator-hid.ts`, EXPLICIT_DEFAULT_SET, SET_SCOPE_MESSAGE);
  assertFlagged(`${APPLE_SRC}snapshot-source/host.ts`, ALIASED_SET_SCOPE, SET_SCOPE_MESSAGE);
});

test('a forged scoped argv or simulator address is refused', () => {
  assertFlagged('src/platform-runtime-planted.ts', FORGED_ARGV, ARGV_MESSAGE);
  assertFlagged(`${APPLE_SRC}foldable/simulator-hid.ts`, FORGED_ADDRESS, ARGV_MESSAGE);
  assertFlagged(
    `${APPLE_SRC}foldable/simulator-hid.ts`,
    'const address = <SimulatorAddress>{ udid, simulatorSetPath };\n',
    ARGV_MESSAGE,
  );
});

test('a hand-rolled --set prefix is refused outside core/simctl.ts', () => {
  assertFlagged(`${APPLE_SRC}foldable/simulator-hid.ts`, HAND_PREFIX, ARGV_MESSAGE);
});

test('the argv owners may build, prefix and mint', () => {
  const owner = `${APPLE_SRC}core/simctl.ts`;
  for (const source of [
    HAND_BUILT_SPAWN,
    HAND_BUILT_BRIDGE,
    EXPLICIT_DEFAULT_SET,
    ALIASED_SET_SCOPE,
    FORGED_ARGV,
    FORGED_ADDRESS,
    HAND_PREFIX,
  ]) {
    assert.deepEqual(violationsFor(owner, source), [], source);
  }
  assert.deepEqual(
    violationsFor(
      `${APPLE_SRC}core/tool-provider.ts`,
      "provider.simctl.run(toolArgs as unknown as ScopedSimctlArgs, options);\nrunCmd('xcrun', ['simctl', ...args]);\n",
    ),
    [],
  );
});

test('the tool provider may not forge an address or a --set prefix', () => {
  assertFlagged(`${APPLE_SRC}core/tool-provider.ts`, FORGED_ADDRESS, ARGV_MESSAGE);
  assertFlagged(`${APPLE_SRC}core/tool-provider.ts`, HAND_PREFIX, ARGV_MESSAGE);
});

test('the calls that name no device may take set scope', () => {
  for (const file of [`${APPLE_SRC}simulator-inventory.ts`, `${APPLE_SRC}logs/doctor.ts`]) {
    assert.deepEqual(
      violationsFor(
        file,
        "import { scopeSimctlArgs } from './core/simctl.ts';\nscopeSimctlArgs(['help'], { simulatorSetPath: undefined });\n",
      ),
      [],
      file,
    );
  }
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
    assert.deepEqual(violationsFor(file, HAND_BUILT_SPAWN + EXPLICIT_DEFAULT_SET), [], file);
  }
  assert.equal(isPolicedSimulatorScopeFile(`${APPLE_SRC}foldable/simulator-hid.ts`), true);
  assert.equal(isPolicedSimulatorScopeFile('src/platform-runtime-apple-tool-host.ts'), true);
});

test('devicectl argv and scoped device calls are not simctl violations', () => {
  assert.deepEqual(
    violationsFor(
      `${APPLE_SRC}deployment/runtime.ts`,
      [
        "host.appleTools.run({ tool: 'devicectl', args: ['device', 'install', 'app', '--device', id] });",
        "host.appleTools.run({ tool: 'simctl', args: scopeSimctlArgsForDevice(device, ['boot', device.id]) });",
        "runXcrun(buildSimctlArgsForAddress(simulatorAddressFor(device), ['spawn', device.id]));",
      ].join('\n'),
    ),
    [],
  );
});

test('an unaliased import of the set-scope builder is one violation', () => {
  assertFlagged(
    `${APPLE_SRC}snapshot-source/host.ts`,
    "import { scopeSimctlArgs } from '../core/simctl.ts';\n",
    SET_SCOPE_MESSAGE,
  );
});

test('a violation reports the line of the offending node', () => {
  const [violation] = violationsFor(
    `${APPLE_SRC}foldable/simulator-hid.ts`,
    `const a = 1;\n\n${HAND_BUILT_SPAWN}`,
  );
  assert.equal(violation!.line, 3);
});
