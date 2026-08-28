import type { XmlNode } from '@agent-device/xml';

export function visitXmlPlistEntries(
  nodes: XmlNode[],
  visitor: (key: string, valueNode: XmlNode) => void,
): void {
  for (const node of nodes) {
    if (node.name === 'dict') {
      for (let index = 0; index < node.children.length - 1; index += 1) {
        const entry = node.children[index];
        const nextEntry = node.children[index + 1];
        if (entry?.name === 'key' && entry.text && nextEntry) {
          visitor(entry.text, nextEntry);
        }
      }
    }
    visitXmlPlistEntries(node.children, visitor);
  }
}
