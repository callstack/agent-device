import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCmdDetached } from './exec.ts';

const PACKAGE_NAME = 'agent-device';
const UPDATE_CHECK_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 3500;
const UPDATE_CHECK_ARG = '--agent-device-run-update-check';
const UPDATE_CHECK_CACHE_FILE = 'update-check.json';

type UpdateCheckCache = {
  checkedAt?: string;
  latestVersion?: string;
  prompted?: boolean;
};

export type UpgradeNotifierOptions = {
  command: string | null;
  currentVersion: string;
  stateDir: string;
  flags: {
    help?: boolean;
    json?: boolean;
    version?: boolean;
  };
};

type UpdateCheckWorkerOptions = {
  cachePath: string;
  currentVersion: string;
};

export function maybeRunUpgradeNotifier(options: UpgradeNotifierOptions): void {
  if (!shouldEnableUpgradeNotifier(options)) return;

  const now = Date.now();
  const cachePath = path.join(options.stateDir, UPDATE_CHECK_CACHE_FILE);
  const cache = readUpdateCheckCache(cachePath);

  if (shouldShowUpgradeNotice(cache, options.currentVersion)) {
    process.stderr.write(
      `Update available: ${PACKAGE_NAME} ${options.currentVersion} -> ${cache.latestVersion}. ` +
        `Run \`npm install -g ${PACKAGE_NAME}@latest\` to upgrade the CLI.\n`,
    );
    writeUpdateCheckCache(cachePath, {
      ...cache,
      prompted: true,
    });
  }

  if (shouldStartBackgroundCheck(cache, now)) {
    spawnBackgroundUpdateCheck(cachePath, options.currentVersion);
  }
}

export async function runUpdateCheckWorker(options: UpdateCheckWorkerOptions): Promise<void> {
  const now = Date.now();
  const cache = readUpdateCheckCache(options.cachePath);

  try {
    const latestVersion = (await fetchLatestPackageVersion()) ?? undefined;
    if (!latestVersion || compareVersions(latestVersion, options.currentVersion) <= 0) {
      writeUpdateCheckCache(options.cachePath, { checkedAt: new Date(now).toISOString() });
      return;
    }

    writeUpdateCheckCache(options.cachePath, {
      checkedAt: new Date(now).toISOString(),
      latestVersion,
      prompted: cache.latestVersion === latestVersion ? cache.prompted === true : false,
    });
  } catch {
    writeUpdateCheckCache(options.cachePath, {
      ...cache,
      checkedAt: new Date(now).toISOString(),
    });
  }
}

function shouldEnableUpgradeNotifier(options: UpgradeNotifierOptions): boolean {
  if (!options.command) return false;
  if (options.command === 'help' || options.command === 'test') return false;
  if (options.flags.help || options.flags.version || options.flags.json) return false;
  if (process.env.CI?.trim()) return false;
  if (process.env.NODE_ENV === 'test') return false;
  if (process.env.AGENT_DEVICE_NO_UPDATE_NOTIFIER?.trim()) return false;
  return Boolean(process.stderr.isTTY);
}

function shouldShowUpgradeNotice(cache: UpdateCheckCache, currentVersion: string): boolean {
  if (!cache.latestVersion) return false;
  if (compareVersions(cache.latestVersion, currentVersion) <= 0) return false;
  return cache.prompted !== true;
}

function shouldStartBackgroundCheck(cache: UpdateCheckCache, now: number): boolean {
  const checkedAt = parseTimestamp(cache.checkedAt);
  return checkedAt === undefined || now - checkedAt >= UPDATE_CHECK_INTERVAL_MS;
}

function readUpdateCheckCache(cachePath: string): UpdateCheckCache {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as UpdateCheckCache;
    return {
      checkedAt: typeof raw.checkedAt === 'string' ? raw.checkedAt : undefined,
      latestVersion: typeof raw.latestVersion === 'string' ? raw.latestVersion : undefined,
      prompted: raw.prompted === true,
    };
  } catch {
    return {};
  }
}

function writeUpdateCheckCache(cachePath: string, cache: UpdateCheckCache): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  } catch {
    // Best effort only.
  }
}

function resolveUpdateCheckEntryModulePath(): string {
  const currentModulePath = fileURLToPath(import.meta.url);
  const extension = path.extname(currentModulePath) || '.js';
  const entryPaths = [
    path.join(path.dirname(currentModulePath), `update-check-entry${extension}`),
    path.join(path.dirname(currentModulePath), 'internal', `update-check-entry${extension}`),
  ];
  const entryPath = entryPaths.find((candidate) => fs.existsSync(candidate));
  if (!entryPath) {
    throw new Error(
      'Update check entrypoint not found. Rebuild the package to include the update-check worker entry.',
    );
  }
  return entryPath;
}

function spawnBackgroundUpdateCheck(cachePath: string, currentVersion: string): void {
  const modulePath = resolveUpdateCheckEntryModulePath();
  const execArgs = modulePath.endsWith('.ts') ? ['--experimental-strip-types'] : [];
  runCmdDetached(process.execPath, [
    ...execArgs,
    modulePath,
    UPDATE_CHECK_ARG,
    cachePath,
    currentVersion,
  ]);
}

async function fetchLatestPackageVersion(): Promise<string | undefined> {
  const response = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
    signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) return undefined;

  const payload = (await response.json()) as { version?: unknown };
  return typeof payload.version === 'string' && payload.version.trim().length > 0
    ? payload.version.trim()
    : undefined;
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function compareVersions(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}

export function readUpdateCheckWorkerArgs(
  argv: string[],
): { cachePath: string; currentVersion: string } | null {
  if (argv[0] !== UPDATE_CHECK_ARG) return null;
  const cachePath = argv[1]?.trim();
  const currentVersion = argv[2]?.trim();
  if (!cachePath || !currentVersion) return null;
  return { cachePath, currentVersion };
}
