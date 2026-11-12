import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  daemonFixtureLaunchViolations,
  scanDaemonFixtureLaunches,
} from '../lib/daemon-fixture-launch-guard.ts';

const imports = `import { runCmdDetachedMonitored as launch } from '@agent-device/host-kit/command';
import { planRegisteredDaemonLaunches as plan, spawnRegisteredDaemonFixture } from './registered-daemon-fixture.ts';
const spawn = vi.mocked(launch);`;

for (const body of [
  `spawn.mockImplementation(() => { const child = spawnRegisteredDaemonFixture(); throw new Error('refused'); });`,
  `spawn['mockImplementationOnce'](() => { const child = spawnRegisteredDaemonFixture(); return { pid: 999, exited: child.exited }; });`,
  `const alias = spawn; alias.mockReturnValue({ pid: 123 });`,
  `vi.mocked(launch).mockImplementation(() => spawnRegisteredDaemonFixture());`,
  `vi.spyOn(command, 'runCmdDetachedMonitored').mockImplementation(() => spawnRegisteredDaemonFixture());`,
  `command.runCmdDetachedMonitored('node', []);`,
  `spawn[method](() => spawnRegisteredDaemonFixture());`,
  `const { mockImplementation: install } = spawn; install(() => spawnRegisteredDaemonFixture());`,
  `vi.mock('@agent-device/host-kit/command', () => ({ runCmdDetachedMonitored: vi.fn(() => { const child = spawnRegisteredDaemonFixture(); return { pid: 123, exited: child.exited }; }) }));`,
]) {
  test(`rejects a raw daemon launcher: ${body}`, () => {
    assert.equal(daemonFixtureLaunchViolations(imports + body, 'fixture.test.ts').length, 1);
  });
}

test('accepts the shared plan, including an imported alias', () => {
  assert.deepEqual(
    daemonFixtureLaunchViolations(
      imports + `spawn.mockImplementation(plan([{ kind: 'refuse', error: new Error('no') }]));`,
      'fixture.test.ts',
    ),
    [],
  );
});

test('namespace-created fixture families remain guarded', () => {
  const violations = scanDaemonFixtureLaunches([
    {
      file: 'src/support.ts',
      source: `import * as testKit from '@agent-device/test-kit'; export const fixtures = testKit.createRegisteredDaemonFixtures({});`,
    },
    {
      file: 'src/consumer.test.ts',
      source: `import { fixtures } from './support.ts'; import { runCmdDetachedMonitored } from '@agent-device/host-kit/command'; const launch = vi.mocked(runCmdDetachedMonitored); launch.mockImplementation(() => fixtures.spawnRegisteredDaemonFixture());`,
    },
  ]);
  assert.equal(violations.length, 1);
});

test('does not restrict unrelated sleep mocks or ordinary command tests outside the family', () => {
  assert.deepEqual(
    daemonFixtureLaunchViolations(
      imports + `pause.mockImplementation(() => {});`,
      'fixture.test.ts',
    ),
    [],
  );
});

test('a typed launcher parameter cannot bypass the plan', () => {
  assert.equal(
    daemonFixtureLaunchViolations(
      imports +
        `function install(other: Mock<typeof launch>) { other.mockImplementation(() => spawnRegisteredDaemonFixture()); }`,
      'fixture.ts',
    ).length,
    1,
  );
});

test('the repo scan follows renamed and re-exported fixture helpers but leaves other command tests alone', () => {
  const bad = `import { runCmdDetachedMonitored } from '@agent-device/host-kit/command'; const spawn = vi.mocked(runCmdDetachedMonitored); spawn.mockImplementation(() => { throw new Error('raw'); });`;
  const violations = scanDaemonFixtureLaunches([
    {
      file: 'src/support/renamed.ts',
      source: `import { createRegisteredDaemonFixtures as create } from '@agent-device/test-kit'; export const fixtures = create({});`,
    },
    { file: 'src/support/barrel.ts', source: `export * from './renamed.ts';` },
    {
      file: 'src/consumer.test.ts',
      source: `import { fixtures } from './support/barrel.ts'; ${bad}`,
    },
    { file: 'src/unrelated.test.ts', source: bad },
  ]);
  assert.equal(violations.length, 1);
  assert.match(violations[0]!, /src\/consumer.test.ts/);
});

for (const specifier of ['..', '.']) {
  test(`the repo scan follows a fixture family imported through a bare '${specifier}'`, () => {
    const bad = `import { runCmdDetachedMonitored } from '@agent-device/host-kit/command'; const spawn = vi.mocked(runCmdDetachedMonitored); spawn.mockImplementation(() => { throw new Error('raw'); });`;
    const consumer =
      specifier === '..' ? 'src/support/nested/consumer.test.ts' : 'src/support/consumer.test.ts';
    const violations = scanDaemonFixtureLaunches([
      {
        file: 'src/support/index.ts',
        source: `import { createRegisteredDaemonFixtures } from '@agent-device/test-kit'; export const fixtures = createRegisteredDaemonFixtures({});`,
      },
      { file: consumer, source: `import { fixtures } from '${specifier}'; ${bad}` },
    ]);
    assert.equal(violations.length, 1);
    assert.ok(violations[0]!.includes(consumer));
  });
}

for (const expression of [
  '(spawn as any)',
  'spawn!',
  '(spawn satisfies unknown)',
  '(<any>spawn)',
  'vi.mocked(launch as any)',
]) {
  test(`rejects a wrapped launcher: ${expression}`, () => {
    assert.equal(
      daemonFixtureLaunchViolations(
        imports + `${expression}.mockImplementation(() => spawnRegisteredDaemonFixture());`,
        'fixture.test.ts',
      ).length,
      1,
    );
  });
}

for (const annotation of ['MockedFunction', 'MockInstance']) {
  test(`rejects a launcher parameter typed as ${annotation}`, () => {
    assert.equal(
      daemonFixtureLaunchViolations(
        imports +
          `function install(other: ${annotation}<typeof launch>) { other.mockImplementation(() => spawnRegisteredDaemonFixture()); }`,
        'fixture.ts',
      ).length,
      1,
    );
  });
}

for (const binding of ['runCmdDetachedMonitored', 'runCmdDetachedMonitored: detached']) {
  test(`rejects a launcher destructured from a namespace: ${binding}`, () => {
    const local = binding.includes(':') ? 'detached' : 'runCmdDetachedMonitored';
    const violations = daemonFixtureLaunchViolations(
      `import * as command from '@agent-device/host-kit/command'; const { ${binding} } = command; ${local}.mockImplementation(() => ({}));`,
      'fixture.ts',
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0]!, /mocked daemon launch must use/);
  });
}

test('accepts a shared launch plan held in a local binding', () => {
  assert.deepEqual(
    daemonFixtureLaunchViolations(
      imports +
        `const next = plan([{kind: 'refuse', error: new Error('no')}]); const alias = next; spawn.mockImplementation(alias);`,
      'fixture.ts',
    ),
    [],
  );
});

for (const specifier of ['./support', './support/index.js', './support/renamed.js']) {
  test(`follows a fixture family through ${specifier}`, () => {
    const violations = scanDaemonFixtureLaunches([
      {
        file: 'src/support/renamed.ts',
        source: `import {createRegisteredDaemonFixtures} from '@agent-device/test-kit'; export const fixtures = createRegisteredDaemonFixtures({});`,
      },
      { file: 'src/support/index.ts', source: `export * from './renamed.js';` },
      {
        file: 'src/consumer.test.ts',
        source: `import {fixtures} from '${specifier}'; import {runCmdDetachedMonitored} from '@agent-device/host-kit/command'; vi.mocked(runCmdDetachedMonitored).mockImplementation(() => fixtures.spawnRegisteredDaemonFixture());`,
      },
    ]);
    assert.equal(violations.length, 1);
    assert.match(violations[0]!, /src\/consumer.test.ts/);
  });
}

test('accepts a namespace-destructured launcher using the shared plan', () => {
  assert.deepEqual(
    daemonFixtureLaunchViolations(
      imports +
        `import * as command from '@agent-device/host-kit/command'; const { runCmdDetachedMonitored: detached } = command; vi.mocked(detached).mockImplementation(plan([]));`,
      'fixture.ts',
    ),
    [],
  );
});
