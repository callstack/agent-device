import { resolveLocalDaemonCodeIdentity } from '@agent-device/daemon-client';
import { startDaemonRuntime, type DaemonRuntimeController } from '@agent-device/daemon';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { mkdtempForTestSync, createTestHostEnvironment } from '@agent-device/test-kit';
import fs from 'node:fs';
import { createDaemonRuntimeDeps } from '../../daemon-composition.ts';

export type PublicDaemonRuntimeFixture = Readonly<{
  stateDir: string;
  baseUrl: string;
  runtime: DaemonRuntimeController;
  close: () => Promise<void>;
}>;

export async function startPublicDaemonRuntime(
  options: {
    env?: NodeJS.ProcessEnv;
    stateDir?: string;
    serverMode?: 'http' | 'socket' | 'dual';
  } = {},
): Promise<PublicDaemonRuntimeFixture> {
  const ownsStateDir = options.stateDir === undefined;
  const stateDir = options.stateDir ?? mkdtempForTestSync('agent-device-public-daemon-');
  const runtime = await startDaemonRuntime({
    composeDeps: createDaemonRuntimeDeps,
    host: createTestHostEnvironment({
      env: {
        ...process.env,
        ...options.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_SERVER_MODE: options.serverMode ?? 'dual',
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
      },
    }),
    stderr: { write: () => {} },
    stdout: { write: () => {} },
  });
  if (!runtime) throw new Error('The public daemon runtime did not start.');
  try {
    const paths = resolveDaemonPaths(stateDir);
    const identity = await resolveLocalDaemonCodeIdentity();
    const info = JSON.parse(fs.readFileSync(paths.infoPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(
      paths.infoPath,
      `${JSON.stringify({ ...info, codeSignature: identity.origin === 'checkout' ? identity.codeSignature : undefined })}\n`,
    );
    const port = runtime.httpPort ?? runtime.socketPort;
    if (port === undefined) {
      throw new Error('The public daemon runtime published no transport port.');
    }
    return {
      stateDir,
      baseUrl: `http://127.0.0.1:${port}`,
      runtime,
      close: async () => {
        await runtime.close();
        fs.rmSync(stateDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await runtime.close().catch(() => {});
    if (ownsStateDir) fs.rmSync(stateDir, { recursive: true, force: true });
    throw error;
  }
}
