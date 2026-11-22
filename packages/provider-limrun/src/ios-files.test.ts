import { mkdtempForTest } from '@agent-device/test-kit';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { createLimrunSimulatorFiles } from './ios-files.ts';
import { limrunIosSimulator } from './app-log-runtime.fixtures.ts';

afterEach(() => vi.unstubAllGlobals());

test('invalid file list and staging JSON preserve status without a decoder cause', async () => {
  const token = 'syntheticInstanceCredential';
  vi.stubGlobal('fetch', async (_url: URL, init: RequestInit) =>
    init.method === 'DELETE'
      ? new Response(null, { status: 204 })
      : new Response(token, { status: 202 }),
  );
  const { simulatorFiles } = createLimrunSimulatorFiles(
    { apiUrl: 'https://instance.invalid/api', token } as Parameters<
      typeof createLimrunSimulatorFiles
    >[0],
    async () => ({}),
    new AbortController().signal,
  );
  const file = path.join(await mkdtempForTest('limrun-files-'), 'data.txt');
  await writeFile(file, 'data');
  for (const request of [
    () =>
      simulatorFiles.openContainer({
        device: limrunIosSimulator,
        bundleId: 'com.example.app',
        containerType: 'data',
        timeoutMs: 15_000,
      }),
    () => simulatorFiles.stageFile(file),
  ]) {
    await expect(request()).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      message: 'Limrun file operation returned invalid JSON',
      details: { status: 202, reason: 'limrun_file_response_invalid' },
      cause: undefined,
    });
  }
});
