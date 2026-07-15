/**
 * AT-SPI2 bridge — shells out to a Python helper that uses PyGObject
 * to traverse the accessibility tree.
 *
 * This avoids the fragile node-gtk native addon (ABI mismatches,
 * compilation on CI, etc.) in favour of python3-gi which is the
 * reference GObject Introspection consumer and is trivially available
 * on every Linux distro.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AppError } from '../../kernel/errors.ts';
import type { RawSnapshotNode, Rect } from '../../kernel/snapshot.ts';
import { normalizeAtspiRole } from './role-map.ts';
import { resolveLinuxToolProvider, runLinuxToolCommand } from './tool-provider.ts';
import type {
  LinuxAccessibilityTree,
  LinuxSnapshotSurface,
  LinuxTraversalOptions,
} from './accessibility-types.ts';

// ── Limits (matching macOS helper's SnapshotTraversalLimits) ────────────
const MAX_DESKTOP_APPS = 24;
const MAX_NODES = 1500;
const MAX_DEPTH = 12;

const SCRIPT_NAME = 'atspi-dump.py';

let cachedScriptPath: string | null = null;

/** Resolve atspi-dump.py, which lives under `linux/` at the repo/package root. */
function resolveScriptPath(): string {
  if (cachedScriptPath) return cachedScriptPath;
  const thisDir = path.dirname(fileURLToPath(import.meta.url));

  // Walk upward looking for linux/atspi-dump.py — handles both:
  //   <repo root>/linux/     (source; this module lives at src/platforms/linux/)
  //   <package root>/linux/  (bundled; this module lives under dist/src/)
  let dir = thisDir;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'linux', SCRIPT_NAME);
    if (fs.existsSync(candidate)) {
      cachedScriptPath = candidate;
      return candidate;
    }
    dir = path.dirname(dir);
  }

  throw new AppError(
    'TOOL_MISSING',
    `Cannot find ${SCRIPT_NAME}. Ensure the agent-device package is installed correctly.`,
  );
}

// ── Public types ────────────────────────────────────────────────────────

export type TraversalOptions = LinuxTraversalOptions;
export type SnapshotSurface = LinuxSnapshotSurface;

type PythonNode = {
  index: number;
  role: string;
  label?: string;
  value?: string;
  rect?: Rect;
  enabled?: boolean;
  selected?: boolean;
  hittable?: boolean;
  depth: number;
  parentIndex?: number;
  pid?: number;
  appName?: string;
  windowTitle?: string;
};

type PythonResult = {
  nodes: PythonNode[];
  truncated: boolean;
  surface: string;
  error?: string;
};

// ── Public API ──────────────────────────────────────────────────────────

export async function captureAccessibilityTree(
  surface: SnapshotSurface,
  options: TraversalOptions = {},
): Promise<LinuxAccessibilityTree> {
  const provider = resolveLinuxToolProvider().accessibility;
  if (provider) return await provider.captureTree(surface, options);

  if (process.platform !== 'linux') {
    throw new AppError('UNSUPPORTED_PLATFORM', 'AT-SPI2 bridge is only available on Linux');
  }

  if (!(await resolveLinuxToolProvider().whichCommand('python3'))) {
    throw new AppError(
      'TOOL_MISSING',
      'python3 is required for AT-SPI2 accessibility snapshots on Linux.',
    );
  }

  const maxNodes = options.maxNodes ?? MAX_NODES;
  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  const maxApps = options.maxApps ?? MAX_DESKTOP_APPS;

  const scriptPath = resolveScriptPath();
  const args = [
    scriptPath,
    '--surface',
    surface,
    '--max-nodes',
    String(maxNodes),
    '--max-depth',
    String(maxDepth),
    '--max-apps',
    String(maxApps),
  ];

  const result = await runLinuxToolCommand('python3', args, {
    allowFailure: true,
    timeoutMs: 30_000,
  });

  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    if (stderr.includes('No module named') || stderr.includes('gi.require_version')) {
      throw new AppError(
        'TOOL_MISSING',
        'AT-SPI2 Python bindings not found. Install python3-gi and gir1.2-atspi-2.0.',
        { cause: stderr },
      );
    }
    throw new AppError(
      'COMMAND_FAILED',
      `AT-SPI2 snapshot failed (exit ${result.exitCode}): ${stderr || result.stdout}`,
    );
  }

  let parsed: PythonResult;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new AppError(
      'COMMAND_FAILED',
      `AT-SPI2 snapshot returned invalid JSON: ${result.stdout.slice(0, 200)}`,
    );
  }

  if (parsed.error) {
    throw new AppError('COMMAND_FAILED', `AT-SPI2: ${parsed.error}`);
  }

  // Map Python output to RawSnapshotNode with normalized roles
  const nodes: RawSnapshotNode[] = (parsed.nodes ?? []).map((n) => ({
    index: n.index,
    type: normalizeAtspiRole(n.role),
    role: n.role,
    label: n.label ?? undefined,
    value: n.value ?? undefined,
    rect: n.rect ?? undefined,
    enabled: n.enabled ?? undefined,
    selected: n.selected ?? undefined,
    hittable: n.hittable ?? undefined,
    depth: n.depth,
    parentIndex: n.parentIndex ?? undefined,
    pid: n.pid ?? undefined,
    appName: n.appName ?? undefined,
    windowTitle: n.windowTitle ?? undefined,
  }));

  return {
    nodes,
    truncated: parsed.truncated,
    surface,
  };
}
