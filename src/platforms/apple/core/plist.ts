import { promises as fs } from 'node:fs';
import { readApplePlistJson, runAppleToolCommand } from './tool-provider.ts';
import { parseXmlDocumentSync, visitXmlPlistEntries } from './xml.ts';

export async function readInfoPlistString(
  infoPlistPath: string,
  key: string,
): Promise<string | undefined> {
  try {
    const plist = await readApplePlistJson(infoPlistPath);
    const value = plist?.[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  } catch {
    // Fall through to XML parsing for non-Darwin environments without plist tooling.
  }

  try {
    const result = await runAppleToolCommand(
      'plutil',
      ['-extract', key, 'raw', '-o', '-', infoPlistPath],
      {
        allowFailure: true,
      },
    );
    if (result.exitCode === 0) {
      const value = String(result.stdout ?? '').trim();
      if (value.length > 0) {
        return value;
      }
    }
  } catch {
    // Fall through to XML parsing for non-Darwin environments without plutil.
  }

  try {
    const plist = await fs.readFile(infoPlistPath, 'utf8');
    return readXmlPlistString(plist, key);
  } catch {
    return undefined;
  }
}

function readXmlPlistString(plist: string, key: string): string | undefined {
  let result: string | undefined;
  visitXmlPlistEntries(parseXmlDocumentSync(plist), (entryKey, valueNode) => {
    if (result !== undefined || entryKey !== key || valueNode.name !== 'string') {
      return;
    }
    result = valueNode.text ?? undefined;
  });
  return result;
}
