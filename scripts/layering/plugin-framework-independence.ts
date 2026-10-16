// Catches: `@agent-device/plugins` — the manifest, store, host and loader every provider plugin
//   runs under — acquiring a dependency on a concrete provider package, whether as a manifest entry
//   or as a static, type-only, dynamic or `vi.mock` import. Bundled-provider knowledge (which ids
//   plugins may not claim, how a `{ webDriver }` factory result becomes a runtime) belongs to the
//   composition that selects providers, which hands it to the loader as a policy.
// Evidence: #3712 extracted the loader with `provider-webdriver` still imported by its manifest and
//   loader; the provider-independence follow-up moved that knowledge to src/provider-plugin-policy.ts.
// Cost: one pass over the tracked manifests and the plugins package's sources.
// Kill criterion: a maintainer decision that the plugin framework may depend on a concrete
//   provider, or that provider-* packages stop being the unit of provider implementation.
//
// The forbidden set is derived from the workspace layout, not from name patterns: every package
// under `packages/provider-*`, whatever name it publishes (e.g. `@agent-device/testmu`).

import type { LayeringViolation } from './model.ts';
import { specifierSites } from './package-boundaries.ts';

export const PLUGIN_FRAMEWORK_INDEPENDENCE_RULE = 'R85 plugin-framework-independence';

const PLUGINS_DIR = 'packages/plugins';
const PROVIDER_MANIFEST = /^packages\/provider-[^/]+\/package\.json$/;

type DependencyManifest = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

function declaredNames(manifest: DependencyManifest): string[] {
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ];
}

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

function violation(file: string, line: number, message: string): LayeringViolation {
  return { rule: PLUGIN_FRAMEWORK_INDEPENDENCE_RULE, file, line, message };
}

/** The plugin framework package declares and imports no `packages/provider-*` package. */
export function checkPluginFrameworkIndependence(
  manifests: ReadonlyMap<string, string>,
  sources: ReadonlyMap<string, string>,
): LayeringViolation[] {
  const providers = new Set<string>();
  for (const [file, text] of manifests) {
    const { name } = JSON.parse(text) as DependencyManifest;
    if (PROVIDER_MANIFEST.test(file) && name) providers.add(name);
  }

  const violations: LayeringViolation[] = [];
  const pluginsManifest = `${PLUGINS_DIR}/package.json`;
  const manifest = manifests.get(pluginsManifest);
  for (const name of manifest ? declaredNames(JSON.parse(manifest) as DependencyManifest) : []) {
    if (providers.has(name)) {
      violations.push(
        violation(
          pluginsManifest,
          1,
          `${name} is a provider package; the plugin framework must not declare it. ` +
            `Provider knowledge reaches the loader as a policy from the composing root.`,
        ),
      );
    }
  }
  for (const [file, source] of sources) {
    if (!file.startsWith(`${PLUGINS_DIR}/`)) continue;
    for (const site of specifierSites(file, source)) {
      if (!providers.has(packageName(site.specifier))) continue;
      violations.push(
        violation(
          file,
          site.line,
          `${site.specifier} is a provider package; the plugin framework must not import it ` +
            `(static, type-only, dynamic or mocked). Pass provider knowledge in as a policy from the composing root.`,
        ),
      );
    }
  }
  return violations;
}
