import { promises as fs } from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';

export type MockRunCmdResult = Awaited<ReturnType<typeof runCmd>>;
export type HostCommandHandler = (
  cmd: string,
  args: readonly string[],
  options: Parameters<typeof runCmd>[2],
) => Promise<MockRunCmdResult | null>;

/** Routes every `runCmd` call through `handlers` in order; the first non-null result wins. */
export function mockHostCommands(handlers: HostCommandHandler[]): void {
  vi.mocked(runCmd).mockImplementation(async (cmd, args, options) => {
    for (const handler of handlers) {
      const result = await handler(cmd, args, options);
      if (result) return result;
    }
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  });
}

/** Writes `Example.app/Contents/Info.plist` under `tmpDir` and returns the bundle path. */
export async function writeMacosAppBundle(tmpDir: string, executable: string): Promise<string> {
  const bundlePath = path.join(tmpDir, 'Example.app');
  await fs.mkdir(path.join(bundlePath, 'Contents'), { recursive: true });
  await fs.writeFile(
    path.join(bundlePath, 'Contents', 'Info.plist'),
    infoPlistXml(executable),
    'utf8',
  );
  return bundlePath;
}

/** Writes a flat `Example.app/Info.plist` under `tmpDir` and returns the app path. */
export async function writeIosSimulatorApp(tmpDir: string, executable: string): Promise<string> {
  const appPath = path.join(tmpDir, 'Example.app');
  await fs.mkdir(appPath, { recursive: true });
  await fs.writeFile(path.join(appPath, 'Info.plist'), infoPlistXml(executable), 'utf8');
  return appPath;
}

/** `mdfind` locates the bundle; `plutil` fails so the executable is read from Info.plist. */
export function macosBundleLookup(bundlePath: string): HostCommandHandler {
  return async (cmd) => {
    if (cmd === 'mdfind') return { stdout: `${bundlePath}\n`, stderr: '', exitCode: 0 };
    if (cmd === 'plutil') return plutilFallback();
    return null;
  };
}

/** `simctl get_app_container` locates the app; `plutil` fails like `macosBundleLookup`. */
export function iosSimulatorAppContainer(appPath: string): HostCommandHandler {
  return async (cmd, args) => {
    if (cmd === 'xcrun' && args.includes('get_app_container')) {
      return { stdout: `${appPath}\n`, stderr: '', exitCode: 0 };
    }
    if (cmd === 'plutil') return plutilFallback();
    return null;
  };
}

export function hostPs(rows: string[]): HostCommandHandler {
  return async (cmd) => (cmd === 'ps' ? psOutput(rows) : null);
}

export function simulatorPs(rows: string[]): HostCommandHandler {
  return async (cmd, args) => (isSimulatorPs(cmd, args) ? psOutput(rows) : null);
}

export function simulatorPsUnavailable(): HostCommandHandler {
  return async (cmd, args) =>
    isSimulatorPs(cmd, args)
      ? { stdout: '', stderr: 'No such file or directory', exitCode: 2 }
      : null;
}

export function isSimulatorPs(cmd: string, args: readonly string[]): boolean {
  return cmd === 'xcrun' && args.includes('spawn') && args.includes('ps');
}

function infoPlistXml(executable: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    `<key>CFBundleExecutable</key><string>${executable}</string>`,
    '</dict></plist>',
  ].join('');
}

function plutilFallback(): MockRunCmdResult {
  return { stdout: '', stderr: 'mock fallback', exitCode: 1 };
}

function psOutput(rows: string[]): MockRunCmdResult {
  return { stdout: rows.join('\n'), stderr: '', exitCode: 0 };
}
