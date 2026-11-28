import { promises as fs } from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import { runCmd, runCmdBackground } from '@agent-device/host-kit/command';

export type MockRunCmdResult = Awaited<ReturnType<typeof runCmd>>;
export type XcrunMockHandler = (args: readonly string[]) => Promise<MockRunCmdResult | null>;
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

export function mockXcrunCommands(handlers: XcrunMockHandler[]): void {
  vi.mocked(runCmd).mockImplementation(async (cmd, args) => {
    if (cmd !== 'xcrun') throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    for (const handler of handlers) {
      const result = await handler(args);
      if (result) return result;
    }
    throw new Error(`unexpected xcrun args: ${args.join(' ')}`);
  });
}

export function mockIosDeviceBundleHandlers(
  apps: Array<{ bundleIdentifier: string; name: string; url: string }>,
  runningProcesses: Array<{ executable: string; processIdentifier: number }>,
): XcrunMockHandler[] {
  return [
    async (args) => {
      if (!matchesDevicectlInfo(args, 'apps')) return null;
      await writeJsonOutput(args, { result: { apps } });
      return emptyRunResult();
    },
    async (args) => {
      if (!matchesDevicectlInfo(args, 'processes')) return null;
      await writeJsonOutput(args, { result: { runningProcesses } });
      return emptyRunResult();
    },
  ];
}

export async function mockIosDeviceApps(args: readonly string[]): Promise<MockRunCmdResult | null> {
  if (!matchesDevicectlInfo(args, 'apps')) return null;
  await writeJsonOutput(args, {
    result: {
      apps: [
        {
          bundleIdentifier: 'com.example.device',
          name: 'Example Device App',
          url: 'file:///private/var/containers/Bundle/Application/ABC123/ExampleDevice.app/',
        },
      ],
    },
  });
  return emptyRunResult();
}

export async function mockIosDeviceProcesses(
  args: readonly string[],
): Promise<MockRunCmdResult | null> {
  if (!matchesDevicectlInfo(args, 'processes')) return null;
  await writeJsonOutput(args, {
    result: {
      runningProcesses: [
        {
          executable:
            'file:///private/var/containers/Bundle/Application/ABC123/ExampleDevice.app/ExampleDeviceApp',
          processIdentifier: 4001,
        },
        {
          executable:
            'file:///private/var/containers/Bundle/Application/ABC123/ExampleDevice.app/ExampleDeviceHelper',
          processIdentifier: 4002,
        },
      ],
    },
  });
  return emptyRunResult();
}

export function mockBackgroundXctrace(
  result?: MockRunCmdResult,
): ReturnType<typeof runCmdBackground> {
  const child = {
    kill: vi.fn((_signal?: NodeJS.Signals) => true),
    pid: 1234,
  };
  return {
    child: child as unknown as ReturnType<typeof runCmdBackground>['child'],
    wait: result ? Promise.resolve(result) : new Promise<MockRunCmdResult>(() => {}),
  };
}

export function matchesDevicectlInfo(
  args: readonly string[],
  subject: 'apps' | 'processes',
): boolean {
  return (
    args[0] === 'devicectl' && args[1] === 'device' && args[2] === 'info' && args[3] === subject
  );
}

export async function writeJsonOutput(args: readonly string[], data: unknown): Promise<void> {
  await fs.writeFile(readOutputPath(args, '--json-output'), JSON.stringify(data), 'utf8');
}

export function readOutputPath(args: readonly string[], flag = '--output'): string {
  return args[args.indexOf(flag) + 1]!;
}

export function emptyRunResult(): MockRunCmdResult {
  return { stdout: '', stderr: '', exitCode: 0 };
}

export function makeActivityMonitorCaptureXml(): string {
  return [
    '<?xml version="1.0"?>',
    '<trace-query-result>',
    '<node xpath="//trace-toc[1]/run[1]/data[1]/table[7]">',
    '<schema name="activity-monitor-process-live">',
    '<col><mnemonic>start</mnemonic></col>',
    '<col><mnemonic>process</mnemonic></col>',
    '<col><mnemonic>cpu-total</mnemonic></col>',
    '<col><mnemonic>memory-real</mnemonic></col>',
    '<col><mnemonic>pid</mnemonic></col>',
    '</schema>',
    makeActivityMonitorRow('ExampleDeviceApp', 4001, 100_000_000, 8_388_608),
    makeActivityMonitorRow('OtherApp', 5001, 75_000_000, 4_194_304),
    '</node>',
    '</trace-query-result>',
  ].join('');
}

export function makeActivityMonitorRow(
  processName: string,
  pid: number,
  cpuTimeNs: number,
  memoryBytes: number,
): string {
  return [
    '<row>',
    `<start-time fmt="00:00.123">${pid === 4001 ? 123 : 124}</start-time>`,
    `<process fmt="${processName} (${pid})"><pid fmt="${pid}">${pid}</pid></process>`,
    `<duration-on-core fmt="100.00 ms">${cpuTimeNs}</duration-on-core>`,
    `<size-in-bytes fmt="8.00 MiB">${memoryBytes}</size-in-bytes>`,
    `<pid fmt="${pid}">${pid}</pid>`,
    pid === 4001 ? '<process ref="background-process"/>' : '',
    '</row>',
  ].join('');
}
