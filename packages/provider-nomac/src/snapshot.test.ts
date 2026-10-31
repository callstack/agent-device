import { expect, test } from 'vitest';
import { NomacClient } from './client.ts';
import { fakeNomac, SIGN_IN_TREE } from './fake-nomac.fixtures.ts';
import { captureNomacIosSnapshot, flattenNomacTree, nomacSnapshotFromTree } from './snapshot.ts';

test("NoMac's tree becomes agent-device's nodes: types, labels, ids, the password field, the switch's state", () => {
  const nodes = flattenNomacTree(SIGN_IN_TREE);
  expect(
    nodes.map((n) => [n.index, n.depth, n.parentIndex, n.type, n.label, n.identifier]),
  ).toEqual([
    [0, 0, undefined, 'Application', 'Demo', undefined],
    [1, 1, 0, 'TextField', 'Email', 'email'],
    [2, 1, 0, 'SecureTextField', 'Password', 'password'],
    [3, 1, 0, 'Switch', 'Remember me', 'remember'],
    [4, 1, 0, 'Button', 'Sign In', 'signIn'],
    [5, 1, 0, 'StaticText', 'Sign In', undefined],
  ]);
  expect(nodes[2]).toMatchObject({
    password: true,
    rect: { x: 20, y: 236, width: 362, height: 44 },
  });
  expect(nodes[3]?.value).toBe('0');
  expect(nodes[5]?.heading).toBe(true);
  const result = nomacSnapshotFromTree(SIGN_IN_TREE, 'ses_1');
  expect(result.stage).toBe('acquired');
  expect(result.acquisition.producer).toBe('nomac-ios-tree');
  expect(result.acquisition.viewport).toEqual({
    kind: 'derived',
    rect: { x: 0, y: 0, width: 402, height: 874 },
  });
  expect(result.acquisition.nodes.find((n) => n.identifier === 'remember')?.checked).toBe(false);
  expect(result.acquisition.nodes.find((n) => n.identifier === 'email')?.editable).toBe(true);
});

test("a snapshot reads the phone's whole tree through ui_look and its file link", async () => {
  const nomac = fakeNomac();
  const client = new NomacClient({
    apiKey: 'nmk_test',
    baseUrl: 'https://nomac.test',
    clientVersion: '0.0.0-test',
    fetch: nomac.fetch,
  });
  const phone = await client.startPhone('agent-device-lease-s', {});
  const result = await captureNomacIosSnapshot(client, phone.id);
  expect(result.acquisition.nodes).toHaveLength(6);
  expect(nomac.seen.find((r) => r.path.endsWith('/tools/ui_look'))?.body).toEqual({ full: true });
  expect(nomac.seen.some((r) => r.path === '/api/v1/simulator/files/tree-token')).toBe(true);
});
