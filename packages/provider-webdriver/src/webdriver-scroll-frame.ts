import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import type { WebDriverWindowRect } from './webdriver-client.ts';
import { parseWebDriverSourceFacts } from './webdriver-source.ts';

export async function scrollFrameFromAndroidWebDriverSource(
  source: string,
): Promise<WebDriverWindowRect | undefined> {
  return scrollFrameFromNodes(parseWebDriverSourceFacts(source, 'android').nodes);
}

export function scrollFrameFromIosWebDriverSource(source: string): WebDriverWindowRect | undefined {
  return scrollFrameFromNodes(parseWebDriverSourceFacts(source).nodes);
}

function scrollFrameFromNodes(nodes: RawSnapshotNode[]): WebDriverWindowRect | undefined {
  const rect = nodes
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
