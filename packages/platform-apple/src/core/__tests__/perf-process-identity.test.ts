import assert from 'node:assert/strict';
import { test } from 'vitest';
import { matchesAppleExecutableProcess } from '../perf-process-identity.ts';

const executable = {
  executableName: 'Example',
  executablePath: '/Devices/selected/data/Example.app/Example',
};

test('a resolved executable path excludes the same app on another simulator', () => {
  const processes = [
    { pid: 11, command: executable.executablePath },
    { pid: 22, command: '/Devices/another/data/Example.app/Example' },
    { pid: 33, command: '/Applications/Example.app/Example' },
    { pid: 44, command: 'Example' },
  ];
  assert.deepEqual(
    processes
      .filter(({ command }) => matchesAppleExecutableProcess(command, executable))
      .map(({ pid }) => pid),
    [11],
  );
});

test('exact paths accept arguments and spaces without accepting a neighboring executable', () => {
  const target = {
    executableName: 'Example App',
    executablePath: '/Apps/Example App.app/Example App',
  };
  assert.equal(matchesAppleExecutableProcess(`${target.executablePath} --argument`, target), true);
  assert.equal(matchesAppleExecutableProcess(`${target.executablePath}-helper`, target), false);
});

test('the private var alias preserves the resolved app identity', () => {
  const target = { executableName: 'Example', executablePath: '/private/var/app/Example' };
  assert.equal(matchesAppleExecutableProcess('/var/app/Example --argument', target), true);
  assert.equal(matchesAppleExecutableProcess('/var/other/Example', target), false);
  assert.equal(
    matchesAppleExecutableProcess('/private/var/app/Example', {
      ...target,
      executablePath: '/var/app/Example',
    }),
    true,
  );
});

test('name-only matching applies when no executable path is known', () => {
  assert.equal(
    matchesAppleExecutableProcess('/Apps/Example --argument', { executableName: 'Example' }),
    true,
  );
  assert.equal(
    matchesAppleExecutableProcess('/Apps/Different', { executableName: 'Example' }),
    false,
  );
});
