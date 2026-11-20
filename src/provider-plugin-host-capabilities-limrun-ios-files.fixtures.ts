import type { IncomingMessage, ServerResponse } from 'node:http';

export type FileStoreOptions = {
  files?: Record<string, Uint8Array>;
  containers?: Record<string, Record<string, Record<string, Uint8Array>>>;
  failFileMethod?: string;
  failFileStatus?: number;
  holdFileDownload?: boolean;
  invalidUploadReply?: boolean;
  onFileDownload?: () => void;
};

export function fileStore(options: FileStoreOptions) {
  const files = new Map<string, Uint8Array>();
  for (const [name, body] of Object.entries(options.files ?? {}))
    files.set(`staging/${name}`, body);
  for (const [bundleId, types] of Object.entries(options.containers ?? {}))
    for (const [type, entries] of Object.entries(types))
      for (const [name, body] of Object.entries(entries))
        files.set(`${bundleId}/${type}/${name}`, body);
  const directories = new Set<string>();
  const calls: Array<{
    method: string;
    name: string;
    bundleId: string | null;
    containerType: string | null;
    body: Buffer;
  }> = [];
  const put = (root: string, name: string, body: Buffer) => {
    files.set(root + name, body);
    for (
      let parent = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
      parent;
      parent = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : ''
    )
      directories.add(root + parent);
  };
  const remove = (name: string) => {
    for (const key of files.keys())
      if (key === name || key.startsWith(`${name}/`)) files.delete(key);
    for (const key of directories)
      if (key === name || key.startsWith(`${name}/`)) directories.delete(key);
  };
  const downloads: Array<() => void> = [];
  const serveDownload = (name: string, response: ServerResponse): void => {
    const bytes = files.get(name);
    if (!bytes) {
      response.writeHead(404).end('File not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    response.write(bytes);
    options.onFileDownload?.();
    if (options.holdFileDownload) downloads.push(() => response.end());
    else response.end();
  };
  const serve = (request: IncomingMessage, response: ServerResponse, body: Buffer): boolean => {
    const url = new URL(request.url!, 'http://fixture');
    if (!['/v1/ios_test/api/files', '/v1/ios_test/api/files/list'].includes(url.pathname))
      return false;
    const name = url.searchParams.get('name') ?? '';
    const bundleId = url.searchParams.get('bundleId');
    const containerType = url.searchParams.get('containerType');
    const root = bundleId ? `${bundleId}/${containerType}/` : 'staging/';
    const method = request.method!;
    calls.push({ method, name, bundleId, containerType, body });
    if (method === options.failFileMethod) {
      response.writeHead(options.failFileStatus ?? 500).end('file operation failed');
      return true;
    }
    if (url.pathname.endsWith('/list')) {
      const names = new Set(
        [...files.keys(), ...directories]
          .filter((key) => key.startsWith(root))
          .map((key) => key.slice(root.length).split('/')[0]!),
      );
      response.end(JSON.stringify({ entries: [...names].map((name) => ({ name, path: name })) }));
    } else if (method === 'PUT') {
      put(root, name, body);
      response.end(
        options.invalidUploadReply ? 'invalid-json' : JSON.stringify({ path: `/staging/${name}` }),
      );
    } else if (method === 'DELETE') {
      remove(root + name);
      response.end(JSON.stringify({ ok: true }));
    } else {
      serveDownload(root + name, response);
    }
    return true;
  };
  return {
    files,
    directories,
    calls,
    serve,
    finishDownloads: () => downloads.splice(0).forEach((finish) => finish()),
  };
}
