import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_AGENT_BROWSER_VERSION = '0.27.1';

type FakeManagedAgentBrowserInstall = ReturnType<typeof expectedManagedAgentBrowserInstall>;

export function installFakeManagedAgentBrowser(stateDir: string): FakeManagedAgentBrowserInstall {
  const install = expectedManagedAgentBrowserInstall(stateDir);
  fs.mkdirSync(path.dirname(install.binaryPath), { recursive: true });
  fs.writeFileSync(install.binaryPath, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(install.binaryPath, 0o755);
  fs.writeFileSync(path.join(install.installDir, 'manifest.json'), '{}');
  return install;
}

function expectedManagedAgentBrowserInstall(stateDir: string) {
  const installDir = path.join(stateDir, 'tools', 'agent-browser', TEST_AGENT_BROWSER_VERSION);
  return {
    version: TEST_AGENT_BROWSER_VERSION,
    installDir,
    binaryPath: path.join(
      installDir,
      'package',
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'agent-browser.cmd' : 'agent-browser',
    ),
    homeDir: path.join(installDir, 'home'),
    runtimeHomeDir:
      process.platform === 'win32'
        ? path.join(installDir, 'home')
        : path.join(os.tmpdir(), 'agent-device-web', sha1Short(installDir)),
  };
}

function sha1Short(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 12);
}
