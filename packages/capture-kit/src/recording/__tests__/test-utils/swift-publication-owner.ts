import fs from 'node:fs';
import path from 'node:path';
import {
  createSwiftAttempt,
  recordSwiftPublication,
  swiftPublicationPath,
} from '../../swift-attempt.ts';

const [root] = process.argv.slice(2);
if (!root) throw new Error('missing root');
const env = {
  ...process.env,
  AGENT_DEVICE_SWIFT_CACHE_DIR: path.join(root, 'cache'),
  AGENT_DEVICE_CLAIMS_DIR: path.join(root, 'claims'),
};
const attempt = createSwiftAttempt(env, 'overlay');
const videoPath = path.join(root, 'recording.mp4');
const publication = swiftPublicationPath(videoPath, path.basename(attempt.directory));
const fd = fs.openSync(publication, 'wx', 0o600);
recordSwiftPublication(attempt, fs.fstatSync(fd, { bigint: true }));
fs.writeFileSync(fd, Buffer.alloc(1024 * 1024));
fs.closeSync(fd);
fs.writeFileSync(path.join(attempt.work, 'large.mp4'), Buffer.alloc(1024 * 1024));
process.stdout.write(
  `${JSON.stringify({ attempt: path.basename(attempt.directory), publication, videoPath })}\n`,
);
await new Promise<void>(() => {});
