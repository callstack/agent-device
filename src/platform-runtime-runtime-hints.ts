import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError, asAppError } from '@agent-device/kernel/errors';
import { escapeXmlTextAndAttribute } from '@agent-device/xml';
import type { RuntimeHintValues } from '@agent-device/contracts/application-lifecycle-runtime';
import { execFailureDetails, type ExecResult } from '@agent-device/host-kit/command';
import { type ResolvedRuntimeTransport } from './utils/runtime-transport.ts';

// React Native's PackagerConnectionSettings/DevInternalSettings read debug_http_host via
// PreferenceManager.getDefaultSharedPreferences(context), which resolves to
// `<packageName>_preferences.xml`, not a React Native-specific file. We write both that file
// and the legacy ReactNativeDevPrefs.xml path (kept in case some RN fork/version reads it) so
// the hint reaches the app either way.
const ANDROID_LEGACY_DEV_PREFS_PATH = 'shared_prefs/ReactNativeDevPrefs.xml';
const ANDROID_DEBUG_HOST_KEY = 'debug_http_host';
const ANDROID_HTTPS_KEY = 'dev_server_https';
const IOS_JS_LOCATION_KEY = 'RCT_jsLocation';
const IOS_PACKAGER_SCHEME_KEY = 'RCT_packager_scheme';
const ANDROID_RUN_AS_HINT =
  'React Native runtime hints require adb run-as access to the app sandbox. Verify the app is debuggable and the selected package/device are correct.';
const ANDROID_WRITE_HINT =
  'adb run-as succeeded, but writing React Native dev-server preferences failed. Inspect stderr/details for the failing shell command.';
const ANDROID_PROBE_HINT =
  'adb shell run-as probe failed. Check adb connectivity and that the device is reachable. Inspect stderr/details for more information.';
const DEFAULT_ANDROID_PREFS_XML = [
  '<?xml version="1.0" encoding="utf-8" standalone="yes" ?>',
  '<map>',
  '</map>',
  '',
].join('\n');

export async function applyRuntimeHintValues(params: {
  device: DeviceInfo;
  appId?: string;
  values: RuntimeHintValues;
}): Promise<void> {
  const { device, appId, values } = params;
  if (!appId) return;
  const transport = resolveRuntimeTransportHintValues(values);
  if (!transport) return;

  if (device.platform === 'android') {
    await applyAndroidRuntimeHints(device, appId, transport);
    return;
  }

  if (isIosFamily(device) && device.kind === 'simulator') {
    await applyIosSimulatorRuntimeHints(device, appId, transport);
  }
}

export async function clearRuntimeHintValues(params: {
  device: DeviceInfo;
  appId?: string;
}): Promise<void> {
  const { device, appId } = params;
  if (!appId) return;

  if (device.platform === 'android') {
    await clearAndroidRuntimeHints(device, appId);
    return;
  }

  if (isIosFamily(device) && device.kind === 'simulator') {
    await clearIosSimulatorRuntimeHints(device, appId);
  }
}

function resolveRuntimeTransportHintValues(
  values: RuntimeHintValues,
): ResolvedRuntimeTransport | undefined {
  const bundleTransport = resolveBundleRuntimeTransport(runtimeHintValue(values, 'bundleUrl'));
  const host = runtimeHintValue(values, 'metroHost') ?? bundleTransport?.host;
  const port = runtimeHintPort(values, 'metroPort') ?? bundleTransport?.port;
  const scheme = bundleTransport?.scheme ?? 'http';
  return host && port ? { host, port, scheme } : undefined;
}

type RuntimeBundleTransport = Readonly<{
  host?: string;
  port?: number;
  scheme: 'http' | 'https';
}>;

function resolveBundleRuntimeTransport(
  bundleUrl: string | undefined,
): RuntimeBundleTransport | undefined {
  if (!bundleUrl) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(bundleUrl);
  } catch (error) {
    throw new AppError('INVALID_ARGS', `Invalid runtime bundle URL: ${bundleUrl}`, {}, error);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  return {
    host: normalizeRuntimeHintValue(parsed.hostname),
    port: normalizeRuntimeHintPort(
      parsed.port.length > 0 ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80,
    ),
    scheme: parsed.protocol === 'https:' ? 'https' : 'http',
  };
}

function runtimeHintValue(values: RuntimeHintValues, key: string): string | undefined {
  return normalizeRuntimeHintValue(values[key]);
}

function runtimeHintPort(values: RuntimeHintValues, key: string): number | undefined {
  const value = runtimeHintValue(values, key);
  return value === undefined ? undefined : normalizeRuntimeHintPort(Number(value));
}

function normalizeRuntimeHintValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizeRuntimeHintPort(value: number): number | undefined {
  return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : undefined;
}

function androidDevPrefsPaths(packageName: string): string[] {
  return [`shared_prefs/${packageName}_preferences.xml`, ANDROID_LEGACY_DEV_PREFS_PATH];
}

async function applyAndroidRuntimeHints(
  device: DeviceInfo,
  packageName: string,
  transport: ResolvedRuntimeTransport,
): Promise<void> {
  await assertAndroidRuntimePackageName(packageName);
  const files: Array<{ path: string; xml: string }> = [];
  for (const prefsPath of androidDevPrefsPaths(packageName)) {
    const currentXml = await readAndroidDevPrefs(device, packageName, prefsPath);
    let xml = upsertAndroidStringPref(
      currentXml,
      ANDROID_DEBUG_HOST_KEY,
      `${transport.host}:${transport.port}`,
    );
    xml = upsertAndroidBooleanPref(xml, ANDROID_HTTPS_KEY, transport.scheme === 'https');
    files.push({ path: prefsPath, xml });
  }
  await writeAndroidDevPrefs(device, packageName, files);
}

async function clearAndroidRuntimeHints(device: DeviceInfo, packageName: string): Promise<void> {
  await assertAndroidRuntimePackageName(packageName);
  const files: Array<{ path: string; xml: string }> = [];
  for (const prefsPath of androidDevPrefsPaths(packageName)) {
    const currentXml = await readAndroidDevPrefs(device, packageName, prefsPath);
    const withoutHost = removeAndroidPrefEntry(currentXml, ANDROID_DEBUG_HOST_KEY);
    const xml = removeAndroidPrefEntry(withoutHost, ANDROID_HTTPS_KEY);
    if (xml !== currentXml) files.push({ path: prefsPath, xml });
  }
  if (files.length === 0) return;
  await writeAndroidDevPrefs(device, packageName, files);
}

/** Android mechanics stay implementation-lazy until an admitted Android hint operation runs. */
async function runRuntimeHintsAndroidAdb(
  device: DeviceInfo,
  args: string[],
  options?: Readonly<{ allowFailure?: boolean; stdin?: string }>,
): Promise<ExecResult> {
  const { runAndroidAdb } = await import('./platforms/android/adb.ts');
  return await runAndroidAdb(device, args, options);
}

async function readAndroidDevPrefs(
  device: DeviceInfo,
  packageName: string,
  prefsPath: string,
): Promise<string> {
  const result = await runRuntimeHintsAndroidAdb(
    device,
    ['shell', 'run-as', packageName, 'cat', prefsPath],
    { allowFailure: true },
  );
  if (result.exitCode !== 0) return DEFAULT_ANDROID_PREFS_XML;
  return normalizeAndroidPrefsXml(result.stdout);
}

async function writeAndroidDevPrefs(
  device: DeviceInfo,
  packageName: string,
  files: Array<{ path: string; xml: string }>,
): Promise<void> {
  await assertAndroidAppSandboxAccessible(device, packageName);
  try {
    await writeAndroidDevPrefsFiles(device, packageName, files);
  } catch (error) {
    throw androidRuntimeHintsWriteError(error, packageName);
  }
}

async function assertAndroidAppSandboxAccessible(
  device: DeviceInfo,
  packageName: string,
): Promise<void> {
  const probeArgs = ['shell', 'run-as', packageName, 'id'];
  const probeResult = await runRuntimeHintsAndroidAdb(device, probeArgs, { allowFailure: true });
  if (probeResult.exitCode === 0) return;
  throw androidRuntimeHintsProbeError(probeResult, packageName, probeArgs);
}

function androidRuntimeHintsProbeError(
  result: ExecResult,
  packageName: string,
  args: string[],
): AppError {
  const runAsDenied = isAndroidRunAsDeniedOutput(result.stdout, result.stderr);
  return new AppError(
    'COMMAND_FAILED',
    runAsDenied
      ? `Failed to access Android app sandbox for ${packageName}`
      : `Failed to probe Android app sandbox for ${packageName}`,
    execFailureDetails(result, {
      package: packageName,
      cmd: 'adb',
      args,
      hint: runAsDenied ? ANDROID_RUN_AS_HINT : ANDROID_PROBE_HINT,
    }),
  );
}

async function writeAndroidDevPrefsFiles(
  device: DeviceInfo,
  packageName: string,
  files: Array<{ path: string; xml: string }>,
): Promise<void> {
  await runRuntimeHintsAndroidAdb(device, [
    'shell',
    'run-as',
    packageName,
    'mkdir',
    '-p',
    'shared_prefs',
  ]);
  for (const file of files) {
    await runRuntimeHintsAndroidAdb(device, ['shell', 'run-as', packageName, 'tee', file.path], {
      stdin: file.xml.trimEnd(),
    });
  }
}

function androidRuntimeHintsWriteError(error: unknown, packageName: string): AppError {
  const appErr = asAppError(error);
  if (appErr.code === 'TOOL_MISSING') return appErr;
  const stdout = typeof appErr.details?.stdout === 'string' ? appErr.details.stdout : '';
  const stderr = typeof appErr.details?.stderr === 'string' ? appErr.details.stderr : '';
  const runAsDenied = isAndroidRunAsDeniedOutput(stdout, stderr);
  return new AppError(
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

async function applyIosSimulatorRuntimeHints(
  device: DeviceInfo,
  bundleId: string,
  transport: ResolvedRuntimeTransport,
): Promise<void> {
  await runIosSimulatorRuntimeHintCommand(device, [
    'spawn',
    device.id,
    'defaults',
    'write',
    bundleId,
    IOS_JS_LOCATION_KEY,
    '-string',
    `${transport.host}:${transport.port}`,
  ]);
  await runIosSimulatorRuntimeHintCommand(device, [
    'spawn',
    device.id,
    'defaults',
    'write',
    bundleId,
    IOS_PACKAGER_SCHEME_KEY,
    '-string',
    transport.scheme,
  ]);
}

async function clearIosSimulatorRuntimeHints(device: DeviceInfo, bundleId: string): Promise<void> {
  await runIosSimulatorRuntimeHintCommand(
    device,
    ['spawn', device.id, 'defaults', 'delete', bundleId, IOS_JS_LOCATION_KEY],
    { allowFailure: true },
  );
  await runIosSimulatorRuntimeHintCommand(
    device,
    ['spawn', device.id, 'defaults', 'delete', bundleId, IOS_PACKAGER_SCHEME_KEY],
    { allowFailure: true },
  );
}

/** Apple mechanics stay implementation-lazy until an admitted simulator hint operation runs. */
async function runIosSimulatorRuntimeHintCommand(
  device: DeviceInfo,
  args: string[],
  options?: Readonly<{ allowFailure?: boolean }>,
): Promise<void> {
  const [{ buildSimctlArgsForDevice }, { runXcrun }] = await Promise.all([
    import('./platforms/apple/core/simctl.ts'),
    import('./platforms/apple/core/tool-provider.ts'),
  ]);
  await runXcrun(buildSimctlArgsForDevice(device, args), options);
}

function normalizeAndroidPrefsXml(xml: string): string {
  const trimmed = xml.trim();
  if (!trimmed.includes('<map') || !trimmed.includes('</map>')) {
    return DEFAULT_ANDROID_PREFS_XML;
  }
  return `${trimmed}\n`;
}

function upsertAndroidStringPref(xml: string, key: string, value: string): string {
  const entry = `  <string name="${escapeXmlTextAndAttribute(key)}">${escapeXmlTextAndAttribute(value)}</string>`;
  return insertAndroidPrefEntry(removeAndroidPrefEntry(xml, key), entry);
}

function upsertAndroidBooleanPref(xml: string, key: string, value: boolean): string {
  const entry = `  <boolean name="${escapeXmlTextAndAttribute(key)}" value="${value ? 'true' : 'false'}" />`;
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

async function assertAndroidRuntimePackageName(packageName: string): Promise<void> {
  const { classifyAndroidAppTarget, formatAndroidInstalledPackageRequiredMessage } =
    await import('./platforms/android/open-target.ts');
  if (classifyAndroidAppTarget(packageName) !== 'binary') return;
  const message = formatAndroidInstalledPackageRequiredMessage(packageName);
  throw new AppError('INVALID_ARGS', message, {
    package: packageName,
    hint: message,
  });
}

function escapeRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
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
