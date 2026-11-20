// The remote commit creates the entry host-kit authorized for the record's destination, and a version the
// record already holds is answered from the record alone (ADR 0016).
import fs from 'node:fs';
import path from 'node:path';
import { expect, onTestFinished, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import {
  answer,
  artifactServer,
  open,
  request,
  script,
  soleRecord,
} from './support/script-publication-fixtures.ts';

function caller() {
  const root = fs.realpathSync(mkdtempForTestSync('script-entry-'));
  return { root, stateDir: path.join(root, 'state'), directory: path.join(root, 'caller') };
}

type Delivery = Readonly<{ saved: true } | { saved: false; cause: string }>;

const ENTRY_CASES: ReadonlyArray<{
  name: string;
  force: boolean;
  delivery: Delivery;
  arrange: (directory: string) => string;
  verify: (directory: string, destination: string) => void;
}> = [false, true].flatMap((force) => [
  {
    name: 'an overlong name',
    force,
    delivery: { saved: false, cause: 'script_ancestor_untrusted' },
    arrange: (directory: string) => path.join(directory, 'new', 'a'.repeat(256)),
    verify: (directory: string) => expect(fs.existsSync(path.join(directory, 'new'))).toBe(false),
  },
  {
    name: 'a directory at the entry',
    force,
    delivery: { saved: false, cause: force ? 'script_download_failed' : 'script_target_exists' },
    arrange: (directory: string) => {
      const destination = path.join(directory, 'journey.ad');
      fs.mkdirSync(destination, { recursive: true });
      return destination;
    },
    verify: (_directory: string, destination: string) => {
      expect(fs.lstatSync(destination).isDirectory()).toBe(true);
      expect(fs.readdirSync(destination)).toEqual([]);
    },
  },
  {
    name: 'a hard link at the entry',
    force,
    delivery: force ? { saved: true } : { saved: false, cause: 'script_target_exists' },
    arrange: (directory: string) => {
      fs.mkdirSync(directory, { recursive: true });
      const destination = path.join(directory, 'journey.ad');
      fs.writeFileSync(path.join(directory, 'theirs.ad'), 'theirs\n');
      fs.linkSync(path.join(directory, 'theirs.ad'), destination);
      return destination;
    },
    verify: (directory: string, destination: string) => {
      // Replaced as a directory entry, never written through to the file it shared.
      expect(fs.readFileSync(path.join(directory, 'theirs.ad'), 'utf8')).toBe('theirs\n');
      expect(fs.readFileSync(destination, 'utf8')).toBe(force ? 'v1\n' : 'theirs\n');
    },
  },
]);

test.skipIf(process.platform === 'win32').each(ENTRY_CASES)(
  'a remote recording to $name with force=$force',
  async ({ force, delivery, arrange, verify }) => {
    const { stateDir, directory } = caller();
    const destination = arrange(directory);
    const baseUrl = await artifactServer({ v1: { body: 'v1\n' } });

    const { response } = await open(baseUrl, stateDir, destination, { force });

    if (delivery.saved) {
      expect(response).toMatchObject({ ok: true, data: { savedScript: destination } });
    } else {
      expect(response).toMatchObject({
        ok: true,
        data: { scriptDeliveryFailure: { cause: delivery.cause } },
      });
    }
    verify(directory, destination);
  },
);

test('a version delivered again is answered from the record, quietly and without a fetch', async () => {
  const { stateDir, directory } = caller();
  const destination = `${path.join(directory, 'journey.ad')}/`;
  const served: Record<string, { body: string }> = { v1: { body: 'v1\n' } };
  const baseUrl = await artifactServer(served);
  const entry = path.join(directory, 'journey.ad');
  const { id, response } = await open(baseUrl, stateDir, destination);
  let fetches = 0;
  Object.defineProperty(served, 'v1', { get: () => void (fetches += 1) });
  // Gone from disk: only the record can answer the repeat.
  fs.rmSync(entry);
  const touched = spyOnPathsUnder(directory);

  const again = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v1', 1, id)],
  });

  expect(fetches).toBe(0);
  expect(touched()).toEqual([]);
  // The first commit reports the entry it created; a repeat reports the destination as the caller spelled it.
  expect(response).toMatchObject({ ok: true, data: { savedScript: entry } });
  expect(again).toMatchObject({ ok: true, data: { savedScript: destination } });
  expect(again.ok && again.data).not.toHaveProperty('warnings');
  expect(again.ok && again.data).not.toHaveProperty('scriptDeliveryFailure');
});

/**
 * Records every `fs` call, synchronous or through `fs.promises`, that names a path under `root`, and restores
 * the spies at test end.
 */
function spyOnPathsUnder(root: string): () => string[] {
  const touched: string[] = [];
  const spyOn = (owner: object, label: string, methods: readonly string[]) => {
    const target = owner as Record<string, (...args: unknown[]) => unknown>;
    for (const method of methods) {
      const original = target[method]!.bind(owner);
      const spy = vi.spyOn(target, method).mockImplementation((...args: unknown[]) => {
        if (String(args[0]).startsWith(root)) touched.push(`${label}${method} ${String(args[0])}`);
        return original(...args);
      });
      onTestFinished(() => spy.mockRestore());
    }
  };
  const operations = [
    'access',
    'link',
    'lstat',
    'mkdir',
    'mkdtemp',
    'open',
    'readFile',
    'readdir',
    'realpath',
    'rename',
    'rm',
    'stat',
    'writeFile',
  ];
  spyOn(fs, '', [...operations.map((name) => `${name}Sync`), 'existsSync']);
  spyOn(fs.promises, 'promises.', operations);
  return () => touched;
}

test('a record an older client wrote with extra fields still parses, and the fields are ignored', async () => {
  const { root, stateDir, directory } = caller();
  const destination = path.join(directory, 'journey.ad');
  const unrelated = path.join(root, 'unrelated', 'journey.ad');
  fs.mkdirSync(path.dirname(unrelated));
  fs.writeFileSync(unrelated, 'unrelated\n');
  const baseUrl = await artifactServer({ v1: { body: 'v1\n' }, v2: { body: 'v2\n' } });
  const { id } = await open(baseUrl, stateDir, destination);
  const { file: recordFile, record } = soleRecord(stateDir);
  const stat = fs.statSync(unrelated, { bigint: true });
  const staging = path.dirname(unrelated);
  fs.writeFileSync(
    recordFile,
    JSON.stringify({
      ...record,
      committedDigest: 'f'.repeat(64),
      entry: { revision: 1, path: unrelated },
      publishing: { revision: 9, file: `${stat.dev}:${stat.ino}`, staging },
      staging: [staging],
    }),
  );

  const repeated = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v1', 1, id)],
  });
  const next = await answer(baseUrl, stateDir, request('click'), {
    artifacts: [script('v2', 2, id)],
  });

  expect(repeated).toMatchObject({ ok: true, data: { savedScript: destination } });
  expect(next).toMatchObject({ ok: true, data: { savedScript: destination } });
  expect(fs.readFileSync(destination, 'utf8')).toBe('v2\n');
  expect(fs.readFileSync(unrelated, 'utf8')).toBe('unrelated\n');
  expect(soleRecord(stateDir).record).toEqual({ destination, force: false, revision: 2 });
});

test.skipIf(process.platform === 'win32')(
  'the real walk through a linked parent creates and reports the entry it judged',
  async () => {
    // The parent is spelled through a symbolic link, and the walk's own answer is where the script lands
    // and what is reported.
    const { stateDir, directory } = caller();
    const real = path.join(directory, 'real');
    fs.mkdirSync(real, { recursive: true, mode: 0o700 });
    fs.symlinkSync(real, path.join(directory, 'linked'));
    const baseUrl = await artifactServer({ v1: { body: 'v1\n' } });

    const { response } = await open(
      baseUrl,
      stateDir,
      path.join(directory, 'linked', 'journey.ad'),
    );

    expect(response).toMatchObject({
      ok: true,
      data: { savedScript: path.join(real, 'journey.ad') },
    });
    expect(fs.readFileSync(path.join(real, 'journey.ad'), 'utf8')).toBe('v1\n');
    expect(fs.lstatSync(path.join(directory, 'linked')).isSymbolicLink()).toBe(true);
  },
);

/** Opens a recording whose destination already holds a file, and returns the hint of its refusal. */
async function fileExistsHint(destination: string): Promise<unknown> {
  const { stateDir } = caller();
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, 'theirs\n');
  const baseUrl = await artifactServer({ v1: { body: 'v1\n' } });

  const { response } = await open(baseUrl, stateDir, destination);

  expect(response).toMatchObject({
    ok: true,
    data: { scriptDeliveryFailure: { cause: 'script_target_exists' } },
  });
  expect(fs.readFileSync(destination, 'utf8')).toBe('theirs\n');
  const failure = response.ok ? response.data?.scriptDeliveryFailure : undefined;
  return (failure as { hint?: unknown } | undefined)?.hint;
}

test('a file-exists refusal names the file to record again to, quoted for a shell', async () => {
  const destination = path.join(caller().directory, "Bob's journey.ad");

  const quoted = `'${destination.replaceAll("'", String.raw`'\''`)}'`;
  expect(await fileExistsHint(destination)).toBe(
    `Remove the existing file, or start a new recording by reusing your original open command with --save-script=${quoted} --force.`,
  );
});

// Windows refuses a character below U+0020 in the final name, so those rows never reach the entry there.
const CONTROL_CHARACTER_DESTINATIONS = [
  { name: 'a newline', file: 'line\nbreak.ad', posixOnly: true },
  { name: 'an SGR conceal sequence', file: 'line\u001b[8mbreak.ad', posixOnly: true },
  { name: 'a C1 next-line character', file: 'line\u0085break.ad', posixOnly: false },
  { name: 'a C1 control sequence introducer', file: 'line\u009bbreak.ad', posixOnly: false },
].filter(({ posixOnly }) => !posixOnly || process.platform !== 'win32');

test.each(CONTROL_CHARACTER_DESTINATIONS)(
  'a file-exists refusal whose path holds $name names no command a text line would change',
  async ({ file }) => {
    expect(await fileExistsHint(path.join(caller().directory, file))).toBe(
      'Remove the existing file, or start a new recording by reusing your original open command with --save-script=<path> --force, with the path quoted for your shell.',
    );
  },
);
