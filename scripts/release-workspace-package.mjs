import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Prepare one independently versioned public package; never publish from this command. */
export function prepareWorkspacePackage(root, packageName, version, tag = 'latest') {
  const packages = fs
    .readdirSync(path.join(root, 'packages'), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        fs.existsSync(path.join(root, 'packages', entry.name, 'package.json')),
    )
    .map((entry) => {
      const directory = path.join(root, 'packages', entry.name);
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
      return { directory, manifest };
    });
  const { directory } = selectReleasePackage(packages, packageName, version, tag);

  const releases = path.join(root, '.tmp');
  fs.mkdirSync(releases, { recursive: true });
  const tarball = path.join(
    fs.mkdtempSync(path.join(releases, 'workspace-release-')),
    'package.tgz',
  );
  execFileSync('pnpm', ['pack', '--out', tarball], { cwd: directory, stdio: 'inherit' });
  const packed = JSON.parse(
    execFileSync('tar', ['-xOf', tarball, 'package/package.json'], {
      encoding: 'utf8',
    }),
  );
  if (packed.name !== packageName || packed.version !== version || packed.private !== false) {
    throw new Error('Packed package identity differs from the selected public package.');
  }
  checkPublishedDependencies(packed, packages);
  return tarball;
}

function selectReleasePackage(packages, packageName, version, tag) {
  const selected = packages.filter(({ manifest }) => manifest.name === packageName);
  if (selected.length !== 1) {
    throw new Error(`Expected exactly one workspace package named ${packageName}.`);
  }
  const { directory, manifest } = selected[0];
  if (manifest.private !== false) {
    throw new Error(`${packageName} must explicitly set private: false to opt into publishing.`);
  }
  if (manifest.version !== version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(
      `Requested version ${version} does not match a release version in ${packageName}.`,
    );
  }
  if (!['latest', 'next'].includes(tag) || (tag === 'latest' && version.includes('-'))) {
    throw new Error('Use latest for stable releases or next for prereleases.');
  }

  return { directory, manifest };
}

function checkPublishedDependencies(packed, packages) {
  const unpublishableNames = new Set(
    packages.filter((pkg) => pkg.manifest.private !== false).map((pkg) => pkg.manifest.name),
  );
  if (packed.agentDevicePlugin) unpublishableNames.add('agent-device');
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, specifier] of Object.entries(packed[field] ?? {})) {
      if (
        unpublishableNames.has(name) ||
        /^(workspace:|file:|link:|catalog:|git\+file:|[./])/.test(specifier)
      ) {
        throw new Error(`${field}.${name} is not a publishable runtime dependency.`);
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [packageName, version, tag = 'latest', ...extra] = process.argv.slice(2);
  if (!packageName || !version || extra.length > 0) {
    throw new Error('Usage: pnpm release:workspace <package-name> <version> [latest|next]');
  }
  const tarball = prepareWorkspacePackage(
    path.resolve(import.meta.dirname, '..'),
    packageName,
    version,
    tag,
  );
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `tarball=${tarball}\n`);
  }
  process.stdout.write(`Prepared ${packageName}@${version}: ${tarball}\n`);
}
