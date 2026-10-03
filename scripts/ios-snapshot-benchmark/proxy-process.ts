import { spawn } from 'node:child_process';
import { BenchmarkInfrastructureError, stopDaemon } from './lifecycle.ts';
import { findProxyStartup, type ProxyStartup } from './proxy-startup.ts';

export type ProxyProcess = ProxyStartup & { stop(): Promise<void> };

export async function startProxy(repoRoot: string, stateDir: string): Promise<ProxyProcess> {
  const token = `bench-${process.pid}-${Date.now()}`;
  const child = spawn(
    process.execPath,
    [
      'bin/agent-device.mjs',
      'proxy',
      '--state-dir',
      stateDir,
      '--daemon-auth-token',
      token,
      '--json',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  try {
    const startup = await readProxyStartup(child, () => stderr);
    let stopPromise: Promise<void> | undefined;
    return {
      ...startup,
      stop: () => (stopPromise ??= stopProxyProcess(child, repoRoot, stateDir)),
    };
  } catch (error) {
    await terminateChild(child);
    throw error;
  }
}

function readProxyStartup(
  child: ReturnType<typeof spawn>,
  getStderr: () => string,
): Promise<ProxyStartup> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      reject(
        new BenchmarkInfrastructureError(
          `Proxy did not publish startup metadata: ${getStderr().trim() || output.trim()}`,
          'agent-device proxy --json',
        ),
      );
      child.kill('SIGTERM');
    }, 60_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const startup = findProxyStartup(output);
      if (!startup) return;
      clearTimeout(timer);
      resolve(startup);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (isCleanExit(code, signal)) return;
      clearTimeout(timer);
      reject(
        new BenchmarkInfrastructureError(
          `Proxy exited before startup: ${getStderr().trim() || `exit ${String(code)}`}`,
          'agent-device proxy --json',
        ),
      );
    });
  });
}

async function stopProxyProcess(
  child: ReturnType<typeof spawn>,
  repoRoot: string,
  stateDir: string,
): Promise<void> {
  await terminateChild(child);
  stopDaemon(repoRoot, stateDir);
}

async function terminateChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode === null) child.kill('SIGTERM');
  await waitForExit(child);
}

function isCleanExit(code: number | null, signal: NodeJS.Signals | null): boolean {
  return code === 0 && signal === null;
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 10_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
