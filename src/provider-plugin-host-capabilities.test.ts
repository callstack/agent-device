import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import {
  androidAdbHostTarget,
  androidAdbInvocation,
  androidAdbSerialTarget,
  serializeAndroidAdbInvocation,
  withAndroidHostAdbTransport,
} from '@agent-device/platform-android/mechanics';
import { withCommandHost } from '@agent-device/host-kit/command';
import type { ProviderHostCapabilities } from '@agent-device/plugins/host';
import { createProviderHostCapabilities } from './provider-plugin-host-capabilities.ts';
import { deviceShellArgv } from '@agent-device/kernel/device-shell';

describe('provider host capabilities', () => {
  test('the android facet answers from its supplied host, never the ambient one', async () => {
    const root = mkdtempForTestSync('provider-host-capabilities-');
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    const adb = path.join(bin, 'adb');
    writeFileSync(
      adb,
      `#!${process.execPath}\n` +
        `process.stdout.write(JSON.stringify({args:process.argv.slice(2),owner:process.env.CAPABILITY_OWNER}));\n`,
    );
    chmodSync(adb, 0o755);
    const capabilities = await createProviderHostCapabilities({
      env: { ...process.env, PATH: bin, CAPABILITY_OWNER: 'supplied' },
      cwd: root,
    });
    const android = capabilities.android!;
    const invocation = androidAdbInvocation(androidAdbHostTarget(), ['devices']);
    const previous = { PATH: process.env.PATH, CAPABILITY_OWNER: process.env.CAPABILITY_OWNER };
    process.env.PATH = '/usr/bin:/bin';
    process.env.CAPABILITY_OWNER = 'ambient';
    try {
      const standalone = await android.runAdb(invocation, { allowFailure: true });
      const scoped = await withCommandHost(
        {
          host: { env: { ...process.env, PATH: bin, CAPABILITY_OWNER: 'foreign' }, cwd: root },
          requestEnv: { CAPABILITY_OWNER: 'foreign-request' },
        },
        () => android.runAdb(invocation, { allowFailure: true }),
      );
      for (const result of [standalone, scoped]) {
        assert.equal(result.exitCode, 0);
        assert.deepEqual(JSON.parse(result.stdout), { args: ['devices'], owner: 'supplied' });
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('runAdb keeps host-target and serial-target addressing apart on the transport', async () => {
    const { android } = await createProviderHostCapabilities({
      env: process.env,
      cwd: process.cwd(),
    });
    const seen: string[][] = [];
    await withAndroidHostAdbTransport(
      async (invocation) => {
        seen.push([...serializeAndroidAdbInvocation(invocation)]);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async () => {
        await android!.runAdb(androidAdbInvocation(androidAdbHostTarget(), ['kill-server']));
        await android!.runAdb(
          androidAdbInvocation(androidAdbSerialTarget('emulator-5554'), ['disconnect', 'x']),
        );
      },
    );
    expect(seen).toEqual([['kill-server'], ['-s', 'emulator-5554', 'disconnect', 'x']]);
  });

  test('adbError names the invocation through the platform serializer', async () => {
    const { android } = await createProviderHostCapabilities({
      env: process.env,
      cwd: process.cwd(),
    });
    const failure = await android!.adbError(
      'command failed',
      { exitCode: 1, stdout: '', stderr: 'device offline' },
      androidAdbInvocation(androidAdbSerialTarget('127.0.0.1:62001'), ['reverse', 'tcp:8081']),
    );
    expect(failure.details?.command).toBe('adb -s 127.0.0.1:62001 reverse tcp:8081');
    const addressless = await android!.adbError('command failed', {
      exitCode: 1,
      stdout: '',
      stderr: 'no device',
    });
    expect(addressless.details?.command).toBeUndefined();
  });

  test('runShell quotes each word for the device shell and forwards the executor', async () => {
    const { android } = await createProviderHostCapabilities({
      env: process.env,
      cwd: process.cwd(),
    });
    const seen: Array<readonly string[]> = [];
    const result = await android!.runShell(
      async (args) => {
        seen.push(args);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      ['am', 'force-stop', 'com.example.app'],
      { allowFailure: true },
    );
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual([
      deviceShellArgv('adb', 'shell', ['am', 'force-stop', 'com.example.app']),
    ]);
  });

  test('createInteractor answers synchronously with an interactor bound to its executor', async () => {
    const { android } = await createProviderHostCapabilities({
      env: process.env,
      cwd: process.cwd(),
    });
    const serialSeen: string[][] = [];
    const adb = async (args: readonly string[]) => {
      serialSeen.push([...args]);
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const device = {
      platform: 'android' as const,
      id: 'capability-interactor-serial',
      name: 'Capability Pixel',
      kind: 'emulator' as const,
      target: 'mobile' as const,
      booted: true,
    };
    // The caller that needs this value cannot await it, so the facet must hand over the interactor
    // itself and not a promise for one.
    const interactor = android!.createInteractor(device, adb);
    expect(interactor).not.toBeInstanceOf(Promise);
    expect(Object.keys(interactor).length).toBeGreaterThan(0);
    // The provider scope is the facet's own installation, not the caller's: the command the
    // interactor runs arrives at the executor the caller handed the facet.
    await interactor.keyboardStatus!();
    expect(serialSeen).toEqual([
      Array.from(deviceShellArgv('adb', 'shell', ['dumpsys', 'input_method'])),
    ]);
  });

  test('createInteractor keeps every interactor command on the host it was built for', async () => {
    const root = mkdtempForTestSync('provider-interactor-capabilities-');
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    // A provider's executor is provider code, and it may reach for a tool of its own. The facet
    // wraps every command the interactor runs in its host's command scope, so that tool resolves
    // from the host the facet was built for — never the ambient process, nor an enclosing request.
    const evidence = path.join(root, 'commands.jsonl');
    writeFileSync(
      path.join(bin, 'provider-route'),
      `#!${process.execPath}\n` +
        `import { appendFileSync } from 'node:fs';\n` +
        `appendFileSync(process.env.CAPABILITY_EVIDENCE, JSON.stringify({args:process.argv.slice(2),owner:process.env.CAPABILITY_OWNER}) + '\\n');\n`,
    );
    chmodSync(path.join(bin, 'provider-route'), 0o755);
    const hostFor = (owner: string) => ({
      env: { ...process.env, PATH: bin, CAPABILITY_OWNER: owner, CAPABILITY_EVIDENCE: evidence },
      cwd: root,
    });
    const { android } = await createProviderHostCapabilities(hostFor('supplied'));
    const device = {
      platform: 'android' as const,
      id: 'capability-scoped-serial',
      name: 'Capability Pixel',
      kind: 'emulator' as const,
      target: 'mobile' as const,
      booted: true,
    };
    const interactor = android!.createInteractor(device, {
      exec: async (args, options) => {
        const { runCmd } = await import('@agent-device/host-kit/command');
        // The provider's own route is an ordinary command: it resolves its tool, and therefore this
        // host, the way every other command the facet serves does.
        const result = await runCmd('provider-route', [...args], {
          allowFailure: true,
          signal: options?.signal,
        });
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      },
    });
    // Every observed command, in arrival order, with the environment it was given.
    const observed = () =>
      readFileSync(evidence, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as { args: string[]; owner: string });
    const previous = { PATH: process.env.PATH, CAPABILITY_OWNER: process.env.CAPABILITY_OWNER };
    process.env.PATH = '/usr/bin:/bin';
    process.env.CAPABILITY_OWNER = 'ambient';
    try {
      await interactor.keyboardStatus!();
      const standalone = observed();
      await withCommandHost(
        { host: hostFor('foreign'), requestEnv: { CAPABILITY_OWNER: 'foreign-request' } },
        async () => {
          await interactor.keyboardStatus!();
        },
      );
      expect(standalone.map((entry) => entry.owner)).toEqual(['supplied']);
      expect(
        observed()
          .slice(standalone.length)
          .map((entry) => entry.owner),
      ).toEqual(['supplied']);
      expect(observed()[0]?.args).toEqual(
        Array.from(deviceShellArgv('adb', 'shell', ['dumpsys', 'input_method'])),
      );
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('the apple facet carries the root-composed application tools', async () => {
    const capabilities = await createProviderHostCapabilities({ env: {}, cwd: '/' });
    expect(capabilities.apple?.applicationTools.resolveOpenTarget).toBeTypeOf('function');
  });

  test('the apple facet exposes no daemon-wide Apple shutdown member', async () => {
    const { apple } = await createProviderHostCapabilities({ env: {}, cwd: '/' });
    const tools = apple!.applicationTools;
    // The facet's runtime value is the projection, not the full port wearing a narrower type: the
    // members that hand off or stop every runner session this process holds are absent as keys.
    expect(Object.keys(tools).sort()).toEqual(
      [
        'applyRuntimeHints',
        'clearRuntimeHints',
        'dismissCloseAlerts',
        'hasLiveRunnerSession',
        'notifyRunnerAppRelaunched',
        'prepareRunner',
        'prewarmRunnerCache',
        'prewarmRunnerSession',
        'releaseRunnerOnClose',
        'releaseSpeculativeRunner',
        'resolveOpenTarget',
        'stopRunnerSession',
      ].sort(),
    );
    expect(Object.isFrozen(tools)).toBe(true);
    for (const privileged of [
      'detachRunnerSessionsForShutdown',
      'finalizeRunnerSessionsForShutdown',
    ])
      expect(privileged in tools).toBe(false);
    // The daemon's own durable-resource lifecycle keeps them: only the plugin-facing value is narrowed.
    const rootTools = (
      await import('./platform-runtime-apple-application-tools.ts')
    ).createAppleApplicationTools({});
    for (const member of ['detachRunnerSessionsForShutdown', 'finalizeRunnerSessionsForShutdown'])
      expect(member in rootTools).toBe(true);
  });

  test('the apple facet answers from its own host across a foreign command scope', async () => {
    const root = mkdtempForTestSync('provider-apple-capabilities-');
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    const evidence = path.join(root, 'commands.jsonl');
    // Clearing the runtime hints is the Apple command path this test can exercise without a
    // simulator, and it runs exactly one command: `xcrun simctl spawn <udid> defaults delete`, so a
    // stub tool reports one observation per call.
    writeFileSync(
      path.join(bin, 'xcrun'),
      `#!${process.execPath}\n` +
        `import { appendFileSync } from 'node:fs';\n` +
        `appendFileSync(process.env.CAPABILITY_EVIDENCE, JSON.stringify({args:process.argv.slice(2),owner:process.env.CAPABILITY_OWNER}) + '\\n');\n`,
    );
    chmodSync(path.join(bin, 'xcrun'), 0o755);
    const device = {
      platform: 'apple' as const,
      appleOs: 'ios' as const,
      id: 'capability-simulator-udid',
      name: 'Capability iPhone',
      kind: 'simulator' as const,
      target: 'mobile' as const,
      booted: true,
    };
    const hostFor = (owner: string) => ({
      env: { ...process.env, PATH: bin, CAPABILITY_OWNER: owner, CAPABILITY_EVIDENCE: evidence },
      cwd: root,
    });
    const first = await createProviderHostCapabilities(hostFor('first'));
    const second = await createProviderHostCapabilities(hostFor('second'));
    const previous = { PATH: process.env.PATH, CAPABILITY_OWNER: process.env.CAPABILITY_OWNER };
    process.env.PATH = '/usr/bin:/bin';
    process.env.CAPABILITY_OWNER = 'ambient';
    const hint = {
      appId: 'com.example.app',
      values: { metroHost: '127.0.0.1', metroPort: '8081' },
    };
    // Every observed command, in arrival order, with the environment it was given.
    const observed = () =>
      readFileSync(evidence, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as { args: string[]; owner: string });
    try {
      const toolsFor = (capabilities: ProviderHostCapabilities) =>
        capabilities.apple!.applicationTools.applyRuntimeHints(device, hint);
      await toolsFor(first);
      const standalone = await observed();
      // The write is the transport the facet chose, and it carries the host's own environment.
      assert.deepEqual(standalone, [
        {
          args: [
            'simctl',
            'spawn',
            device.id,
            'defaults',
            'write',
            hint.appId,
            'RCT_jsLocation',
            '-string',
            '127.0.0.1:8081',
          ],
          owner: 'first',
        },
        {
          args: [
            'simctl',
            'spawn',
            device.id,
            'defaults',
            'write',
            hint.appId,
            'RCT_packager_scheme',
            '-string',
            'http',
          ],
          owner: 'first',
        },
      ]);
      // A foreign request's scope is what neither facet may inherit: each keeps answering from the
      // host it was built for, and never from the enclosing scope or the process environment.
      await withCommandHost(
        { host: hostFor('foreign'), requestEnv: { CAPABILITY_OWNER: 'foreign-request' } },
        async () => {
          await Promise.all([toolsFor(first), toolsFor(second)]);
        },
      );
      const concurrent = (await observed()).slice(standalone.length);
      assert.deepEqual(concurrent.map((entry) => entry.owner).sort(), [
        'first',
        'first',
        'second',
        'second',
      ]);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
