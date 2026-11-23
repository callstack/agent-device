import { readHostTextFile } from '@agent-device/host-kit/host-file';
import { parseXmlDocumentSync, visitXmlPlistEntries } from '@agent-device/xml';
import type { PlistValue } from 'plist';
import {
  APPLE_PLIST_TIMEOUT_MS,
  readApplePlistJson,
  runAppleToolCommand,
} from './tool-provider.ts';

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
        timeoutMs: APPLE_PLIST_TIMEOUT_MS,
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

/** Parses downloaded app metadata on hosts without Apple's plist tools. */
export async function parseApplePlist(bytes: Uint8Array): Promise<Record<string, unknown> | null> {
  const { value } = await readApplePlist(bytes);
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A binary or XML plist's value, with the format it was stored in so a rewrite can keep it. */
export async function readApplePlist(
  bytes: Uint8Array,
): Promise<{ format: 'binary' | 'xml'; value: PlistValue }> {
  const { parse } = await import('plist');
  const binary = new TextDecoder().decode(bytes.subarray(0, 8)) === 'bplist00';
  return {
    format: binary ? 'binary' : 'xml',
    value: parse(binary ? bytes : new TextDecoder().decode(bytes)),
  };
}
