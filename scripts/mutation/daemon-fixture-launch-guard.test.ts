import assert from 'node:assert/strict';
import { test } from 'node:test';
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
