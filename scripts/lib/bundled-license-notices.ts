import fs from 'node:fs';
import path from 'node:path';
import type { TsdownPlugin } from 'tsdown';
import { renderLicenseNotices, type NoticeDependency } from '../size-report-package-notices.mjs';

type Manifest = {
  name?: unknown;
  version?: unknown;
  license?: unknown;
  author?: unknown;
  private?: unknown;
};

/**
 * Enumerates every module rendered into the bundle, attributes each third-party one to its package,
 * and emits the notices beside the bundle. Extra notices are read from root's LICENSES directory.
 */
export function bundledLicenseNotices(root: string): TsdownPlugin {
  return {
    name: 'bundled-license-notices',
    generateBundle(_options, bundle) {
      const packages = new Map<string, Manifest>();
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        for (const [id, module] of Object.entries(output.modules)) {
          if (module.renderedLength === 0) continue;
          const owner = thirdPartyPackage(root, id);
          if (owner) packages.set(owner.directory, owner.manifest);
        }
      }
      const dependencies = Array.from(packages, ([directory, manifest]) =>
        attributableDependency(root, directory, manifest),
      );
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD_PARTY_NOTICES.txt',
        source: renderLicenseNotices(deduplicate(dependencies)),
      });
    },
  };
}

function readManifest(directory: string): Manifest | undefined {
  const file = path.join(directory, 'package.json');
  if (!fs.existsSync(file)) return undefined;
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
  return typeof manifest.name === 'string' && manifest.name ? manifest : undefined;
}

/**
 * The package that owns a bundled module: the nearest `package.json` with a name. A `package.json`
 * without one only marks a module type. Root and private workspace packages are this project's code.
 * A module under `node_modules` must find its package before it leaves that `node_modules`.
 */
function thirdPartyPackage(
  root: string,
  moduleId: string,
): { directory: string; manifest: Manifest } | undefined {
  const file = moduleId.replace(/^\0/, '');
  if (!path.isAbsolute(file)) return undefined;
  for (let directory = path.dirname(file); directory !== root;) {
    const manifest = readManifest(directory);
    if (manifest) {
      const vendored = directory.split(path.sep).includes('node_modules');
      return manifest.private === true && !vendored ? undefined : { directory, manifest };
    }
    const parent = path.dirname(directory);
    if (path.basename(directory) === 'node_modules' || parent === directory) {
      throw new Error(
        `Bundled module ${path.relative(root, file)} has no package.json naming its package.`,
      );
    }
    directory = parent;
  }
  return undefined;
}

function readNamedFile(directory: string, prefix: RegExp): string | undefined {
  const name = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && prefix.test(entry.name))
    .map((entry) => entry.name)
    .sort()[0];
  const text = name === undefined ? undefined : fs.readFileSync(path.join(directory, name), 'utf8');
  return text?.trim() ? text : undefined;
}

function authorText(author: unknown): string | undefined {
  if (typeof author === 'string') return author.trim() || undefined;
  if (typeof author !== 'object' || author === null) return undefined;
  const { name, email, url } = author as Record<string, unknown>;
  if (typeof name !== 'string' || !name) return undefined;
  return `${name}${typeof email === 'string' && email ? ` <${email}>` : ''}${typeof url === 'string' && url ? ` (${url})` : ''}`;
}

/**
 * A bundled package must name its release, its license, and the license text before it is listed.
 * The version is checked first so every later diagnostic names the package as the notices do.
 */
function attributableDependency(
  root: string,
  directory: string,
  manifest: Manifest,
): NoticeDependency {
  const name = String(manifest.name);
  const version = typeof manifest.version === 'string' ? manifest.version.trim() : '';
  if (!version) throw new Error(`Bundled dependency ${name} is missing its version.`);
  const license = typeof manifest.license === 'string' ? manifest.license.trim() : '';
  const licenseText =
    readNamedFile(directory, /^licen[cs]e/i) ??
    (name === '@limrun/xdelta3-wasm' ? xdeltaLicenseText(root, version, license) : undefined);
  if (!license || !licenseText) {
    throw new Error(
      `Bundled dependency ${name}@${version} is missing its license or license text.`,
    );
  }
  const texts = [licenseText];
  const noticeText = readNamedFile(directory, /^notice/i);
  if (noticeText) texts.push(noticeText);
  if (name === 'jpeg-js') {
    const sourceNotices = fs.readFileSync(path.join(root, 'LICENSES/jpeg-js.txt'), 'utf8');
    const noticeVersion = sourceNotices
      .split(/\r?\n/, 1)[0]
      ?.match(/^jpeg-js (\S+) source-file notices$/)?.[1];
    if (noticeVersion !== version) {
      throw new Error(
        `Refresh LICENSES/jpeg-js.txt for bundled jpeg-js@${version}; its first line must name that version.`,
      );
    }
    texts.push(sourceNotices, fs.readFileSync(path.join(root, 'LICENSES/Apache-2.0.txt'), 'utf8'));
  }
  const author = authorText(manifest.author);
  return { name, version, license, ...(author ? { author } : {}), texts };
}

/** One attribution per release: two installed copies of one `name@version` are one package. */
function deduplicate(dependencies: readonly NoticeDependency[]): NoticeDependency[] {
  return [
    ...new Map(
      dependencies.map((dependency) => [`${dependency.name}@${dependency.version}`, dependency]),
    ).values(),
  ];
}

function xdeltaLicenseText(root: string, version: string, license: string): string {
  const notices = fs.readFileSync(path.join(root, 'LICENSES/xdelta3-wasm.txt'), 'utf8');
  if (
    notices.split(/\r?\n/, 1)[0] !== `@limrun/xdelta3-wasm ${version} source-file notices` ||
    license !== 'Apache-2.0'
  )
    throw new Error(
      `Refresh LICENSES/xdelta3-wasm.txt for bundled @limrun/xdelta3-wasm@${version}.`,
    );
  return notices + '\n' + fs.readFileSync(path.join(root, 'LICENSES/Apache-2.0.txt'), 'utf8');
}
