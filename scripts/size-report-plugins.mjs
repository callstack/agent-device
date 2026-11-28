import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatBytes, formatDiff } from './size-report-format.mjs';
import { measureCleanInstalledPackage, measureDirectory } from './size-report-install.mjs';

export function measurePluginSizes(root, planPath) {
  const plugins = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  return plugins.map((plugin) => measurePlugin(root, plugin));
}

function measurePlugin(root, { name, directory }) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-plugin-size-'));
  try {
    const tarball = path.join(scratch, 'plugin.tgz');
    execFileSync('pnpm', ['pack', '--out', tarball], {
      cwd: path.join(root, directory),
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    execFileSync('tar', ['-xzf', tarball, '-C', scratch]);
    const packageDir = path.join(scratch, 'package');
    const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    if (manifest.name !== name) throw new Error(`Expected to pack ${name}, got ${manifest.name}.`);
    const unpackedBytes = measureDirectory(packageDir).packageBytes;
    return {
      name,
      unpackedBytes,
      tarballBytes: fs.statSync(tarball).size,
      installedBytes: measureCleanInstalledPackage(tarball, name).totalBytes,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export function formatPluginSizes(plugins, basePlugins = []) {
  const current = new Map(plugins.map((plugin) => [plugin.name, plugin]));
  const base = new Map(basePlugins.map((plugin) => [plugin.name, plugin]));
  const names = [...new Set([...current.keys(), ...base.keys()])].sort();
  if (names.length === 0) return '';
  const rows = names.map((name) => {
    const before = base.get(name);
    const after = current.get(name);
    const metrics = ['installedBytes', 'unpackedBytes', 'tarballBytes'];
    const cells = metrics.map((metric) => formatPluginMetric(before?.[metric], after?.[metric]));
    return `| \`${name}\` | ${cells.join(' | ')} |`;
  });
  return `### Affected plugins

| Plugin | Installed (including dependencies) | Unpacked | Download |
|---|---:|---:|---:|
${rows.join('\n')}

`;
}

function formatPluginMetric(base, current) {
  if (current === undefined) return `${formatBytes(base)} → removed`;
  if (base === undefined) return `${formatBytes(current)} (new)`;
  return `${formatBytes(base)} → ${formatBytes(current)} (${formatDiff(base, current)})`;
}
