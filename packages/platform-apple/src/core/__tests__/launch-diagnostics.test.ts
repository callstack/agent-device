import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  isSimulatorLaunchFBSError,
  classifyLaunchFailure,
  launchFailureHint,
  probeSimulatorLaunchContext,
} from '../launch-diagnostics.ts';
import { AppError } from '@agent-device/kernel/errors';
import { IOS_SIMULATOR } from '../../__tests__/device-fixtures.ts';
import { withFakeAppleTool, type FakeAppleToolScript } from '../../__tests__/fake-apple-tool.ts';

test('isSimulatorLaunchFBSError identifies FBS code=4 errors', () => {
  const error = new AppError('COMMAND_FAILED', 'xcrun exited with code 4', {
    exitCode: 4,
    stderr:
      'An error was encountered processing the command (domain=FBSOpenApplicationServiceErrorDomain, code=4):\nThe request to open "com.example.app" failed.',
  });
  assert.equal(isSimulatorLaunchFBSError(error), true);
});

test('isSimulatorLaunchFBSError rejects non-AppError', () => {
  assert.equal(isSimulatorLaunchFBSError(new Error('something')), false);
});

test('isSimulatorLaunchFBSError rejects wrong error code', () => {
  const error = new AppError('INVALID_ARGS', 'bad args', {
    exitCode: 4,
    stderr: 'FBSOpenApplicationServiceErrorDomain the request to open',
  });
  assert.equal(isSimulatorLaunchFBSError(error), false);
});

test('isSimulatorLaunchFBSError rejects wrong exit code', () => {
  const error = new AppError('COMMAND_FAILED', 'xcrun exited with code 1', {
    exitCode: 1,
    stderr: 'FBSOpenApplicationServiceErrorDomain the request to open',
  });
  assert.equal(isSimulatorLaunchFBSError(error), false);
});

test('isSimulatorLaunchFBSError rejects unrelated stderr', () => {
  const error = new AppError('COMMAND_FAILED', 'xcrun exited with code 4', {
    exitCode: 4,
    stderr: 'some other error message',
  });
  assert.equal(isSimulatorLaunchFBSError(error), false);
});

test('classifyLaunchFailure returns APP_NOT_INSTALLED when not installed', () => {
  assert.equal(classifyLaunchFailure({ installed: false }), 'APP_NOT_INSTALLED');
});

test('classifyLaunchFailure returns ARCH_MISMATCH when not simulator compatible', () => {
  assert.equal(
    classifyLaunchFailure({ installed: true, simulatorCompatible: false }),
    'ARCH_MISMATCH',
  );
});

test('classifyLaunchFailure returns PERSISTENT_LAUNCH_FAIL when compatible', () => {
  assert.equal(
    classifyLaunchFailure({ installed: true, simulatorCompatible: true }),
    'PERSISTENT_LAUNCH_FAIL',
  );
});

test('classifyLaunchFailure returns PERSISTENT_LAUNCH_FAIL when compatibility unknown', () => {
  assert.equal(classifyLaunchFailure({ installed: true }), 'PERSISTENT_LAUNCH_FAIL');
});

test('launchFailureHint returns actionable string for ARCH_MISMATCH', () => {
  const hint = launchFailureHint('ARCH_MISMATCH');
  assert.ok(hint.length > 0);
  assert.ok(hint.includes('simulator'));
});

test('launchFailureHint returns actionable string for APP_NOT_INSTALLED', () => {
  const hint = launchFailureHint('APP_NOT_INSTALLED');
  assert.ok(hint.length > 0);
  assert.ok(hint.includes('install'));
});

test('launchFailureHint returns actionable string for PERSISTENT_LAUNCH_FAIL', () => {
  const hint = launchFailureHint('PERSISTENT_LAUNCH_FAIL');
  assert.ok(hint.length > 0);
  assert.ok(hint.includes('crash logs') || hint.includes('reinstalling'));
});

test('launchFailureHint returns actionable string for UNKNOWN', () => {
  const hint = launchFailureHint('UNKNOWN');
  assert.ok(hint.length > 0);
});

/**
 * `probeSimulatorLaunchContext` answers why an FBS launch refusal happened by asking three tools:
 * `simctl get_app_container` for the installed bundle, `plutil` for its executable name, and
 * `otool` for the platform marker the binary carries. Each refusal to answer narrows the diagnosis
 * one step and stops there; a probe that inferred past a missing answer is what the tiered
 * early-returns prevent, so every tier is pinned at its own boundary.
 */
test('probeSimulatorLaunchContext reports a missing container as not installed', async () => {
  const probe = await probeLaunchContext(() => ({ exitCode: 4, stderr: 'container not found' }));
  assert.deepEqual(probe, { installed: false });
});

test('probeSimulatorLaunchContext reports a successful but empty container lookup as not installed', async () => {
  const probe = await probeLaunchContext(() => '   ');
  assert.deepEqual(probe, { installed: false });
});

test('probeSimulatorLaunchContext reports installed when the Info.plist has no executable name', async () => {
  // An unreadable Info.plist proves installation but says nothing about the platform, so the
  // probe stops with `installed: true` and no compatibility claim.
  for (const plistAnswer of [{ exitCode: 1 }, { exitCode: 0, stdout: '' }]) {
    const probe = await probeLaunchContext((args) => {
      if (args[0] === 'plutil') return plistAnswer;
      return '/Bundle';
    });
    assert.deepEqual(probe, { installed: true });
  }
});

test('probeSimulatorLaunchContext reports installed when otool cannot read the binary', async () => {
  const probe = await probeLaunchContext((args) => {
    if (args[0] === 'otool') return { exitCode: 1 };
    return '/Bundle';
  });
  assert.deepEqual(probe, { installed: true });
});

test('probeSimulatorLaunchContext reads the simulator platform marker from otool', async () => {
  const probe = await probeLaunchContext(otoolScript('Platform iOSSimulator, iOS, Version 17.0'));
  assert.deepEqual(probe, { installed: true, simulatorCompatible: true });

  // LC_BUILD_VERSION spells the simulator platform both ways across toolchain versions.
  assert.deepEqual(await probeLaunchContext(otoolScript('platform 7')), {
    installed: true,
    simulatorCompatible: true,
  });
});

test('probeSimulatorLaunchContext reports a device binary as not simulator compatible', async () => {
  const probe = await probeLaunchContext(otoolScript('Platform iOS, Version 17.0'));
  assert.deepEqual(probe, { installed: true, simulatorCompatible: false });
});

test('probeSimulatorLaunchContext scopes the container lookup to the simulator', async () => {
  await withFakeAppleTool(
    () => '',
    async ({ calls }) => {
      await probeSimulatorLaunchContext(IOS_SIMULATOR, 'com.example.app');
      assert.deepEqual(calls[0], [
        'simctl',
        'get_app_container',
        IOS_SIMULATOR.id,
        'com.example.app',
      ]);
    },
    { device: IOS_SIMULATOR },
  );
});

/** A script where everything up to `otool` answers with the bundle path and `otool` answers itself. */
function otoolScript(otoolStdout: string): FakeAppleToolScript {
  return (args) => (args[0] === 'otool' ? otoolStdout : '/Path/To/Demo.app');
}

async function probeLaunchContext(script: FakeAppleToolScript) {
  return await withFakeAppleTool(
    script,
    async () => await probeSimulatorLaunchContext(IOS_SIMULATOR, 'com.example.app'),
    { device: IOS_SIMULATOR },
  );
}
