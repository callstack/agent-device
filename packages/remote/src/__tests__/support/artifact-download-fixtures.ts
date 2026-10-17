import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import * as tar from 'tar-stream';

export async function createDirectoryArtifactArchive(directoryPath: string): Promise<Buffer> {
  const pack = tar.pack();
  const rootName = path.basename(directoryPath);
  const visit = async (currentPath: string, archivePath: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(currentPath, { withFileTypes: true })) {
      const sourcePath = path.join(currentPath, entry.name);
      const name = `${archivePath}/${entry.name}`;
      if (entry.isDirectory()) {
        await visit(sourcePath, name);
      } else if (entry.isSymbolicLink()) {
        pack.entry(
          { name, type: 'symlink', linkname: await fs.promises.readlink(sourcePath) },
          Buffer.alloc(0),
        );
      } else if (entry.isFile()) {
        pack.entry({ name, type: 'file' }, await fs.promises.readFile(sourcePath));
      }
    }
  };
  await visit(directoryPath, rootName);
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of pack) chunks.push(Buffer.from(chunk));
  return gzipSync(Buffer.concat(chunks));
}

export function createArtifactDownloadServer(archives: ReadonlyMap<string, Buffer>): http.Server {
  return http.createServer((request, response) => {
    const prefix = '/artifacts/';
    const artifactId = request.url?.startsWith(prefix)
      ? decodeURIComponent(request.url.slice(prefix.length))
      : undefined;
    const archive = request.method === 'GET' && artifactId ? archives.get(artifactId) : undefined;
    if (!archive) {
      response.statusCode = 404;
      response.end('not found');
      return;
    }
    response.setHeader('content-type', 'application/gzip');
    response.end(archive);
  });
}
