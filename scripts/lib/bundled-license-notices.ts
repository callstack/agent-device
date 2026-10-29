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
          for (const dependency of dependencies) {
            if (!dependency.license || !dependency.licenseText?.trim()) {
              throw new Error(
                `Bundled dependency ${dependency.name}@${dependency.version} is missing its license or license text.`,
              );
            }
          }
          const notices = dependencies.map((dependency) => {
            if (dependency.name !== 'jpeg-js') return dependency.text();
            return [
              dependency.text(),
              fs.readFileSync(path.join(root, 'LICENSES/jpeg-js.txt'), 'utf8'),
              fs.readFileSync(path.join(root, 'LICENSES/Apache-2.0.txt'), 'utf8'),
            ].join('\n\n');
          });
          return notices.length === 0
            ? 'No third-party dependencies are bundled.\n'
            : notices.join('\n\n');
        },
      },
    },
  });
}
