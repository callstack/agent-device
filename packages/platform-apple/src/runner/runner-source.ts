import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const APPLE_RUNNER_SOURCE_ROOT = path.join('apple', 'runner', 'AgentDeviceRunner');
const PACKAGED_APPLE_RUNNER_SOURCE_ROOT = path.join('dist', 'apple', 'runner', 'AgentDeviceRunner');
const APPLE_SNAPSHOT_PRESENTATION_SOURCE_ROOT = path.join('apple', 'snapshot-presentation');
const PACKAGED_APPLE_SNAPSHOT_PRESENTATION_SOURCE_ROOT = path.join(
  'dist',
  'apple',
  'snapshot-presentation',
);

export function resolveAppleRunnerSourceRoot(projectRoot: string): string {
  const checkoutSourceRoot = path.join(projectRoot, APPLE_RUNNER_SOURCE_ROOT);
  if (fs.existsSync(checkoutSourceRoot)) {
    return checkoutSourceRoot;
  }
  return path.join(projectRoot, PACKAGED_APPLE_RUNNER_SOURCE_ROOT);
}

export function resolveAppleRunnerProjectPath(projectRoot: string): string {
  return path.join(resolveAppleRunnerSourceRoot(projectRoot), 'AgentDeviceRunner.xcodeproj');
}

export function resolveAppleSnapshotPresentationSourceRoot(projectRoot: string): string {
  const checkoutSourceRoot = path.join(projectRoot, APPLE_SNAPSHOT_PRESENTATION_SOURCE_ROOT);
  if (fs.existsSync(checkoutSourceRoot)) {
    return checkoutSourceRoot;
  }
  return path.join(projectRoot, PACKAGED_APPLE_SNAPSHOT_PRESENTATION_SOURCE_ROOT);
}

const RUNNER_SOURCE_IGNORED_DIR_NAMES = new Set(['.build', '.swiftpm', 'xcuserdata']);
const SNAPSHOT_PRESENTATION_SOURCE_IGNORED_DIR_NAMES = new Set([
  '.build',
  '.swiftpm',
  'SnapshotPresentationConformance',
  'Tests',
  'xcuserdata',
]);

type RunnerSourceFingerprintCacheEntry = {
  fileStatsFingerprint: string;
  sourceFingerprint: string;
};

const runnerSourceFingerprintCache = new Map<string, RunnerSourceFingerprintCacheEntry>();

export function computeRunnerSourceFingerprint(projectRoot: string): string {
  const sourceRoots = [
    {
      path: resolveAppleRunnerSourceRoot(projectRoot),
      ignoredDirectoryNames: RUNNER_SOURCE_IGNORED_DIR_NAMES,
    },
    {
      path: resolveAppleSnapshotPresentationSourceRoot(projectRoot),
      ignoredDirectoryNames: SNAPSHOT_PRESENTATION_SOURCE_IGNORED_DIR_NAMES,
    },
  ];
  const files = collectRunnerSourceFiles(sourceRoots);
  const fileStatsFingerprint = computeRunnerSourceFileStatsFingerprint(projectRoot, files);
  const cacheKey = JSON.stringify(sourceRoots.map(({ path: sourcePath }) => sourcePath));
  const cached = runnerSourceFingerprintCache.get(cacheKey);
  if (cached?.fileStatsFingerprint === fileStatsFingerprint) {
    return cached.sourceFingerprint;
  }
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    const relativePath = path.relative(projectRoot, file);
    hash.update(relativePath);
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  const sourceFingerprint = hash.digest('hex');
  runnerSourceFingerprintCache.set(cacheKey, { fileStatsFingerprint, sourceFingerprint });
  return sourceFingerprint;
}

function computeRunnerSourceFileStatsFingerprint(
  projectRoot: string,
  files: readonly string[],
): string {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    const relativePath = path.relative(projectRoot, file);
    const stat = fs.statSync(file);
    hash.update(relativePath);
    hash.update('\0');
    hash.update(String(stat.size));
    hash.update('\0');
    hash.update(String(Math.trunc(stat.mtimeMs)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

type RunnerSourceRoot = Readonly<{
  path: string;
  ignoredDirectoryNames: ReadonlySet<string>;
}>;

function collectRunnerSourceFiles(roots: readonly RunnerSourceRoot[]): string[] {
  return [
    ...new Set(
      roots.flatMap(({ path: sourcePath, ignoredDirectoryNames }) =>
        collectRunnerSourceFilesUnderRoot(sourcePath, ignoredDirectoryNames),
      ),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

function collectRunnerSourceFilesUnderRoot(
  root: string,
  ignoredDirectoryNames: ReadonlySet<string>,
): string[] {
  return fs.existsSync(root)
    ? collectRunnerSourceFilesInDirectory(root, ignoredDirectoryNames, false)
    : [];
}

function collectRunnerSourceFilesInDirectory(
  directory: string,
  ignoredDirectoryNames: ReadonlySet<string>,
  includeEveryFile: boolean,
): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirectoryNames.has(entry.name)) continue;
      const nestedIncludeEveryFile = includeEveryFile || isXcodePackageDirectory(entry.name);
      files.push(
        ...collectRunnerSourceFilesInDirectory(
          fullPath,
          ignoredDirectoryNames,
          nestedIncludeEveryFile,
        ),
      );
    } else if (entry.isFile() && (includeEveryFile || isRunnerSourceFile(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Xcode owns the contents of a project or workspace package — `project.pbxproj`, shared
 * schemes, and workspace data all change what a build produces — so every file inside one
 * is build input, not just the ones with a recognizable extension.
 */
function isXcodePackageDirectory(directoryName: string): boolean {
  return directoryName.endsWith('.xcodeproj') || directoryName.endsWith('.xcworkspace');
}

const RUNNER_SOURCE_FILE_EXTENSIONS = new Set([
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
  '.xcscheme',
  '.xcworkspacedata',
]);

function isRunnerSourceFile(fileName: string): boolean {
  return RUNNER_SOURCE_FILE_EXTENSIONS.has(path.extname(fileName));
}
