import fs from 'node:fs';
import path from 'node:path';
import license from 'rollup-plugin-license';

export function bundledLicenseNotices(root: string, outputDirectory: string) {
  return license({
    cwd: root,
    sourcemap: false,
    thirdParty: {
      multipleVersions: true,
      output: {
        file: path.join(outputDirectory, 'THIRD_PARTY_NOTICES.txt'),
        template(dependencies) {
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
            if (!dependency.license || !dependency.licenseText?.trim()) {
              throw new Error(
                `Bundled dependency ${dependency.name}@${dependency.version} is missing its license or license text.`,
              );
            }
            const references = [reference(dependency.licenseText)];
            if (dependency.noticeText?.trim()) references.push(reference(dependency.noticeText));
            if (dependency.name === 'jpeg-js') {
              const sourceNotices = fs.readFileSync(
                path.join(root, 'LICENSES/jpeg-js.txt'),
                'utf8',
              );
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
          return [
            packages.join('\n'),
            ...Array.from(texts, ([text, id]) => `[${id}]\n${text}`),
          ].join('\n\n');
        },
      },
    },
  });
}
