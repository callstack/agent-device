import { expect, test } from 'vitest';
import { NomacClient } from './client.ts';
import { fakeNomac, SIGN_IN_TREE } from './fake-nomac.fixtures.ts';
import { captureNomacIosSnapshot, nomacSnapshotFromTree } from './snapshot.ts';

const clientFor = (nomac: ReturnType<typeof fakeNomac>) =>
  new NomacClient({
    apiKey: 'nmk_test',
    baseUrl: 'https://nomac.test',
    clientVersion: '0.0.0-test',
    fetch: nomac.fetch,
  });

test("NoMac's tree is read by capture-kit's AX tree reader: frames, the secure field, the switch's state", () => {
  const result = nomacSnapshotFromTree(SIGN_IN_TREE, 'ses_1');
  expect(result.stage).toBe('acquired');
  expect(result.acquisition.producer).toBe('nomac-ios-tree');
  expect(result.acquisition.viewport).toEqual({
    kind: 'derived',
    rect: { x: 0, y: 0, width: 402, height: 874 },
  });
  const nodes = result.acquisition.nodes;
  expect(nodes.map((n) => [n.index, n.depth, n.parentIndex, n.type, n.identifier])).toEqual([
    [0, 0, undefined, 'Application', undefined],
    [1, 1, 0, 'Heading', undefined],
    [2, 1, 0, 'TextField', 'email'],
    [3, 1, 0, 'TextField', 'password'],
    [4, 1, 0, 'CheckBox', 'remember'],
    [5, 1, 0, 'Button', 'signIn'],
    [6, 1, 0, 'StaticText', 'status'],
  ]);
  expect(nodes[1]?.heading).toBe(true);
  expect(nodes[2]).toMatchObject({ editable: true, password: false, value: 'Email' });
  expect(nodes[3]).toMatchObject({
    password: true,
    rect: { x: 32, y: 235.67, width: 338, height: 21 },
  });
  expect(nodes[4]?.checked).toBe(false);
});

test('a root frame NoMac reports as zero-size keeps its invalid reason', () => {
  const [app] = SIGN_IN_TREE;
  const result = nomacSnapshotFromTree(
    [{ ...app!, frame: { x: 0, y: 0, width: 0, height: 874 } }],
    'ses_1',
  );
  expect(result.acquisition.viewport).toEqual({ kind: 'missing', reason: 'invalid' });
});

test("a snapshot reads the phone's whole tree through ui_look and its file link", async () => {
  const nomac = fakeNomac();
  const client = clientFor(nomac);
  const phone = await client.startPhone('agent-device-lease-s', {});
  const result = await captureNomacIosSnapshot(client, phone.id);
  expect(result.acquisition.nodes).toHaveLength(7);
  expect(nomac.seen.find((r) => r.path.endsWith('/tools/ui_look'))?.body).toEqual({ full: true });
  expect(nomac.seen.some((r) => r.path === '/api/v1/simulator/files/tree-token')).toBe(true);
});

test('a phone that cannot read its screen, or names no tree, fails the snapshot', async () => {
  const failing = fakeNomac({
    toolAnswers: { ui_look: () => ({ text: 'The Simulator is still booting.', isError: true }) },
  });
  const client = clientFor(failing);
  const phone = await client.startPhone('agent-device-lease-t', {});
  await expect(captureNomacIosSnapshot(client, phone.id)).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: expect.stringMatching(/still booting/),
  });
  const linkless = fakeNomac({ toolAnswers: { ui_look: () => ({ text: 'Demo · Sign In' }) } });
  const other = clientFor(linkless);
  const second = await other.startPhone('agent-device-lease-u', {});
  await expect(captureNomacIosSnapshot(other, second.id)).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
  });
});

test('an empty tree is refused as one, whether NoMac answers [] or nothing', async () => {
  for (const tree of [[], null]) {
    const nomac = fakeNomac({ tree });
    const client = clientFor(nomac);
    const phone = await client.startPhone('agent-device-lease-v', {});
    await expect(captureNomacIosSnapshot(client, phone.id)).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      message: expect.stringMatching(/empty tree/),
    });
  }
});
