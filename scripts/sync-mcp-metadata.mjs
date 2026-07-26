import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const checkOnly = process.argv.includes('--check');
const packagePath = path.join(root, 'package.json');
const serverPath = path.join(root, 'server.json');

const pkg = readJson(packagePath);
const server = readJson(serverPath);
const expectedName = pkg.mcpName;
const expectedVersion = pkg.version;
const registryDescriptionMaxLength = 100;

if (typeof expectedName !== 'string' || expectedName.length === 0) {
  fail('package.json must define mcpName.');
}
if (typeof expectedVersion !== 'string' || expectedVersion.length === 0) {
  fail('package.json must define version.');
}
if (typeof server.description === 'string' && server.description.length > registryDescriptionMaxLength) {
  fail(`server.json description must be ${registryDescriptionMaxLength} characters or fewer.`);
}

server.name = expectedName;
server.version = expectedVersion;
if (Array.isArray(server.packages)) {
  for (const packageEntry of server.packages) {
    if (packageEntry?.identifier === pkg.name) {
      packageEntry.version = expectedVersion;
    }
  }
}

const next = `${JSON.stringify(server, null, 2)}\n`;
const current = fs.readFileSync(serverPath, 'utf8');

if (checkOnly) {
  if (next !== current) {
    fail('server.json is out of sync. Run `pnpm sync:mcp-metadata`.');
  }
  process.exit(0);
}

if (next !== current) {
  fs.writeFileSync(serverPath, next);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
