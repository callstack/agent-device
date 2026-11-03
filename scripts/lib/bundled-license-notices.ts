import fs from 'node:fs';
import path from 'node:path';
import license, { type Dependency } from 'rollup-plugin-license';

/** Reads extra notices from root's LICENSES directory and emits them beside the bundle. */
export function bundledLicenseNotices(root: string): ReturnType<typeof license> {
  let source: string | undefined;
  const collector = license({
    cwd: root,
    sourcemap: false,
    thirdParty: {
      multipleVersions: true,
      output(dependencies) {
        source = renderNotices(root, dependencies);
      },
    },
  });
  // rollup-plugin-license 3.7.1 exposes synchronous dependency output without a bundler context.
  return {
    ...collector,
    async generateBundle(options, bundle, isWrite) {
      source = undefined;
      const hook = collector.generateBundle;
      const generate = typeof hook === 'function' ? hook : hook?.handler;
      await generate?.call(this, options, bundle, isWrite);
      if (source === undefined)
        this.error(
          'rollup-plugin-license did not report dependencies from generateBundle; expected its synchronous thirdParty.output callback.',
        );
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.txt', source });
    },
  };
}

/**
 * A bundled dependency must be attributable before it can be listed: `version` is optional to
 * `rollup-plugin-license` and reports `null` for a module whose `package.json` has none, which is what
 * an unresolvable or path-linked module looks like to it. Emitting `included@null (MIT)` would
 * attribute code to a release that never existed, so the version is named first and every later
 * diagnostic can name the package the way the notice file does.
 */
function assertBundledDependencyAttributable(dependency: Dependency): void {
  if (!dependency.version?.trim()) {
    throw new Error(`Bundled dependency ${dependency.name} is missing its version.`);
  }
  if (!dependency.license || !dependency.licenseText?.trim()) {
    throw new Error(
      `Bundled dependency ${dependency.name}@${dependency.version} is missing its license or license text.`,
    );
  }
}

function renderNotices(root: string, dependencies: readonly Dependency[]): string {
  if (dependencies.length === 0) return 'No third-party dependencies are bundled.\n';
  const texts = new Map<string, number>();
  const reference = (text: string): string => {
    const normalized = text.replaceAll('\r\n', '\n').trim();
    let id = texts.get(normalized);
    if (id === undefined) {
      id = texts.size + 1;
      texts.set(normalized, id);
    }
    return `[${id}]`;
  };
  const packages: string[] = [];
  const sortedDependencies = [...dependencies].sort((left, right) => {
    const a = `${left.name}@${left.version}`;
    const b = `${right.name}@${right.version}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (const dependency of sortedDependencies) {
    assertBundledDependencyAttributable(dependency);
    const references = [reference(dependency.licenseText)];
    if (dependency.noticeText?.trim()) references.push(reference(dependency.noticeText));
    if (dependency.name === 'jpeg-js') {
      const sourceNotices = fs.readFileSync(path.join(root, 'LICENSES/jpeg-js.txt'), 'utf8');
      const noticeVersion = sourceNotices
        .split(/\r?\n/, 1)[0]
        ?.match(/^jpeg-js (\S+) source-file notices$/)?.[1];
      if (noticeVersion !== dependency.version) {
        throw new Error(
          `Refresh LICENSES/jpeg-js.txt for bundled jpeg-js@${dependency.version}; its first line must name that version.`,
        );
      }
      references.push(
        reference(sourceNotices),
        reference(fs.readFileSync(path.join(root, 'LICENSES/Apache-2.0.txt'), 'utf8')),
      );
    }
    packages.push(
      `${dependency.name}@${dependency.version} (${dependency.license}): ${references.join(', ')}${dependency.author ? `; Author: ${dependency.author.text()}` : ''}`,
    );
  }
  // One trailing newline closes the last license block: the generic notice above carries one, and a
  // reader who `cat`s the file or counts its lines sees a finished file either way.
  const body = [packages.join('\n'), ...Array.from(texts, ([text, id]) => `[${id}]\n${text}`)].join(
    '\n\n',
  );
  return `${body}\n`;
}
