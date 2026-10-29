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
          for (const dependency of dependencies) {
            if (!dependency.license || !dependency.licenseText?.trim()) {
              throw new Error(
                `Bundled dependency ${dependency.name}@${dependency.version} is missing its license or license text.`,
              );
            }
            const references = [reference(dependency.licenseText)];
            if (dependency.noticeText?.trim()) references.push(reference(dependency.noticeText));
            if (dependency.name === 'jpeg-js') {
              references.push(
                reference(fs.readFileSync(path.join(root, 'LICENSES/jpeg-js.txt'), 'utf8')),
                reference(fs.readFileSync(path.join(root, 'LICENSES/Apache-2.0.txt'), 'utf8')),
              );
            }
            packages.push(
              `${dependency.name}@${dependency.version} (${dependency.license}): ${references.join(', ')}`,
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
