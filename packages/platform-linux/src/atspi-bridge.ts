/**
 * The AT-SPI2 capture route: shells out to a Python helper that uses PyGObject to traverse the
 * accessibility tree.
 *
 * This avoids the fragile node-gtk native addon (ABI mismatches, compilation on CI) in favour of
 * python3-gi, which is the reference GObject Introspection consumer and is trivially available on
 * every Linux distribution. The helper ships with this package, and every command here runs through
 * the host the plugin was set up with, so the capture appears in the request's exec trace.
 */

import { AppError } from '@agent-device/kernel/errors';
import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import { hostPlatform } from '@agent-device/host-kit/process';
import type { LinuxAccessibilityProvider } from '@agent-device/contracts/linux-tool-provider';
import { normalizeAtspiRole } from './role-map.ts';
import type { LinuxCommandRunner } from './command-runner.ts';
import { resolveLinuxAtspiScriptPath } from './atspi-script.ts';

/** Limits matching the macOS helper's SnapshotTraversalLimits. */
const MAX_DESKTOP_APPS = 24;
const MAX_NODES = 1500;
const MAX_DEPTH = 12;
const ATSPI_TIMEOUT_MS = 30_000;

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

export function createLinuxAccessibilityProvider(
  commands: LinuxCommandRunner,
): LinuxAccessibilityProvider {
  return {
    async captureTree(surface, options = {}) {
      if (hostPlatform() !== 'linux') {
        throw new AppError('UNSUPPORTED_PLATFORM', 'AT-SPI2 bridge is only available on Linux');
      }

      if (!(await commands.which('python3'))) {
        throw new AppError(
          'TOOL_MISSING',
          'python3 is required for AT-SPI2 accessibility snapshots on Linux.',
        );
      }

      const args = [
        resolveLinuxAtspiScriptPath(),
        '--surface',
        surface,
        '--max-nodes',
        String(options.maxNodes ?? MAX_NODES),
        '--max-depth',
        String(options.maxDepth ?? MAX_DEPTH),
        '--max-apps',
        String(options.maxApps ?? MAX_DESKTOP_APPS),
      ];

      const result = await commands.run('python3', args, {
        allowFailure: true,
        timeoutMs: ATSPI_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
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

      return { nodes, truncated: parsed.truncated, surface };
    },
  };
}
