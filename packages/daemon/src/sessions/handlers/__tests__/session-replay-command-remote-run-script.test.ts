import { platformRequestScopeFixture } from '../../../__tests__/support/unavailable-device-runtime-gateway.ts';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { ReplayScriptSourceBundle } from '@agent-device/contracts/replay';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { SessionStore } from '../../../core/session-store.ts';
import { LeaseRegistry } from '../../../resources/lease-registry.ts';
import { handleReplayCommand } from '../session-replay-command.ts';
import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';
import { fakeCreateCommandSurface } from '../../../__tests__/support/command-surface-fake.ts';

function scriptFixture() {
  const root = mkdtempForTestSync('agent-device-maestro-script-trust-');
  const bundleRoot = path.join(root, 'bundle');
  fs.mkdirSync(bundleRoot);
  const hostScript = path.join(root, 'host.js');
  fs.writeFileSync(hostScript, 'output.result = "host-script-canary"');
  fs.symlinkSync(hostScript, path.join(bundleRoot, 'escape.js'));
  const entry = path.join(bundleRoot, 'flow.yaml');
  return { root, entry, hostScript, bundleRoot };
}

async function replayBundle(root: string, bundle: ReplayScriptSourceBundle, remote = true) {
  const host = createTestHostEnvironment({ cwd: root, env: {} });
  const invoke = vi.fn(async () => ({ ok: true as const, data: {} }));
  const response = await handleReplayCommand({
    requestScope: platformRequestScopeFixture(),
    host,
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 'test-token',
      session: 'default',
      command: 'replay',
      positionals: [bundle.entry],
      flags: { platform: 'ios', replayBackend: 'maestro', replayScriptSource: bundle },
      ...(remote ? { internal: { publicNetworkOnly: true } } : {}),
      meta: { cwd: root },
    },
    sessionName: 'default',
    logPath: path.join(root, 'daemon.log'),
    sessionStore: new SessionStore(path.join(root, 'sessions'), host),
    invoke,
    leaseRegistry: new LeaseRegistry(),
    reconcileOrphanedDeviceClaim: async () => ({ status: 'retained', reason: 'test' }),
  });
  return { response, invoke };
}

test.each(['absolute', 'traversal', 'symlink', 'bundled', 'malformed', 'missing'] as const)(
  'remote replay refuses a %s runScript path before reading host files',
  async (kind) => {
    const { root, entry, hostScript, bundleRoot } = scriptFixture();
    const malformed = path.join(root, 'malformed.js');
    fs.writeFileSync(malformed, 'confidential-host-file-canary is not JavaScript');
    const files: Record<string, string> = {};
    const file = {
      absolute: hostScript,
      traversal: '../host.js',
      symlink: 'escape.js',
      bundled: 'setup.js',
      malformed,
      missing: path.join(root, 'missing.js'),
    }[kind];
    if (kind === 'bundled') {
      files[path.join(bundleRoot, file)] = 'output.result = "bundled-script-canary"';
    }
    files[entry] = `appId: demo.app\n---\n- runScript: ${JSON.stringify(file)}\n- inputText: never`;
    const target = path.resolve(bundleRoot, file);
    const read = vi.spyOn(fs, 'readFileSync');
    try {
      const { response, invoke } = await replayBundle(root, { entry, files });
      const readTarget = read.mock.calls.some(([filename]) => filename === target);

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'REPLAY_DIVERGENCE',
          details: { divergence: { cause: { code: 'UNAUTHORIZED' } } },
        },
      });
      expect(readTarget).toBe(false);
      expect(invoke).not.toHaveBeenCalled();
      expect(JSON.stringify(response)).not.toContain('confidential-host-file-canary');
      expect(JSON.stringify(response)).not.toContain('ENOENT');
    } finally {
      read.mockRestore();
    }
  },
);

test.each(['include', 'repeat-retry', 'onFlowStart', 'onFlowComplete'] as const)(
  'remote replay retains script distrust through %s',
  async (route) => {
    const { root, entry, hostScript, bundleRoot } = scriptFixture();
    const script = `runScript: ${JSON.stringify(hostScript)}`;
    const files: Record<string, string> = {};
    if (route === 'include') {
      files[entry] = 'appId: demo.app\n---\n- runFlow: child.yaml';
      files[path.join(bundleRoot, 'child.yaml')] = `---\n- ${script}`;
    } else if (route === 'repeat-retry') {
      files[entry] = [
        'appId: demo.app',
        '---',
        '- repeat:',
        '    times: 1',
        '    commands:',
        '      - retry:',
        '          maxRetries: 1',
        '          commands:',
        `            - ${script}`,
      ].join('\n');
    } else {
      files[entry] = `appId: demo.app\n${route}:\n  - ${script}\n---\n- assertTrue: true`;
    }
    const read = vi.spyOn(fs, 'readFileSync');
    try {
      const { response, invoke } = await replayBundle(root, { entry, files });

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'REPLAY_DIVERGENCE',
          details: { divergence: { cause: { code: 'UNAUTHORIZED' } } },
        },
      });
      expect(read.mock.calls.some(([filename]) => filename === hostScript)).toBe(false);
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  },
);

test.each(['absolute', 'traversal', 'symlink'] as const)(
  'trusted local replay retains %s host-script access',
  async (kind) => {
    const { root, entry, hostScript } = scriptFixture();
    const file = { absolute: hostScript, traversal: '../host.js', symlink: 'escape.js' }[kind];
    const { response } = await replayBundle(
      root,
      {
        entry,
        files: {
          [entry]: `appId: demo.app\n---\n- runScript: ${JSON.stringify(file)}\n- assertTrue: \${output.result}`,
        },
      },
      false,
    );

    expect(response).toMatchObject({ ok: true, data: { replayed: 2 } });
  },
);
