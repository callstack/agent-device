import type { DeviceInfo } from '../kernel/device.ts';
import { AppError, asAppError } from '../kernel/errors.ts';
import type { SessionRuntimeHints } from './types.ts';
import {
  resolveRuntimeTransportHints,
  type ResolvedRuntimeTransport,
} from '../utils/runtime-transport.ts';
import { runAndroidAdb } from '../platforms/android/adb.ts';
import {
  classifyAndroidAppTarget,
  formatAndroidInstalledPackageRequiredMessage,
} from '../platforms/android/open-target.ts';
import { buildSimctlArgsForDevice } from '../platforms/apple/core/simctl.ts';
import { runXcrun } from '../platforms/apple/core/tool-provider.ts';
import { isActiveProviderDevice } from '../provider-device-runtime.ts';

const ANDROID_DEV_PREFS_PATH = 'shared_prefs/ReactNativeDevPrefs.xml';
const ANDROID_DEBUG_HOST_KEY = 'debug_http_host';
const ANDROID_HTTPS_KEY = 'dev_server_https';
const IOS_JS_LOCATION_KEY = 'RCT_jsLocation';
const IOS_PACKAGER_SCHEME_KEY = 'RCT_packager_scheme';
const ANDROID_RUN_AS_HINT =
  'React Native runtime hints require adb run-as access to the app sandbox. Verify the app is debuggable and the selected package/device are correct.';
const ANDROID_WRITE_HINT =
  'adb run-as succeeded, but writing ReactNativeDevPrefs.xml failed. Inspect stderr/details for the failing shell command.';
const ANDROID_PROBE_HINT =
  'adb shell run-as probe failed. Check adb connectivity and that the device is reachable. Inspect stderr/details for more information.';
const DEFAULT_ANDROID_PREFS_XML = [
  '<?xml version="1.0" encoding="utf-8" standalone="yes" ?>',
  '<map>',
  '</map>',
  '',
].join('\n');

export { resolveRuntimeTransportHints, trimRuntimeValue } from '../utils/runtime-transport.ts';

export function hasRuntimeTransportHints(runtime: SessionRuntimeHints | undefined): boolean {
  return resolveRuntimeTransportHints(runtime) !== undefined;
}

export async function applyRuntimeHintsToApp(params: {
  device: DeviceInfo;
  appId?: string;
  runtime: SessionRuntimeHints | undefined;
}): Promise<void> {
  const { device, appId, runtime } = params;
  if (isActiveProviderDevice(device)) return;
  if (!appId) return;
  const transport = resolveRuntimeTransportHints(runtime);
  if (!transport) return;

  if (device.platform === 'android') {
    await applyAndroidRuntimeHints(device, appId, transport);
    return;
  }

  if (device.platform === 'ios' && device.kind === 'simulator') {
    await applyIosSimulatorRuntimeHints(device, appId, transport);
  }
}

export async function clearRuntimeHintsFromApp(params: {
  device: DeviceInfo;
  appId?: string;
}): Promise<void> {
  const { device, appId } = params;
  if (!appId) return;

  if (device.platform === 'android') {
    await clearAndroidRuntimeHints(device, appId);
    return;
  }

  if (device.platform === 'ios' && device.kind === 'simulator') {
    await clearIosSimulatorRuntimeHints(device, appId);
  }
}

async function applyAndroidRuntimeHints(
  device: DeviceInfo,
  packageName: string,
  transport: ResolvedRuntimeTransport,
): Promise<void> {
  assertAndroidRuntimePackageName(packageName);
  const currentXml = await readAndroidDevPrefs(device, packageName);
  let nextXml = upsertAndroidStringPref(
    currentXml,
    ANDROID_DEBUG_HOST_KEY,
    `${transport.host}:${transport.port}`,
  );
  nextXml = upsertAndroidBooleanPref(nextXml, ANDROID_HTTPS_KEY, transport.scheme === 'https');
  await writeAndroidDevPrefs(device, packageName, nextXml);
}

async function clearAndroidRuntimeHints(device: DeviceInfo, packageName: string): Promise<void> {
  assertAndroidRuntimePackageName(packageName);
  const currentXml = await readAndroidDevPrefs(device, packageName);
  const withoutHost = removeAndroidPrefEntry(currentXml, ANDROID_DEBUG_HOST_KEY);
  const withoutHttps = removeAndroidPrefEntry(withoutHost, ANDROID_HTTPS_KEY);
  if (withoutHttps === currentXml) return;
  await writeAndroidDevPrefs(device, packageName, withoutHttps);
}

async function readAndroidDevPrefs(device: DeviceInfo, packageName: string): Promise<string> {
  const result = await runAndroidAdb(
    device,
    ['shell', 'run-as', packageName, 'cat', ANDROID_DEV_PREFS_PATH],
    { allowFailure: true },
  );
  if (result.exitCode !== 0) return DEFAULT_ANDROID_PREFS_XML;
  return normalizeAndroidPrefsXml(result.stdout);
}

async function writeAndroidDevPrefs(
  device: DeviceInfo,
  packageName: string,
  xml: string,
): Promise<void> {
  const probeArgs = ['shell', 'run-as', packageName, 'id'];
  const probeResult = await runAndroidAdb(device, probeArgs, { allowFailure: true });
  if (probeResult.exitCode !== 0) {
    const runAsDenied = isAndroidRunAsDeniedOutput(probeResult.stdout, probeResult.stderr);
    throw new AppError(
      'COMMAND_FAILED',
      runAsDenied
        ? `Failed to access Android app sandbox for ${packageName}`
        : `Failed to probe Android app sandbox for ${packageName}`,
      {
        package: packageName,
        cmd: 'adb',
        args: probeArgs,
        stdout: probeResult.stdout,
        stderr: probeResult.stderr,
        exitCode: probeResult.exitCode,
        hint: runAsDenied ? ANDROID_RUN_AS_HINT : ANDROID_PROBE_HINT,
      },
    );
  }

  try {
    await runAndroidAdb(device, ['shell', 'run-as', packageName, 'mkdir', '-p', 'shared_prefs']);
    await runAndroidAdb(device, ['shell', 'run-as', packageName, 'tee', ANDROID_DEV_PREFS_PATH], {
      stdin: xml.trimEnd(),
    });
  } catch (error) {
    const appErr = asAppError(error);
    if (appErr.code === 'TOOL_MISSING') throw appErr;
    const stdout = typeof appErr.details?.stdout === 'string' ? appErr.details.stdout : '';
    const stderr = typeof appErr.details?.stderr === 'string' ? appErr.details.stderr : '';
    const runAsDenied = isAndroidRunAsDeniedOutput(stdout, stderr);
    throw new AppError(
      'COMMAND_FAILED',
      runAsDenied
        ? `Failed to access Android app sandbox for ${packageName}`
        : `Failed to write Android runtime hints for ${packageName}`,
      {
        ...(appErr.details ?? {}),
        package: packageName,
        cmd: 'adb',
        phase: 'write-runtime-hints',
        hint: runAsDenied ? ANDROID_RUN_AS_HINT : ANDROID_WRITE_HINT,
      },
      appErr,
    );
  }
}

async function applyIosSimulatorRuntimeHints(
  device: DeviceInfo,
  bundleId: string,
  transport: ResolvedRuntimeTransport,
): Promise<void> {
  await runXcrun(
    buildSimctlArgsForDevice(device, [
      'spawn',
      device.id,
      'defaults',
      'write',
      bundleId,
      IOS_JS_LOCATION_KEY,
      '-string',
      `${transport.host}:${transport.port}`,
    ]),
  );
  await runXcrun(
    buildSimctlArgsForDevice(device, [
      'spawn',
      device.id,
      'defaults',
      'write',
      bundleId,
      IOS_PACKAGER_SCHEME_KEY,
      '-string',
      transport.scheme,
    ]),
  );
}

async function clearIosSimulatorRuntimeHints(device: DeviceInfo, bundleId: string): Promise<void> {
  await runXcrun(
    buildSimctlArgsForDevice(device, [
      'spawn',
      device.id,
      'defaults',
      'delete',
      bundleId,
      IOS_JS_LOCATION_KEY,
    ]),
    { allowFailure: true },
  );
  await runXcrun(
    buildSimctlArgsForDevice(device, [
      'spawn',
      device.id,
      'defaults',
      'delete',
      bundleId,
      IOS_PACKAGER_SCHEME_KEY,
    ]),
    { allowFailure: true },
  );
}

function normalizeAndroidPrefsXml(xml: string): string {
  const trimmed = xml.trim();
  if (!trimmed.includes('<map') || !trimmed.includes('</map>')) {
    return DEFAULT_ANDROID_PREFS_XML;
  }
  return `${trimmed}\n`;
}

function upsertAndroidStringPref(xml: string, key: string, value: string): string {
  const entry = `  <string name="${escapeXmlText(key)}">${escapeXmlText(value)}</string>`;
  return insertAndroidPrefEntry(removeAndroidPrefEntry(xml, key), entry);
}

function upsertAndroidBooleanPref(xml: string, key: string, value: boolean): string {
  const entry = `  <boolean name="${escapeXmlText(key)}" value="${value ? 'true' : 'false'}" />`;
  return insertAndroidPrefEntry(removeAndroidPrefEntry(xml, key), entry);
}

function insertAndroidPrefEntry(xml: string, entry: string): string {
  const normalized = normalizeAndroidPrefsXml(xml);
  return normalized.replace('</map>', `${entry}\n</map>`);
}

function removeAndroidPrefEntry(xml: string, key: string): string {
  const escapedKey = escapeRegex(key);
  return normalizeAndroidPrefsXml(xml)
    .replace(new RegExp(`^\\s*<string name="${escapedKey}">[\\s\\S]*?<\\/string>\\n?`, 'm'), '')
    .replace(
      new RegExp(`^\\s*<boolean name="${escapedKey}" value="(?:true|false)"\\s*\\/?>\\n?`, 'm'),
      '',
    );
}

function assertAndroidRuntimePackageName(packageName: string): void {
  if (classifyAndroidAppTarget(packageName) !== 'binary') return;
  const message = formatAndroidInstalledPackageRequiredMessage(packageName);
  throw new AppError('INVALID_ARGS', message, {
    package: packageName,
    hint: message,
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function isAndroidRunAsDeniedOutput(stdout: string, stderr: string): boolean {
  const output = `${stdout}\n${stderr}`.toLowerCase();
  return [
    'run-as: package not debuggable',
    'run-as: permission denied',
    'run-as: package is unknown',
    'run-as: unknown package',
    'is unknown',
    'is not an application',
    'could not set capabilities',
  ].some((pattern) => output.includes(pattern));
}
