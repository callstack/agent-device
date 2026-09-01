import { spawn } from 'node:child_process';
import { BenchmarkInfrastructureError, stopDaemon } from './lifecycle.ts';
import { asRecord, readString } from './result-values.ts';

export type ProxyStartup = {
  proxyBaseUrl: string;
  agentDeviceBaseUrl: string;
  token: string;
  stateDir: string;
};

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
      '--port',
      '0',
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

function findProxyStartup(output: string): ProxyStartup | undefined {
  for (const line of output.split('\n')) {
    const startup = parseProxyStartup(line);
    if (startup) return startup;
  }
  return undefined;
}

function parseProxyStartup(line: string): ProxyStartup | undefined {
  const record = asRecord(asRecord(parseJson(line))?.data);
  if (!record) return undefined;
  const values = ['proxyBaseUrl', 'agentDeviceBaseUrl', 'token', 'stateDir'].map((key) =>
    readString(record[key]),
  );
  if (values.some((value) => value === undefined)) return undefined;
  return {
    proxyBaseUrl: values[0]!,
    agentDeviceBaseUrl: values[1]!,
    token: values[2]!,
    stateDir: values[3]!,
  };
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

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value.trim());
  } catch {
    return undefined;
  }
}
