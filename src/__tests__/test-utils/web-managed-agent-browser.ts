import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_AGENT_BROWSER_VERSION = '0.27.1';

type FakeManagedAgentBrowserInstall = ReturnType<typeof expectedManagedAgentBrowserInstall>;

export function installFakeManagedAgentBrowser(stateDir: string): FakeManagedAgentBrowserInstall {
  const install = writeFakeManagedAgentBrowserPackage(stateDir);
  fs.writeFileSync(path.join(install.installDir, 'manifest.json'), '{}');
  return install;
}

export function writeFakeManagedAgentBrowserPackage(
  stateDir: string,
): FakeManagedAgentBrowserInstall {
  const install = expectedManagedAgentBrowserInstall(stateDir);
  fs.mkdirSync(path.dirname(install.entryScript), { recursive: true });
  fs.writeFileSync(install.entryScript, 'process.exit(0)\n');
  fs.mkdirSync(path.dirname(install.binaryPath), { recursive: true });
  fs.writeFileSync(install.binaryPath, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(install.binaryPath, 0o755);
  fs.writeFileSync(
    path.join(install.packageDir, 'package.json'),
    JSON.stringify({
      name: 'agent-browser',
      version: TEST_AGENT_BROWSER_VERSION,
      bin: { 'agent-browser': './dist/cli.js' },
    }),
  );
  return install;
}

export async function withNodeRuntime(
  overrides: { version?: string; platform?: NodeJS.Platform; execPath?: string },
  testFn: () => void | Promise<void>,
): Promise<void> {
  const restore: (() => void)[] = [];
  const override = (target: object, key: string, value: unknown) => {
    const original = (target as Record<string, unknown>)[key];
    Object.defineProperty(target, key, { value, configurable: true });
    restore.push(() => Object.defineProperty(target, key, { value: original, configurable: true }));
  };
  if (overrides.version !== undefined) {
    override(process.versions, 'node', overrides.version);
    override(process, 'version', `v${overrides.version}`);
  }
  if (overrides.platform !== undefined) override(process, 'platform', overrides.platform);
  if (overrides.execPath !== undefined) override(process, 'execPath', overrides.execPath);
  try {
    await testFn();
  } finally {
    for (const undo of restore.reverse()) undo();
  }
}

function expectedManagedAgentBrowserInstall(stateDir: string) {
  const installDir = path.join(stateDir, 'tools', 'agent-browser', TEST_AGENT_BROWSER_VERSION);
  const packageDir = path.join(installDir, 'package', 'node_modules', 'agent-browser');
  return {
    version: TEST_AGENT_BROWSER_VERSION,
    installDir,
    packageDir,
    binaryPath: path.join(
      installDir,
      'package',
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'agent-browser.cmd' : 'agent-browser',
    ),
    entryScript: path.join(packageDir, 'dist', 'cli.js'),
    homeDir: path.join(installDir, 'home'),
    runtimeHomeDir:
      process.platform === 'win32'
        ? path.join(installDir, 'home')
        : path.join(os.tmpdir(), 'agent-device-web', sha1Short(installDir)),
    socketDir: path.join(os.tmpdir(), 'adw', sha1Short(installDir)),
  };
}

function sha1Short(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 12);
}
