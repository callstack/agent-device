import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const [command, ...options] = process.argv.slice(2);
if (!['sync', 'pack'].includes(command) || options.length > 0) {
  throw new Error('Usage: node scripts/release-workspace.mjs <sync|pack>');
}
const packages = JSON.parse(
  execFileSync('pnpm', ['list', '--recursive', '--depth', '-1', '--json'], {
    cwd: root,
    encoding: 'utf8',
  }),
).map((project) => {
  const manifestPath = path.join(project.path, 'package.json');
  return {
    directory: project.path,
    manifestPath,
    manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
  };
});
const rootPackage = packages.find((pkg) => pkg.directory === root);
if (!rootPackage) throw new Error('The release workspace must include its root package.');
const version = rootPackage.manifest.version;
const publicPackages = packages.filter((pkg) => pkg.manifest.private !== true);

if (command === 'sync') {
  syncVersions();
} else {
  for (const pkg of publicPackages) {
    if (pkg.manifest.version !== version) {
      throw new Error(
        `${pkg.manifest.name}@${pkg.manifest.version} must match agent-device@${version}. Run release-version.mjs stamp first.`,
      );
    }
  }
  checkInstallHints();
  packWorkspacePackages();
}

/**
 * Fails when a plugin install hint the core prints names a package this release would not publish.
 * Core's absence messages and help say `agent-device plugins add @agent-device/<name>` for every
 * family and provider moved out of it (#4866), so a hint whose package stays `"private": true`
 * ships a command that cannot resolve. `release-install-hints.ts` reads the hint catalogs from
 * source; this compares them with the manifests the pack step below turns into tarballs.
 */
function checkInstallHints() {
  const hints = execFileSync(
    process.execPath,
    ['--experimental-strip-types', path.join(root, 'scripts', 'release-install-hints.ts')],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);
  const publishedNames = new Set(publicPackages.map((pkg) => pkg.manifest.name));
  const unpublished = hints.filter((name) => !publishedNames.has(name));
  if (unpublished.length > 0) {
    throw new Error(
      `Install hints name ${unpublished.join(', ')}, which this release does not publish. Remove "private": true from those packages before cutting a release.`,
    );
  }
}

function syncVersions() {
  for (const pkg of publicPackages) {
    if (pkg.manifest.version === version) continue;
    pkg.manifest.version = version;
    fs.writeFileSync(pkg.manifestPath, `${JSON.stringify(pkg.manifest, null, 2)}\n`);
  }
}

function packWorkspacePackages() {
  const destination = path.join(root, '.tmp', 'release');
  fs.mkdirSync(destination, { recursive: true });
  for (const pkg of publicPackages) {
    const tarball = path.join(
      destination,
      `${pkg.manifest.name.replace('@', '').replace('/', '-')}-${version}.tgz`,
    );
    if (pkg.directory !== root) {
      execFileSync('pnpm', ['pack', '--out', tarball], { cwd: pkg.directory, stdio: 'inherit' });
    }
    const packed = JSON.parse(
      execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }),
    );
    checkPackedIdentity(packed, pkg.manifest.name);
    checkPublishedDependencies(packed);
  }
}

function checkPublishedDependencies(packed) {
  const unpublishableNames = new Set(
    packages.filter((pkg) => pkg.manifest.private === true).map((pkg) => pkg.manifest.name),
  );
  // A provider plugin exports its factory as `./agent-device` and imports only types from
  // agent-device, so it must never carry the core as a runtime dependency. The root and `main`
  // loading fallbacks stay a loader convenience; a published plugin package names `./agent-device`.
  if (packed.exports && Object.hasOwn(packed.exports, './agent-device'))
    unpublishableNames.add(rootPackage.manifest.name);
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    checkDependencyField(field, packed[field] ?? {}, unpublishableNames);
  }
}

function checkDependencyField(field, dependencies, unpublishableNames) {
  for (const [name, specifier] of Object.entries(dependencies)) {
    if (
      unpublishableNames.has(name) ||
      /^(workspace:|file:|link:|portal:|catalog:|git\+file:|[./])/.test(specifier)
    ) {
      throw new Error(`${field}.${name} is not a publishable runtime dependency.`);
    }
  }
}

function checkPackedIdentity(packed, name) {
  if (packed.name !== name || packed.version !== version || packed.private === true) {
    throw new Error('Packed package identity differs from the synchronized public package.');
  }
}
