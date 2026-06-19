import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { resolveAgentBrowserTool } from './agent-browser-tool.ts';
import { installFakeManagedAgentBrowser } from './__tests__/test-utils.ts';
import { AppError } from '../../utils/errors.ts';

test('managed agent-browser tool reports actionable guidance when install is missing', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-web-tool-'));
  try {
    await assert.rejects(
      () => resolveAgentBrowserTool({ stateDir }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'TOOL_MISSING' &&
        error.details?.installDir === path.join(stateDir, 'tools', 'agent-browser', '0.27.1') &&
        error.details?.hint === expectedMissingInstallHint(),
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('managed agent-browser tool uses short runtime home for backend state', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-web-tool-'));
  try {
    const status = installFakeManagedAgentBrowser(stateDir);

    const tool = await resolveAgentBrowserTool({ stateDir });

    assert.equal(tool.command, status.binaryPath);
    assert.equal(tool.env?.HOME, status.runtimeHomeDir);
    assert.notEqual(status.runtimeHomeDir, status.homeDir);
    assert.ok(fs.existsSync(status.runtimeHomeDir));
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

function expectedMissingInstallHint(): string {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (nodeMajor < 24) {
    return `Web automation requires Node 24+; current Node is ${process.version}.`;
  }
  return 'Run `agent-device web setup` to install the managed web backend.';
}
