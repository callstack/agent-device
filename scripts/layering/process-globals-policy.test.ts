import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LAYERING_RULES, type LayeringContext } from './check.ts';
import { PROCESS_GLOBALS_RULE, processGlobalsViolations } from './process-globals-policy.ts';

function check(source: string, file = 'src/commands/example.ts') {
  return processGlobalsViolations(new Map([[file, source]]));
}

test('the registered gate rejects process configuration and command-host scope in non-entry sources', () => {
  const allTypeScriptSources = new Map([
    ['src/commands/example.ts', 'const env = process.env;\ncommandHostEnvironment();'],
  ]);
  const ratchets = {
    typeInversions: {},
    largestTypeCycle: [],
    sessionState: { writerOwnedFields: 0, ownerFileClaims: 0 },
  };
  const context: LayeringContext = {
    sourceFiles: [...allTypeScriptSources.keys()],
    sources: allTypeScriptSources,
    allTypeScriptSources,
    trackedSrcUtilsFiles: [],
    edges: [],
    ratchets,
    reference: ratchets,
  };
  const violations = LAYERING_RULES['process-globals'](context);
  assert.deepEqual(
    violations.map(({ rule, file, line }) => ({ rule, file, line })),
    [1, 2].map((line) => ({ rule: PROCESS_GLOBALS_RULE, file: 'src/commands/example.ts', line })),
  );
});

test('all six process globals fail, including bracketed and imported process members', () => {
  for (const member of ['env', 'cwd', 'on', 'once', 'exit', 'emitWarning']) {
    for (const expression of [
      `process.${member}`,
      `process['${member}']`,
      `globalThis.process.${member}`,
    ]) {
      assert.equal(check(`${expression};`).length, 1, expression);
    }
    assert.equal(check(`import p from 'node:process'; p.${member};`).length, 1);
    assert.equal(check(`import { ${member} as local } from 'process';`).length, 1);
    assert.equal(check(`const { ${member}: local } = process;`).length, 1);
  }
});

test('entry declarations permit process reads but do not permit ambient command-host calls', () => {
  for (const file of [
    'src/bin.ts',
    'src/cli.ts',
    'src/cli/commands/example.ts',
    'src/daemon.ts',
    'src/agent-device-client.ts',
    'packages/capture-kit/src/png-worker.ts',
    'packages/maestro/src/daemon-port/run-script-http-child.ts',
    'packages/react-native/src/companion/client-companion-tunnel-worker.ts',
    'src/sdk/host.ts',
    'src/io.ts',
  ]) {
    assert.deepEqual(check('process.env; process.on("SIGINT", stop);', file), [], file);
    assert.equal(check('commandHostEnvironment();', file).length, 1, file);
  }
});

test('command spawn boundaries permit the scoped host but still reject raw process configuration', () => {
  for (const file of [
    'packages/host-kit/src/internal/exec.ts',
    'packages/platform-apple/src/core/tool-provider.ts',
    'packages/platform-linux/src/tool-provider.ts',
    'src/platform-runtime-android-adb-host.ts',
  ]) {
    assert.deepEqual(check('commandHostEnvironment();', file), [], file);
    assert.equal(check('process.env;', file).length, 1, file);
  }
});

test('renamed and namespace command-host calls cannot bypass the boundary', () => {
  assert.equal(
    check(
      "import { commandHostEnvironment as host } from '@agent-device/host-kit/command'; host();",
    ).length,
    1,
  );
  assert.equal(check('commands.commandHostEnvironment();').length, 1);
});

test('test support and scripts are outside the production rule', () => {
  for (const file of [
    'src/example.test.ts',
    'packages/test-kit/src/example.ts',
    'src/example.fixtures.ts',
    'packages/maestro/test/example.ts',
    'scripts/example.ts',
  ]) {
    assert.deepEqual(check('process.env; commandHostEnvironment();', file), [], file);
  }
  assert.equal(check('process.env;', 'packages/example/src/module.ts').length, 1);
});

test('comments, strings and explicit host values are not process reads', () => {
  assert.deepEqual(check('// process.env\nconst text = "process.cwd()"; host.env; host.cwd;'), []);
});

test('bare process values are captures in calls, aliases, spreads, returns and computed access', () => {
  for (const source of [
    'captureHostEnvironment(process);',
    'const p = process; p.env;',
    'someFn(process);',
    'const p = { ...process };',
    'function capture() { return process; }',
    'process[member];',
    'captureHostEnvironment(globalThis.process);',
    "import p from 'node:process'; someFn(p);",
    "import { default as p } from 'node:process'; captureHostEnvironment(p);",
    'const { process: p } = globalThis; p.env;',
    'let p; ({process: p} = globalThis); captureHostEnvironment(p);',
    "import * as p from 'node:process'; captureHostEnvironment(p.default);",
  ]) {
    assert.equal(check(source).length, 1, source);
    assert.deepEqual(check(source, 'src/sdk/host.ts'), [], source);
  }
});

test('SDK adapters capture their default host only through the shared entry', () => {
  for (const file of [
    'src/sdk/android-adb.ts',
    'src/sdk/artifacts.ts',
    'src/sdk/metro.ts',
    'src/sdk/remote-config.ts',
    'src/provider-limrun-runtime.ts',
  ]) {
    assert.equal(check('captureHostEnvironment(process);', file).length, 1, file);
  }
});

test('non-configuration process members and unrelated property names remain permitted', () => {
  assert.deepEqual(
    check(
      'process.platform; process.pid; process.stdout; object.process; const object = { process: true };',
    ),
    [],
  );
  for (const file of [
    'packages/platform-apple/src/os/macos/helper.ts',
    'packages/platform-apple/src/runner/runner-process-launch.ts',
  ]) {
    assert.equal(check('captureHostEnvironment(process);', file).length, 1, file);
  }
});

test('local process bindings do not hide captures in other lexical scopes', () => {
  assert.deepEqual(
    check("import * as p from 'node:process'; function read(p) { return p.default; }"),
    [],
  );
  assert.deepEqual(
    check('function read(process) { return process; } const object = { process: 1 };'),
    [],
  );
  assert.equal(
    check('function read(process) { return process; } captureHostEnvironment(process);').length,
    1,
  );
  assert.equal(
    check('function read() { const process = child; return process; } const p = process;').length,
    1,
  );
  assert.deepEqual(
    check('type Record = { process: Child }; const child: typeof process = value;'),
    [],
  );
});
