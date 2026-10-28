import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { addPathEntry, ensureNode, nodeDirCandidates, profileFiles, withProfileBlock } from '../node-path.mjs';

test('addPathEntry appends once and never shortens the PATH', () => {
  assert.deepEqual(addPathEntry('C:\\a;C:\\b', 'C:\\fnm\\default', { fold: true }), { value: 'C:\\a;C:\\b;C:\\fnm\\default', changed: true });
  assert.deepEqual(addPathEntry('C:\\a;C:\\FNM\\Default\\', 'C:\\fnm\\default', { fold: true }), { value: 'C:\\a;C:\\FNM\\Default\\', changed: false });
  assert.deepEqual(addPathEntry('', 'C:\\x'), { value: 'C:\\x', changed: true });
  assert.deepEqual(addPathEntry('/a:/b', '/n', { sep: ':' }), { value: '/a:/b:/n', changed: true });
});

test('the profile block is written once, replaced when the folder changes, and the rest of the file stays', () => {
  const once = withProfileBlock('export A=1', '/n/bin');
  assert.equal(withProfileBlock(once, '/n/bin'), once);
  const moved = withProfileBlock(once, '/m/bin');
  assert.equal(moved.match(/workflow-kit node \(begin\)/g).length, 1);
  const stray = withProfileBlock('# workflow-kit node (begin)\nmine\n', '/n/bin');
  assert.ok(withProfileBlock(stray, '/m/bin').includes('mine\n'), 'a stray start marker never swallows user lines');
  assert.ok(moved.startsWith('export A=1\n') && moved.includes('/m/bin') && !moved.includes('/n/bin'));
});

test('the Node folder is the stable fnm default; zsh gets .zshenv, bash its login file', () => {
  const win = nodeDirCandidates({ platform: 'win32', env: { APPDATA: 'C:\\U\\AppData\\Roaming' }, home: 'C:\\U' });
  assert.match(win[0], /fnm[\\/]aliases[\\/]default$/);
  assert.equal(nodeDirCandidates({ platform: 'linux', env: { FNM_DIR: '/f' }, home: '/h' })[0], '/f/aliases/default/bin');
  assert.deepEqual(profileFiles({ platform: 'darwin', home: '/h', hasZsh: false, exists: () => false }), ['/h/.profile', '/h/.zshenv']);
  assert.deepEqual(profileFiles({ platform: 'linux', home: '/h', hasZsh: false, exists: () => true }), ['/h/.bash_profile']);
});

// #1071: bash -c without login reads no profile; the hook command searches itself. fnm first (default alias wins), the other usual places only as the last resort, appended.
test('the hook search tries fnm before nvm/volta/mise/Homebrew, and the last resort never shadows a node already found', () => {
  const { findNode } = JSON.parse(readFileSync(new URL('../hook-commands.json', import.meta.url), 'utf8'));
  const at = text => findNode.indexOf(text);
  const order = ['.local/share/fnm', '.fnm', 'Application Support/fnm', 'node-versions', 'aliases/default', '.nvm/versions/node', '.volta/bin', 'mise/shims', '/opt/homebrew/bin'].map(at);
  assert.ok(order.every(index => index >= 0) && order.every((index, i) => i === 0 || index > order[i - 1]), 'search order: ' + order);
  assert.ok(findNode.includes('PATH="$PATH:$d"'), 'the last resort is appended, not prepended');
});

function fake({ found = [], dirs = [], installed = [] }) {
  const calls = [];
  const sys = {
    platform: 'win32', env: { APPDATA: 'C:\\A' }, home: 'C:\\U', calls,
    findNode: () => found.shift(),
    hasNode: dir => dirs.includes(dir) || (calls.includes('install') && installed.includes(dir)),
    addToPath: dir => { calls.push('add ' + dir); return 'PATH ergänzt'; },
    install: () => { calls.push('install'); return 'installiert'; },
  };
  return sys;
}

test('ensureNode changes nothing when node is found, adds the fnm folder once when it is not, installs only when nothing exists', () => {
  const alias = nodeDirCandidates({ platform: 'win32', env: { APPDATA: 'C:\\A' }, home: 'C:\\U' })[0];
  const present = fake({ found: ['v99.0.0'] });
  assert.equal(ensureNode(present).state, 'ok');
  assert.deepEqual(present.calls, []);
  const withFnm = fake({ found: [undefined, 'v99.0.0'], dirs: [alias] });
  assert.equal(ensureNode(withFnm).state, 'ok');
  assert.deepEqual(withFnm.calls, ['add ' + alias]);
  const bare = fake({ found: [undefined, undefined, 'v99.0.0'], installed: [alias] });
  assert.equal(ensureNode(bare).state, 'ok');
  assert.deepEqual(bare.calls, ['install', 'add ' + alias]);
  const hopeless = ensureNode(fake({ found: [] }));
  assert.equal(hopeless.state, 'error');
});
