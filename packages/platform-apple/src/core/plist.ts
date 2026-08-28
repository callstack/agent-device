import { readHostTextFile } from '@agent-device/host-kit/host-file';
import { parseXmlDocumentSync } from '@agent-device/xml';
import { readApplePlistJson, runAppleToolCommand } from './tool-provider.ts';
import { visitXmlPlistEntries } from './plist-xml.ts';

export async function readInfoPlistString(
  infoPlistPath: string,
  key: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const plist = await readApplePlistJson(infoPlistPath, signal);
    const value = plist?.[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  } catch {
    signal?.throwIfAborted();
    // Fall through to XML parsing for non-Darwin environments without plist tooling.
  }

  try {
    const result = await runAppleToolCommand(
      'plutil',
      ['-extract', key, 'raw', '-o', '-', infoPlistPath],
      {
        allowFailure: true,
        signal,
      },
    );
    if (result.exitCode === 0) {
      const value = result.stdout.trim();
      if (value.length > 0) {
        return value;
      }
    }
  } catch {
    signal?.throwIfAborted();
    // Fall through to XML parsing for non-Darwin environments without plutil.
  }

  try {
    const plist = await readHostTextFile(infoPlistPath, { signal });
    return readXmlPlistString(plist, key);
  } catch {
    signal?.throwIfAborted();
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
