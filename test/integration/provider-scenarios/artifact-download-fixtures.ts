import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as tar from 'tar-stream';
import { gzipSync } from 'node:zlib';

export async function createDirectoryArtifactArchive(directoryPath: string): Promise<Buffer> {
  const entries: Array<{
    name: string;
    body?: Buffer;
    symlinkTo?: string;
  }> = [];
  const rootName = path.basename(directoryPath);
  const visit = async (currentPath: string, archivePath: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(currentPath, { withFileTypes: true })) {
      const sourcePath = path.join(currentPath, entry.name);
      const name = `${archivePath}/${entry.name}`;
      if (entry.isDirectory()) {
        await visit(sourcePath, name);
      } else if (entry.isSymbolicLink()) {
        entries.push({ name, symlinkTo: await fs.promises.readlink(sourcePath) });
      } else if (entry.isFile()) {
        entries.push({ name, body: await fs.promises.readFile(sourcePath) });
      }
    }
  };
  await visit(directoryPath, rootName);
  return await createArtifactArchive(entries);
}

async function createArtifactArchive(
  entries: readonly { name: string; body?: string | Buffer; symlinkTo?: string }[],
): Promise<Buffer> {
  const pack = tar.pack();
  for (const entry of entries) {
    if (entry.symlinkTo !== undefined) {
      pack.entry({ name: entry.name, type: 'symlink', linkname: entry.symlinkTo }, Buffer.alloc(0));
    } else {
      pack.entry({ name: entry.name, type: 'file' }, Buffer.from(entry.body ?? ''));
    }
  }
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
