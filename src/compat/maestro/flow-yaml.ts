import { parseAllDocuments, stringify } from 'yaml';
import { AppError } from '../../kernel/errors.ts';

export function parseMaestroYamlDocuments(script: string): unknown[] {
  const documents = parseAllDocuments(script);
  for (const document of documents) {
    if (document.errors.length > 0) {
      const message = document.errors[0]?.message ?? 'Invalid Maestro YAML flow.';
      throw new AppError('INVALID_ARGS', `Invalid Maestro YAML flow: ${message}`);
    }
  }
  return documents
    .map((document) => document.toJSON() as unknown)
    .filter((value) => value !== null);
}

export function stringifyMaestroYamlDocuments(documents: readonly unknown[]): string {
  return `${documents.map((document) => stringify(document).trimEnd()).join('\n---\n')}\n`;
}
