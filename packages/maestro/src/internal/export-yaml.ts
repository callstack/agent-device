import { stringify } from 'yaml';

export function stringifyMaestroYamlDocuments(documents: readonly unknown[]): string {
  return `${documents.map((document) => stringify(document).trimEnd()).join('\n---\n')}\n`;
}
