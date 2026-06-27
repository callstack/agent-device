#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const [platform, derivedPath, destination] = args;

if (!platform || !derivedPath || !destination) {
  console.error(
    'Usage: write-xcuitest-cache-metadata.mjs <ios|macos|tvos> <derived> <destination>',
  );
  process.exit(1);
}

const projectRoot = process.cwd();
const metadataPath = path.join(derivedPath, '.agent-device-runner-cache.json');

const DEFAULT_IOS_RUNNER_APP_BUNDLE_ID = 'com.callstack.agentdevice.runner';

function isTruthy(value) {
  return ['1', 'true', 'TRUE', 'yes', 'YES', 'on', 'ON'].includes(String(value ?? ''));
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function normalizeBundleId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveRunnerAppBundleId() {
  return (
    normalizeBundleId(process.env.AGENT_DEVICE_IOS_BUNDLE_ID) ||
    normalizeBundleId(process.env.AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID) ||
    DEFAULT_IOS_RUNNER_APP_BUNDLE_ID
  );
}

function resolveRunnerTestBundleId() {
  return (
    normalizeBundleId(process.env.AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID) ||
    `${resolveRunnerAppBundleId()}.uitests`
  );
}

function computeRunnerSourceFingerprint() {
  const runnerRoot = path.join(projectRoot, 'ios-runner', 'AgentDeviceRunner');
  const files = collectRunnerSourceFiles(runnerRoot);
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(runnerRoot, file));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function collectRunnerSourceFiles(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'xcuserdata') continue;
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && isRunnerSourceFile(entry.name, fullPath)) {
        files.push(fullPath);
      }
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function isRunnerSourceFile(fileName, filePath) {
  if (fileName === 'project.pbxproj') {
    return filePath.includes(`${path.sep}.xcodeproj${path.sep}`);
  }
  return [
    '.jpg',
    '.json',
    '.png',
    '.swift',
    '.m',
    '.h',
    '.plist',
    '.entitlements',
    '.xctestplan',
    '.xcconfig',
    '.storyboard',
    '.xib',
  ].includes(path.extname(fileName));
}

function resolvePlatformName() {
  if (platform === 'ios') return 'iOS';
  if (platform === 'tvos') return 'tvOS';
  if (platform === 'macos') return 'macOS';
  throw new Error(`Unsupported platform: ${platform}`);
}

function resolveDeviceKind() {
  if (platform === 'macos') return 'device';
  return destination.includes('Simulator') ? 'simulator' : 'device';
}

function resolveTarget() {
  if (platform === 'macos') return 'desktop';
  if (platform === 'tvos') return 'tv';
  return 'mobile';
}

function resolveMacRunnerArch() {
  return process.arch === 'arm64' ? 'arm64' : 'x86_64';
}

function resolveBuildDestinationFamily() {
  const platformName = resolvePlatformName();
  if (platformName === 'macOS') {
    return `platform=macOS,arch=${resolveMacRunnerArch()}`;
  }
  if (resolveDeviceKind() === 'simulator') {
    return `generic/platform=${platformName} Simulator`;
  }
  return `generic/platform=${platformName}`;
}

function resolveRunnerSdkName() {
  const platformName = resolvePlatformName();
  if (platformName === 'macOS') return 'macosx';
  if (platformName === 'tvOS') {
    return resolveDeviceKind() === 'simulator' ? 'appletvsimulator' : 'appletvos';
  }
  return resolveDeviceKind() === 'simulator' ? 'iphonesimulator' : 'iphoneos';
}

function runAppleToolFingerprintCommand(command, args) {
  try {
    return (
      execFileSync(command, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
        maxBuffer: 128 * 1024,
      }).trim() || 'unknown'
    );
  } catch {
    return 'unknown';
  }
}

function parseXcodeVersionOutput(output) {
  return {
    version: output.match(/^Xcode\s+(.+)$/m)?.[1]?.trim() || 'unknown',
    buildVersion: output.match(/^Build version\s+(.+)$/m)?.[1]?.trim() || 'unknown',
  };
}

function resolveRunnerToolchainFingerprint() {
  const xcode = parseXcodeVersionOutput(runAppleToolFingerprintCommand('xcodebuild', ['-version']));
  const sdkName = resolveRunnerSdkName();
  return {
    xcodeVersion: xcode.version,
    xcodeBuildVersion: xcode.buildVersion,
    sdkName,
    sdkVersion: runAppleToolFingerprintCommand('xcrun', ['--sdk', sdkName, '--show-sdk-version']),
    sdkBuildVersion: runAppleToolFingerprintCommand('xcrun', [
      '--sdk',
      sdkName,
      '--show-sdk-build-version',
    ]),
  };
}

function resolveSigningBuildSettings() {
  if (platform !== 'macos') {
    return [];
  }
  return [
    'CODE_SIGNING_ALLOWED=NO',
    'CODE_SIGNING_REQUIRED=NO',
    'CODE_SIGN_IDENTITY=',
    'DEVELOPMENT_TEAM=',
  ];
}

function resolveSandboxBuildArgs() {
  const swiftFlags = isTruthy(process.env.AGENT_DEVICE_XCUITEST_INCLUDE_UNIT_TESTS)
    ? '$(inherited) -disable-sandbox -D AGENT_DEVICE_RUNNER_UNIT_TESTS'
    : '$(inherited) -disable-sandbox';
  return [
    '-IDEPackageSupportDisableManifestSandbox=1',
    '-IDEPackageSupportDisablePluginExecutionSandbox=1',
    'ENABLE_USER_SCRIPT_SANDBOXING=NO',
    `OTHER_SWIFT_FLAGS=${swiftFlags}`,
  ];
}

const appBundleId = resolveRunnerAppBundleId();
const testBundleId = resolveRunnerTestBundleId();
const metadata = {
  schemaVersion: 2,
  packageVersion: readPackageVersion(),
  runnerSourceFingerprint: computeRunnerSourceFingerprint(),
  ...resolveRunnerToolchainFingerprint(),
  platformName: resolvePlatformName(),
  deviceKind: resolveDeviceKind(),
  target: resolveTarget(),
  buildDestinationFamily: resolveBuildDestinationFamily(),
  runnerBundleBuildSettings: [
    `AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID=${appBundleId}`,
    `AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID=${testBundleId}`,
  ],
  runnerSigningBuildSettings: resolveSigningBuildSettings(),
  runnerPerformanceBuildSettings: [
    'COMPILER_INDEX_STORE_ENABLE=NO',
    'ENABLE_CODE_COVERAGE=NO',
    'ONLY_ACTIVE_ARCH=YES',
    'ENABLE_PREVIEWS=NO',
    'ENABLE_DEBUG_DYLIB=NO',
  ],
  runnerSandboxBuildArgs: resolveSandboxBuildArgs(),
};

const artifacts = resolveRunnerCacheArtifacts();
if (artifacts) {
  metadata.artifacts = artifacts;
}

fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

function resolveRunnerCacheArtifacts() {
  const xctestrunPath = findXctestrun(derivedPath);
  if (!xctestrunPath) return null;
  const productPaths = resolveExistingXctestrunProductPaths(xctestrunPath);
  if (!productPaths || productPaths.length === 0) return null;
  const xctestrunMtimeMs = readFileMtimeMs(xctestrunPath);
  const xctestrunSize = readFileSize(xctestrunPath);
  if (xctestrunMtimeMs === null || xctestrunSize === null) return null;
  const productArtifacts = [];
  for (const productPath of productPaths) {
    const mtimeMs = readFileMtimeMs(productPath);
    const size = readFileSize(productPath);
    if (mtimeMs === null || size === null) return null;
    productArtifacts.push({ path: productPath, mtimeMs, size });
  }
  return { xctestrunPath, xctestrunMtimeMs, xctestrunSize, productPaths: productArtifacts };
}

function findXctestrun(root) {
  if (!fs.existsSync(root)) return null;
  const candidates = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.xctestrun')) {
        continue;
      }
      try {
        candidates.push({ path: fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs });
      } catch {}
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => {
    const scoreDiff = scoreXctestrunCandidate(right.path) - scoreXctestrunCandidate(left.path);
    return scoreDiff || right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path);
  });
  return candidates[0]?.path ?? null;
}

function scoreXctestrunCandidate(candidatePath) {
  const basename = path.basename(candidatePath);
  let score = 0;
  if (basename.includes('.env.')) score -= 50;
  if (platform === 'ios') {
    score += destination.includes('Simulator')
      ? basename.includes('iphonesimulator')
        ? 100
        : 0
      : basename.includes('iphoneos')
        ? 100
        : 0;
  } else if (platform === 'tvos') {
    score += destination.includes('Simulator')
      ? basename.includes('appletvsimulator')
        ? 100
        : 0
      : basename.includes('appletvos')
        ? 100
        : 0;
  } else if (platform === 'macos') {
    score +=
      basename.includes('macos') || candidatePath.includes(`${path.sep}macos${path.sep}`) ? 100 : 0;
  }
  return score;
}

function resolveExistingXctestrunProductPaths(xctestrunPath) {
  const values = resolveXctestrunProductReferences(xctestrunPath);
  if (!values || values.length === 0) return null;
  const testRoot = path.dirname(xctestrunPath);
  const resolvedPaths = new Set();
  const products = collectResolvedTestHostProducts(values, testRoot);

  for (const resolvedPath of products.testRootPaths) {
    if (!fs.existsSync(resolvedPath)) return null;
    resolvedPaths.add(resolvedPath);
  }

  for (const resolvedPath of resolveTestHostRelativePaths(products)) {
    if (!resolvedPath) return null;
    resolvedPaths.add(resolvedPath);
  }

  return Array.from(resolvedPaths);
}

function resolveXctestrunProductReferences(xctestrunPath) {
  let parsed;
  try {
    parsed = JSON.parse(
      execFileSync('plutil', ['-convert', 'json', '-o', '-', xctestrunPath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return null;
  }
  return resolveXctestrunProductReferencesFromJson(parsed);
}

function resolveXctestrunProductReferencesFromJson(parsed) {
  const values = new Set();
  for (const target of collectXctestrunProductReferenceTargets(parsed)) {
    for (const value of collectXctestrunProductReferenceValuesFromTarget(target)) {
      values.add(value);
    }
  }
  return Array.from(values);
}

function collectXctestrunProductReferenceTargets(parsed) {
  return [parsed, ...collectConfiguredTestTargets(parsed), ...collectLegacyTestTargets(parsed)];
}

function collectConfiguredTestTargets(parsed) {
  const testConfigurations = parsed?.TestConfigurations;
  if (!Array.isArray(testConfigurations)) return [];
  const targets = [];
  for (const config of testConfigurations) {
    if (!isRecord(config) || !Array.isArray(config.TestTargets)) {
      continue;
    }
    targets.push(...config.TestTargets.filter(isRecord));
  }
  return targets;
}

function collectLegacyTestTargets(parsed) {
  if (!isRecord(parsed)) return [];
  return Object.values(parsed).filter((value) => isRecord(value) && 'TestBundlePath' in value);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function collectXctestrunProductReferenceValuesFromTarget(target) {
  const values = new Set();
  const productReferenceKeys = new Set([
    'ProductPaths',
    'DependentProductPaths',
    'TestHostPath',
    'TestBundlePath',
    'UITargetAppPath',
  ]);
  for (const [key, value] of Object.entries(target)) {
    if (!productReferenceKeys.has(key)) continue;
    if (typeof value === 'string') {
      values.add(value);
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === 'string') values.add(item);
    }
  }
  return Array.from(values);
}

function collectResolvedTestHostProducts(values, testRoot) {
  const testRootPaths = [];
  const hostRoots = new Set();
  const hostRelativePaths = [];

  for (const value of values) {
    if (value.startsWith('__TESTHOST__/')) {
      hostRelativePaths.push(value.slice('__TESTHOST__/'.length));
      continue;
    }
    if (!value.startsWith('__TESTROOT__/')) continue;
    const relativePath = value.slice('__TESTROOT__/'.length);
    testRootPaths.push(path.join(testRoot, relativePath));
    const appBundleRoot = extractAppBundleRoot(relativePath);
    if (appBundleRoot) {
      hostRoots.add(path.join(testRoot, appBundleRoot));
    }
  }

  return {
    testRootPaths,
    hostRoots: Array.from(hostRoots),
    hostRelativePaths,
  };
}

function resolveTestHostRelativePaths(products) {
  return products.hostRelativePaths.map((relativePath) => {
    const resolvedHostRoot = products.hostRoots.find((hostRoot) =>
      fs.existsSync(path.join(hostRoot, relativePath)),
    );
    return resolvedHostRoot ? path.join(resolvedHostRoot, relativePath) : null;
  });
}

function extractAppBundleRoot(relativePath) {
  const match = /\.app(?:\/|$)/.exec(relativePath);
  if (!match || match.index === undefined) return null;
  return relativePath.slice(0, match.index + '.app'.length);
}

function readFileMtimeMs(filePath) {
  try {
    return Math.trunc(fs.statSync(filePath).mtimeMs);
  } catch {
    return null;
  }
}

function readFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
}
