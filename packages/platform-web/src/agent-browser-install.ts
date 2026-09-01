import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { runCmd } from '@agent-device/host-kit/command';
import {
  ensureHostDirectorySync,
  hostFileStatSync,
  writeHostTextFileSync,
} from '@agent-device/host-kit/host-file';
import {
  hostEnvironment,
  hostNodeExecutablePath,
  hostNodeVersion,
  hostPlatform,
} from '@agent-device/host-kit/process';

/**
 * How the managed backend gets onto disk. Kept apart from the tool module,
 * which owns locating and running what this leaves behind.
 */
export async function installManagedAgentBrowserPackage(params: {
  packageRoot: string;
  packageSpec: string;
  timeoutMs: number;
}): Promise<void> {
  ensureHostDirectorySync(params.packageRoot);
  // `--no-global` keeps an ambient `npm_config_global` from redirecting the
  // install out of the managed prefix, where the backend entry would be missed.
  const npm = npmCommand([
    'install',
    '--prefix',
    params.packageRoot,
    '--no-global',
    '--no-audit',
    '--no-fund',
    '--no-save',
    params.packageSpec,
  ]);
  await runCmd(npm.command, npm.args, { env: hostEnvironment(), timeoutMs: params.timeoutMs });
}

export function writeManagedAgentBrowserManifest(params: {
  installDir: string;
  packageName: string;
  version: string;
}): void {
  writeHostTextFileSync(
    path.join(params.installDir, 'manifest.json'),
    JSON.stringify(
      {
        package: params.packageName,
        version: params.version,
        node: hostNodeVersion(),
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

/**
 * POSIX spawns `npm` from PATH exactly as it always has. Only Windows is
 * broken: npm ships as `npm.cmd` there, which `child_process.spawn` refuses
 * without a shell since the CVE-2024-27980 fix, so its JS entry runs under the
 * current Node runtime instead (#2022).
 */
function npmCommand(args: string[]): { command: string; args: string[] } {
  if (hostPlatform() !== 'win32') return { command: 'npm', args };
  const npmCliScript = resolveWindowsNpmCliScript(hostEnvironment());
  if (!npmCliScript) {
    throw new AppError('TOOL_MISSING', 'npm not found in PATH', {
      nodeExecPath: hostNodeExecutablePath(),
      hint: 'Install Node.js with npm, or add npm to PATH, and run `agent-device web setup` again.',
    });
  }
  return { command: hostNodeExecutablePath(), args: [npmCliScript, ...args] };
}

function resolveWindowsNpmCliScript(env: NodeJS.ProcessEnv): string | undefined {
  const advertised = env.npm_execpath?.trim();
  if (advertised) {
    const scriptPath = path.resolve(advertised);
    // pnpm and yarn advertise their own launcher through the same variable.
    if (path.basename(scriptPath) === 'npm-cli.js' && isFile(scriptPath)) return scriptPath;
  }
  const bundled = path.join(
    path.dirname(hostNodeExecutablePath()),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
  return isFile(bundled) ? bundled : undefined;
}

function isFile(filePath: string): boolean {
  try {
    return hostFileStatSync(filePath).isFile();
  } catch {
    return false;
  }
}
