import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';
import type { AppleToolCommandExecutor } from '../../core/tool-provider-types.ts';
import type { ExecResult } from '@agent-device/host-kit/command';

// App discovery stats each candidate root through the host-file seam and asks that seam for the
// home directory whose `Applications` folder is the third root. Those two are the only effects
// mocked here: which roots exist is a host fact a Linux coverage runner cannot answer the way
// macOS does, so the test declares them. Every `find` and every Info.plist read is driven
// through the executor and plist-reader arguments the provider factory itself takes.
const hostFileState = vi.hoisted(() => ({
  home: '',
  directories: new Set<string>(),
  files: new Set<string>(),
}));

vi.mock('@agent-device/host-kit/host-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/host-file')>();
  return {
    ...actual,
    hostHomeDirectory: () => hostFileState.home,
    hostFileStat: async (filePath: string) => {
      if (hostFileState.directories.has(filePath)) {
        return { isDirectory: () => true } as fs.Stats;
      }
      if (hostFileState.files.has(filePath)) {
        return { isDirectory: () => false } as fs.Stats;
      }
      const error = new Error(
        `ENOENT: no such file or directory, stat '${filePath}'`,
      ) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    },
  };
});

import { createLocalAppleMacOsHostProvider } from './host-provider.ts';

type PlistReader = (plistPath: string) => Promise<Record<string, unknown> | null>;

let findCalls: string[] = [];

/** The bundle a candidate Info.plist path belongs to, for fixtures keyed by bundle path. */
function bundlePathFromPlist(plistPath: string): string {
  return plistPath.endsWith('Contents/Info.plist')
    ? path.dirname(path.dirname(plistPath))
    : path.dirname(plistPath);
}

function bundleName(plistPath: string): string {
  return path.basename(bundlePathFromPlist(plistPath), '.app');
}

/**
 * A scratch home for one run of `listApps`, so the user root is a path the test controls.
 * Nothing is written under it; the `hostFileStat` mock above answers its existence.
 */
async function scratchHome(): Promise<string> {
  const home = await mkdtempForTest('macos-host-home-');
  hostFileState.home = home;
  return home;
}

function recordingRunCommand(params: {
  findLinesByRoot?: Record<string, string[]>;
  failingRoots?: readonly string[];
}): AppleToolCommandExecutor {
  return async (cmd, args): Promise<ExecResult> => {
    if (cmd === 'find' && args[1] === '-maxdepth') {
      const root = args[0]!;
      findCalls.push(root);
      if (params.failingRoots?.includes(root)) {
        return { stdout: '', stderr: `find: ${root}: Operation not permitted`, exitCode: 1 };
      }
      return {
        stdout: (params.findLinesByRoot?.[root] ?? []).join('\n'),
        stderr: '',
        exitCode: 0,
      };
    }
    throw new Error(`The macOS host provider must not run ${cmd} ${args.join(' ')} in a test`);
  };
}

async function listApps(params: {
  filter: 'user-installed' | 'all';
  findLinesByRoot?: Record<string, string[]>;
  failingRoots?: readonly string[];
  readPlistJson: PlistReader;
}): Promise<{ bundleId: string; name: string }[]> {
  const provider = createLocalAppleMacOsHostProvider(
    recordingRunCommand({
      findLinesByRoot: params.findLinesByRoot,
      failingRoots: params.failingRoots,
    }),
    params.readPlistJson,
  );
  return await provider.listApps(params.filter);
}

afterEach(() => {
  findCalls = [];
  hostFileState.home = '';
  hostFileState.directories.clear();
  hostFileState.files.clear();
});

test('listApps walks every present root, normalizes find output, and sorts resolved apps by name', async () => {
  const home = await scratchHome();
  const userApplications = path.join(home, 'Applications');
  hostFileState.directories.add('/Applications');
  hostFileState.directories.add('/System/Applications');
  hostFileState.directories.add(userApplications);

  const found = await listApps({
    filter: 'all',
    findLinesByRoot: {
      '/Applications': [
        '/Applications/Zeta.app',
        '/Applications/Alpha.app ',
        '',
        '   ',
        '/Applications/Beta.app',
      ],
      '/System/Applications': ['/System/Applications/Calc.app'],
      [userApplications]: [path.join(userApplications, 'Home.app')],
    },
    readPlistJson: async (plistPath) => {
      // Beta's first candidate misses, so its identity comes from the bundle-root plist.
      if (plistPath === '/Applications/Beta.app/Contents/Info.plist') {
        return null;
      }
      if (plistPath === '/Applications/Beta.app/Info.plist') {
        return { CFBundleIdentifier: ' com.beta.app ', CFBundleName: 'Beta Name' };
      }
      return { CFBundleIdentifier: `com.example.${bundleName(plistPath).toLowerCase()}` };
    },
  });

  // The blank and padded find lines resolve to real bundles only after trimming; Beta keeps the
  // padded identifier trimmed and the CFBundleName its bundle-root plist reports; the user
  // root's bundle is present; and the list sorts by resolved name, not by root order.
  assert.deepEqual(found, [
    { bundleId: 'com.example.alpha', name: 'Alpha' },
    { bundleId: 'com.beta.app', name: 'Beta Name' },
    { bundleId: 'com.example.calc', name: 'Calc' },
    { bundleId: 'com.example.home', name: 'Home' },
    { bundleId: 'com.example.zeta', name: 'Zeta' },
  ]);
  assert.deepEqual(findCalls, ['/Applications', '/System/Applications', userApplications]);
});

test('listApps probes each root independently: a non-directory root is never searched and a failing find contributes nothing', async () => {
  const home = await scratchHome();
  const userApplications = path.join(home, 'Applications');
  hostFileState.files.add('/Applications');
  hostFileState.directories.add('/System/Applications');
  hostFileState.directories.add(userApplications);

  const found = await listApps({
    filter: 'all',
    failingRoots: [userApplications],
    findLinesByRoot: {
      '/System/Applications': ['/System/Applications/Calc.app', '/System/Applications/Notes.app'],
    },
    readPlistJson: async (plistPath) => ({
      CFBundleIdentifier: `com.apple.${bundleName(plistPath).toLowerCase()}`,
      CFBundleName: bundleName(plistPath),
    }),
  });

  // `/Applications` is a plain file, so `find` never runs for it; the user root's find exits
  // non-zero, so its (hypothetical) hits are dropped; the one healthy root still resolves.
  assert.deepEqual(found, [
    { bundleId: 'com.apple.calc', name: 'Calc' },
    { bundleId: 'com.apple.notes', name: 'Notes' },
  ]);
  assert.deepEqual(findCalls, ['/System/Applications', userApplications]);
});

test('listApps finds nothing when no candidate root exists and reads no plist for it', async () => {
  await scratchHome();

  const found = await listApps({
    filter: 'all',
    findLinesByRoot: { '/Applications': ['/Applications/Any.app'] },
    readPlistJson: async () => {
      throw new Error('no bundle may exist without a root');
    },
  });

  assert.deepEqual(found, []);
  assert.deepEqual(findCalls, []);
});

test('listApps keeps only bundles whose plist carries an identifier and fails open on a plist read that throws', async () => {
  await scratchHome();
  hostFileState.directories.add('/Applications');
  const read: string[] = [];

  const found = await listApps({
    filter: 'all',
    findLinesByRoot: {
      '/Applications': [
        '/Applications/Anonymous.app',
        '/Applications/BlankId.app',
        '/Applications/Broken.app',
        '/Applications/NameOnly.app',
        '/Applications/Named.app',
        '/Applications/ObjectId.app',
      ],
    },
    readPlistJson: async (plistPath) => {
      read.push(plistPath);
      if (plistPath.includes('/Broken.app/')) {
        throw new Error('plutil died');
      }
      if (plistPath.includes('/Anonymous.app/')) {
        return null;
      }
      if (plistPath.includes('/NameOnly.app/')) {
        return { CFBundleDisplayName: 'A name without any identifier' };
      }
      if (plistPath.includes('/BlankId.app/')) {
        return { CFBundleIdentifier: '   ', CFBundleName: 'BlankId' };
      }
      if (plistPath.includes('/ObjectId.app/')) {
        return { CFBundleIdentifier: { not: 'a string' } };
      }
      return { CFBundleIdentifier: 'com.named.app' };
    },
  });

  // Broken.app's throw fails open to no identity; a display name, a blank identifier, and an
  // object-valued identifier are all identifiers absent; only a real string identifier survives,
  // named from the bundle basename because its plist carries no name.
  assert.deepEqual(found, [{ bundleId: 'com.named.app', name: 'Named' }]);
  // Both candidate locations are consulted before a bundle is given up on.
  assert.ok(read.includes('/Applications/Anonymous.app/Contents/Info.plist'));
  assert.ok(read.includes('/Applications/Anonymous.app/Info.plist'));
});

test('listApps hides Apple bundles for the user-installed filter and shows them for all', async () => {
  await scratchHome();
  hostFileState.directories.add('/Applications');
  const findLinesByRoot = {
    '/Applications': ['/Applications/MyTool.app', '/Applications/System Preferences.app'],
  };
  const readPlistJson: PlistReader = async (plistPath) =>
    plistPath.includes('/System Preferences.app/')
      ? {
          CFBundleIdentifier: 'com.apple.systempreferences',
          CFBundleDisplayName: 'System Settings',
        }
      : { CFBundleIdentifier: 'com.mytool.app', CFBundleName: 'MyTool' };

  const userInstalled = await listApps({
    filter: 'user-installed',
    findLinesByRoot,
    readPlistJson,
  });
  assert.deepEqual(userInstalled, [{ bundleId: 'com.mytool.app', name: 'MyTool' }]);

  const all = await listApps({ filter: 'all', findLinesByRoot, readPlistJson });
  assert.deepEqual(all, [
    { bundleId: 'com.mytool.app', name: 'MyTool' },
    { bundleId: 'com.apple.systempreferences', name: 'System Settings' },
  ]);
});
