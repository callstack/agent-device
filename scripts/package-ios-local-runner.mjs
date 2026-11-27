import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isReleaseVersion } from './release-version.mjs';

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function plist(file) {
  return JSON.parse(
    execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }),
  );
}

function requireSafeRelativePath(relativePath) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.split('/').some((part) => !part || part === '.' || part === '..') ||
    relativePath.includes('\\') ||
    Array.from(relativePath).some((char) => char.charCodeAt(0) < 32)
  ) {
    throw new Error(`Unsafe local runner path: ${relativePath}`);
  }
  return relativePath;
}

const productKeys = new Set([
  'ProductPaths',
  'DependentProductPaths',
  'TestHostPath',
  'TestBundlePath',
  'UITargetAppPath',
]);

function validateXctestrunPaths(value, key) {
  if (Array.isArray(value)) {
    for (const item of value) validateXctestrunPaths(item, key);
  } else if (value && typeof value === 'object') {
    for (const [name, item] of Object.entries(value)) validateXctestrunPaths(item, name);
  } else if (typeof value === 'string') {
    if (productKeys.has(key)) {
      const reference = /^__(?:TESTROOT|TESTHOST)__\/([^:]+)$/.exec(value);
      if (!reference) throw new Error(`Non-relocatable xctestrun product reference: ${key}`);
      requireSafeRelativePath(reference[1]);
      return;
    }
    for (const item of value.split(':')) {
      // Xcode emits a /private prefix for a TESTROOT on the canonical macOS path.
      const portable = item.replace(/^\/private(?=__TESTROOT__\/)/, '');
      if (
        portable.startsWith('/') &&
        !(key === 'DYLD_INSERT_LIBRARIES' && portable === '/usr/lib/libRPAC.dylib')
      ) {
        throw new Error(`Absolute path in xctestrun: ${key}`);
      }
      const reference = /^__[A-Z_]+__\/(.*)$/.exec(portable);
      if (reference) requireSafeRelativePath(reference[1]);
    }
  }
}

function requireArm64Bundle(bundle) {
  const info = plist(path.join(bundle, 'Info.plist'));
  if (info.DTPlatformName !== 'iphonesimulator') {
    throw new Error(`Expected an iOS simulator bundle: ${bundle}`);
  }
  const executable = requireSafeRelativePath(info.CFBundleExecutable);
  if (executable !== path.basename(executable)) throw new Error(`Invalid executable: ${bundle}`);
  execFileSync('xcrun', ['lipo', '-verify_arch', 'arm64', path.join(bundle, executable)], {
    stdio: 'inherit',
  });
}

function includeProductEntry(source) {
  const name = path.basename(source);
  if (
    /\.dSYM$|\.log$|\.xcactivitylog$|\.xcresult$|\.noindex$|\.mobileprovision$|^embedded\.provisionprofile$|^AgentDeviceRunner\.env\./.test(
      name,
    )
  ) {
    return false;
  }
  const stat = fs.lstatSync(source);
  if (!stat.isDirectory() && !stat.isFile()) {
    throw new Error(`Unexpected filesystem entry in runner product: ${source}`);
  }
  return true;
}

function packageLocalRunner(version, derivedPath, xctestrunPath, outputDir) {
  const derived = path.resolve(derivedPath);
  const products = path.join(derived, 'Build', 'Products');
  const realProducts = path.join(fs.realpathSync(derived), 'Build', 'Products');
  const sourceXctestrun = path.resolve(xctestrunPath);
  const xctestrun = requireSafeRelativePath(path.basename(sourceXctestrun));
  // The build script writes this after checking the build log and certifying the on-disk products.
  const { artifacts, xcodeVersion, xcodeBuildVersion, sdkName, sdkVersion, sdkBuildVersion } =
    JSON.parse(fs.readFileSync(path.join(derived, '.agent-device-runner-cache.json'), 'utf8'));
  if (
    sdkName !== 'iphonesimulator' ||
    ![xcodeVersion, xcodeBuildVersion, sdkVersion, sdkBuildVersion].every(
      (value) => typeof value === 'string' && value.trim(),
    ) ||
    path.dirname(sourceXctestrun) !== products ||
    fs.realpathSync(products) !== realProducts ||
    !xctestrun.endsWith('.xctestrun') ||
    xctestrun.startsWith('AgentDeviceRunner.env.') ||
    !fs.lstatSync(sourceXctestrun).isFile() ||
    artifacts?.xctestrunPath !== sourceXctestrun ||
    artifacts.xctestrunDigest !== sha256(sourceXctestrun)
  ) {
    throw new Error('Local runner requires a certified iOS simulator build');
  }
  validateXctestrunPaths(plist(sourceXctestrun));

  const appPaths = new Set();
  for (const product of artifacts.productPaths) {
    const relative = requireSafeRelativePath(path.relative(products, product));
    const parts = relative.split('/');
    const appIndex = parts.findIndex((part) => part.endsWith('.app'));
    if (appIndex < 0) throw new Error(`Expected an app product: ${relative}`);
    appPaths.add(parts.slice(0, appIndex + 1).join('/'));
  }
  if (!appPaths.size) throw new Error('No iOS simulator app products');

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-ios-local-runner-'));
  try {
    const stagedXctestrun = path.join(stage, xctestrun);
    execFileSync('plutil', ['-convert', 'xml1', '-o', stagedXctestrun, sourceXctestrun]);
    fs.writeFileSync(
      stagedXctestrun,
      fs.readFileSync(stagedXctestrun, 'utf8').replaceAll('/private__TESTROOT__/', '__TESTROOT__/'),
    );
    for (const app of appPaths) {
      const source = path.join(products, app);
      if (fs.realpathSync(source) !== path.join(realProducts, app)) {
        throw new Error(`Symlink in runner product path: ${app}`);
      }
      const destination = path.join(stage, app);
      fs.cpSync(source, destination, { recursive: true, filter: includeProductEntry });
      requireArm64Bundle(destination);
    }
    for (const product of artifacts.productPaths) {
      const staged = path.join(stage, path.relative(products, product));
      fs.accessSync(staged);
      if (staged.endsWith('.xctest')) requireArm64Bundle(staged);
    }

    const stem = `agent-device-ios-local-runner-${version}`;
    const archivePath = path.resolve(outputDir, `${stem}.tar.gz`);
    const manifestPath = path.resolve(outputDir, `${stem}.manifest.json`);
    fs.mkdirSync(outputDir, { recursive: true });
    execFileSync('tar', ['-czf', archivePath, '-C', stage, xctestrun, ...appPaths], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
      stdio: 'inherit',
    });
    const manifest = {
      version,
      sha256: sha256(archivePath),
      xcodeVersion,
      xcodeBuildVersion,
      sdkName,
      sdkVersion,
      sdkBuildVersion,
      xctestrun,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `archive_path=${archivePath}\nmanifest_path=${manifestPath}\n`,
      );
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

const [version, derivedPath, xctestrunPath, outputDir] = process.argv.slice(2);
if (!version || !derivedPath || !xctestrunPath || !outputDir) {
  throw new Error(
    'Usage: package-ios-local-runner.mjs <version> <derived> <xctestrun> <output-dir>',
  );
}
if (isReleaseVersion(version)) packageLocalRunner(version, derivedPath, xctestrunPath, outputDir);
