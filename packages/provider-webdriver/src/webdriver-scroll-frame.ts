import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import type { WebDriverWindowRect } from './webdriver-client.ts';
import { parseWebDriverSource, type WebDriverSourceParseMode } from './webdriver-source.ts';

export function scrollFrameFromWebDriverSource(
  source: string,
  options: Readonly<{ mode: WebDriverSourceParseMode }>,
): WebDriverWindowRect | undefined {
  const rect = parseWebDriverSource(source, options)
    .flatMap((node) =>
      isScrollableSourceNode(node) && isUsableScrollRect(node.rect) ? [node.rect] : [],
    )
    .sort((left, right) => right.width * right.height - left.width * left.height)[0];
  return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : undefined;
}

function isScrollableSourceNode(node: RawSnapshotNode): boolean {
  const type = node.type?.toLowerCase() ?? '';
  return (
    node.visibleToUser !== false &&
    (type.includes('scrollview') || type.includes('listview') || type.includes('recyclerview'))
  );
}

function isUsableScrollRect(rect: RawSnapshotNode['rect']): rect is WebDriverWindowRect {
  return !!rect && rect.width >= 50 && rect.height >= 50;
}
