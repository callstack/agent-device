import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import type { LinuxToolProvider } from '@agent-device/contracts/linux-tool-provider';
import type { LinuxToolbox } from './toolbox.ts';
import type { SessionSurface } from '@agent-device/contracts/session';

/**
 * Map the session-level surface to an AT-SPI2 surface.
 * Linux supports 'desktop' and 'frontmost-app'. The 'app' surface
 * (used for in-app XCTest sessions) is treated as 'frontmost-app' on Linux.
 * The 'menubar' surface is not yet supported; it falls back to 'desktop'.
 */
function resolveLinuxSurface(
  toolbox: LinuxToolbox,
  surface: SessionSurface | undefined,
): 'desktop' | 'frontmost-app' {
  if (surface === 'desktop') return 'desktop';
  if (surface === 'frontmost-app' || surface === 'app') return 'frontmost-app';
  if (surface === 'menubar') {
    toolbox.commands.diagnose({
      level: 'warn',
      phase: 'linux_snapshot',
      data: { message: 'menubar surface is not supported on Linux, falling back to desktop' },
    });
  }
  return 'desktop';
}

export async function snapshotLinux(
  toolbox: LinuxToolbox,
  provider: LinuxToolProvider,
  surface: SessionSurface | undefined,
  signal?: AbortSignal,
): Promise<{
  nodes: RawSnapshotNode[];
  truncated?: boolean;
}> {
  const linuxSurface = resolveLinuxSurface(toolbox, surface);
  const result = await provider.accessibility!.captureTree(linuxSurface, { signal });

  return {
    nodes: [...result.nodes],
    truncated: result.truncated,
  };
}

export async function readLinuxTextAtPoint(
  toolbox: LinuxToolbox,
  provider: LinuxToolProvider,
  x: number,
  y: number,
  surface: SessionSurface | undefined,
): Promise<string> {
  const { nodes } = await snapshotLinux(toolbox, provider, surface);
  const matches = nodes
    .filter((node) => {
      const rect = node.rect;
      if (!rect) return false;
      return x >= rect.x && y >= rect.y && x <= rect.x + rect.width && y <= rect.y + rect.height;
    })
    .sort((left, right) => {
      const leftDepth = left.depth ?? 0;
      const rightDepth = right.depth ?? 0;
      if (leftDepth !== rightDepth) return rightDepth - leftDepth;
      return rectArea(left.rect) - rectArea(right.rect);
    });

  for (const node of matches) {
    const text = extractReadText(node);
    if (text.trim()) return text;
  }
  return '';
}

function rectArea(rect: RawSnapshotNode['rect']): number {
  return (rect?.width ?? 0) * (rect?.height ?? 0);
}

function extractReadText(node: RawSnapshotNode): string {
  for (const value of [node.value, node.label, node.identifier]) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}
