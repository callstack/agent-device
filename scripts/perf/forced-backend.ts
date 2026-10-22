import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import type { AgentDeviceDaemonTransport } from '@agent-device/contracts/client';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { createRequestId } from '@agent-device/host-kit/diagnostics';
import { captureHostEnvironment } from '@agent-device/host-kit/process';
import type { SnapshotPreferredBackend } from '@agent-device/kernel/snapshot';
import { readDaemonInfo } from '../../src/daemon-client/daemon-client-metadata.ts';
import { sendRequest } from '../../src/daemon-client/daemon-client-transport.ts';
import { REPO_ROOT } from './config.ts';
import type { CliResult } from './types.ts';

type AgentDeviceSdk = typeof import('../../src/sdk/index.ts');

const FORCED_CAPTURE_TIMEOUT_MS = 90_000;

/**
 * Captures one snapshot with the internal backend pin that the CLI does not expose. The
 * transport talks to the daemon that the built CLI already started and never starts or replaces
 * it, so the measured daemon stays the daemon under test.
 */
export async function captureWithForcedBackend(options: {
  stateDir: string;
  session: string;
  udid: string;
  backend: SnapshotPreferredBackend;
}): Promise<{ result: CliResult; requestId: string }> {
  const requestId = createRequestId();
  const sdk = (await import(
    pathToFileURL(path.join(REPO_ROOT, 'dist/src/index.js')).href
  )) as AgentDeviceSdk;
  const client = sdk.createAgentDeviceClient(
    { session: options.session, stateDir: options.stateDir },
    { transport: forcedBackendTransport(options.backend, requestId) },
  );
  const t0 = performance.now();
  try {
    const snapshot = await client.capture.snapshot({
      platform: 'ios',
      udid: options.udid,
      timeoutMs: FORCED_CAPTURE_TIMEOUT_MS,
    });
    const json = { success: true, data: snapshot };
    const wallClockMs = performance.now() - t0;
    return {
      result: { exitCode: 0, wallClockMs, stdout: '', stderr: '', json, ok: true },
      requestId,
    };
  } catch (error) {
    const normalized = sdk.normalizeAgentDeviceError(error);
    const json = { success: false, error: normalized };
    const wallClockMs = performance.now() - t0;
    return {
      result: { exitCode: 1, wallClockMs, stdout: '', stderr: normalized.message, json, ok: false },
      requestId,
    };
  }
}

function forcedBackendTransport(
  backend: SnapshotPreferredBackend,
  requestId: string,
): AgentDeviceDaemonTransport {
  const host = captureHostEnvironment(process);
  return async (request, context) => {
    const stateDir = request.flags?.stateDir;
    if (request.session === undefined || typeof stateDir !== 'string') {
      throw new Error('A forced-backend capture requires an explicit session and state dir.');
    }
    const paths = resolveDaemonPaths(stateDir, { env: process.env });
    const info = readDaemonInfo(paths.infoPath);
    if (!info) throw new Error(`No daemon is running for state dir ${stateDir}.`);
    return await sendRequest(
      info,
      {
        ...request,
        session: request.session,
        token: info.token,
        flags: { ...request.flags, snapshotPreferredBackend: backend },
        meta: { ...request.meta, debug: true, requestId },
      },
      'auto',
      paths,
      FORCED_CAPTURE_TIMEOUT_MS,
      { host, signal: context?.signal, timeoutRecovery: 'none' },
    );
  };
}
