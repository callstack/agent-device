import fs from 'node:fs';
import path from 'node:path';
import { readApplePlistJson } from './tool-provider.ts';
import { parseXmlDocumentSync, visitXmlPlistEntries, type XmlNode } from './xml.ts';
import { isRecord } from '../../utils/parsing.ts';

const XCTESTRUN_PRODUCT_REFERENCE_KEYS = new Set([
  'ProductPaths',
  'DependentProductPaths',
  'TestHostPath',
  'TestBundlePath',
  'UITargetAppPath',
]);

export async function resolveExistingXctestrunProductPaths(
  xctestrunPath: string,
): Promise<string[] | null> {
  const values = await resolveXctestrunProductReferences(xctestrunPath);
  if (!values || values.length === 0) {
    return null;
  }
  const testRoot = path.dirname(xctestrunPath);
  const resolvedPaths = new Set<string>();
  const hostProducts = collectResolvedTestHostProducts(values, testRoot);

  for (const resolvedPath of hostProducts.testRootPaths) {
    if (!fs.existsSync(resolvedPath)) {
      return null;
    }
    resolvedPaths.add(resolvedPath);
  }

  for (const resolvedPath of resolveTestHostRelativePaths(hostProducts)) {
    if (!resolvedPath) {
      return null;
    }
    resolvedPaths.add(resolvedPath);
  }

  return Array.from(resolvedPaths);
}

function collectResolvedTestHostProducts(
  values: readonly string[],
  testRoot: string,
): {
  testRootPaths: string[];
  hostRoots: string[];
  hostRelativePaths: string[];
} {
  const testRootPaths: string[] = [];
  const hostRoots = new Set<string>();
  const hostRelativePaths: string[] = [];

  for (const value of values) {
    if (value.startsWith('__TESTHOST__/')) {
      hostRelativePaths.push(value.slice('__TESTHOST__/'.length));
      continue;
    }
    if (!value.startsWith('__TESTROOT__/')) {
      continue;
    }
    const relativePath = value.slice('__TESTROOT__/'.length);
    testRootPaths.push(path.join(testRoot, relativePath));
    const appBundleRoot = extractAppBundleRoot(relativePath);
    if (appBundleRoot) {
      hostRoots.add(path.join(testRoot, appBundleRoot));
    }
  }

  return {
    testRootPaths,
    hostRoots: Array.from(hostRoots),
    hostRelativePaths,
  };
}

function resolveTestHostRelativePaths(products: {
  hostRoots: readonly string[];
  hostRelativePaths: readonly string[];
}): (string | null)[] {
  return products.hostRelativePaths.map((relativePath) => {
    const resolvedHostRoot = products.hostRoots.find((hostRoot) =>
      fs.existsSync(path.join(hostRoot, relativePath)),
    );
    return resolvedHostRoot ? path.join(resolvedHostRoot, relativePath) : null;
  });
}

async function resolveXctestrunProductReferences(xctestrunPath: string): Promise<string[] | null> {
  const parsed = await readApplePlistJson(xctestrunPath);
  if (parsed) {
    return resolveXctestrunProductReferencesFromJson(parsed);
  }
  if (process.platform === 'darwin') {
    // On real macOS runner builds, plutil should always be available. If it cannot parse the
    // file here, treat the xctestrun as unusable instead of masking a corrupt plist with a
    // best-effort regex fallback.
    return null;
  }
  try {
    // Keep a simple XML fallback only for non-macOS test environments where plutil is absent.
    return resolveXctestrunProductReferencesFromXml(fs.readFileSync(xctestrunPath, 'utf8'));
  } catch {
    return null;
  }
}

function resolveXctestrunProductReferencesFromJson(parsed: Record<string, unknown>): string[] {
  const values = new Set<string>();

  for (const target of [
    parsed,
    ...collectConfiguredTestTargets(parsed),
    ...collectLegacyTestTargets(parsed),
  ]) {
    for (const value of collectXctestrunProductReferenceValuesFromTarget(target)) {
      values.add(value);
    }
  }

  return Array.from(values);
}

function collectConfiguredTestTargets(parsed: Record<string, unknown>): Record<string, unknown>[] {
  const testConfigurations = parsed.TestConfigurations;
  if (!Array.isArray(testConfigurations)) {
    return [];
  }

  const targets: Record<string, unknown>[] = [];
  for (const config of testConfigurations) {
    if (!isRecord(config)) continue;
    const testTargets = config.TestTargets;
    if (Array.isArray(testTargets)) {
      targets.push(...testTargets.filter(isRecord));
    }
  }
  return targets;
}

function collectLegacyTestTargets(parsed: Record<string, unknown>): Record<string, unknown>[] {
  return Object.values(parsed).filter(
    (value): value is Record<string, unknown> => isRecord(value) && 'TestBundlePath' in value,
  );
}

function collectXctestrunProductReferenceValuesFromTarget(
  target: Record<string, unknown>,
): string[] {
  const values = new Set<string>();
  for (const [key, value] of Object.entries(target)) {
    if (!XCTESTRUN_PRODUCT_REFERENCE_KEYS.has(key)) {
      continue;
    }
    if (typeof value === 'string') {
      values.add(value);
      continue;
    }
    if (!Array.isArray(value)) {
      continue;
    }
    for (const item of value) {
      if (typeof item === 'string') {
        values.add(item);
      }
    }
  }
  return Array.from(values);
}

function resolveXctestrunProductReferencesFromXml(contents: string): string[] {
  return collectXctestrunXmlProductReferenceValues(parseXmlDocumentSync(contents));
}

function collectXctestrunXmlProductReferenceValues(nodes: XmlNode[]): string[] {
  const values = new Set<string>();
  visitXmlPlistEntries(nodes, (key, valueNode) => {
    if (!XCTESTRUN_PRODUCT_REFERENCE_KEYS.has(key)) {
      return;
    }
    if (valueNode.name === 'string' && valueNode.text) {
      values.add(valueNode.text);
      return;
    }
    if (valueNode.name !== 'array') {
      return;
    }
    for (const child of valueNode.children) {
      if (child.name === 'string' && child.text) {
        values.add(child.text);
      }
    }
  });
  return Array.from(values);
}

function extractAppBundleRoot(relativePath: string): string | null {
  const match = /\.app(?:\/|$)/.exec(relativePath);
  if (!match || match.index === undefined) {
    return null;
  }
  return relativePath.slice(0, match.index + '.app'.length);
}
