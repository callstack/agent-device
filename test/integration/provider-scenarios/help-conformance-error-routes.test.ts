import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, vi } from 'vitest';

const { createProviderScenarioHarness } = vi.hoisted(() => ({
  createProviderScenarioHarness: vi.fn(),
}));

vi.mock('./harness.ts', () => ({ createProviderScenarioHarness }));

import { captureHelpConformanceErrorRoutes } from './help-conformance-error-routes.ts';

test('failed daemon startup restores help-conformance environment and temp directories', async () => {
  const originalTempDir = process.env.TMPDIR;
  const originalClaimsDirectory = process.env.AGENT_DEVICE_CLAIMS_DIR;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-help-route-cleanup-'));
  createProviderScenarioHarness.mockRejectedValue(new Error('forced startup failure'));

  try {
    process.env.TMPDIR = tempRoot;
    process.env.AGENT_DEVICE_CLAIMS_DIR = 'previous-claims-directory';
    await assert.rejects(captureHelpConformanceErrorRoutes(), /forced startup failure/);

    assert.equal(createProviderScenarioHarness.mock.calls.length, 1);
    assert.equal(process.env.AGENT_DEVICE_CLAIMS_DIR, 'previous-claims-directory');
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  } finally {
    if (originalTempDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTempDir;
    if (originalClaimsDirectory === undefined) delete process.env.AGENT_DEVICE_CLAIMS_DIR;
    else process.env.AGENT_DEVICE_CLAIMS_DIR = originalClaimsDirectory;
    fs.rmSync(tempRoot, { recursive: true, force: true });
    createProviderScenarioHarness.mockReset();
  }
});
