import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { releasePins, updateImpeccable } from '../impeccable-release.mjs';
import { skipWithoutSubmodules } from './fixtures.mjs';

const skip = skipWithoutSubmodules();
const kit = fileURLToPath(new URL('../../', import.meta.url));
const { impeccable: version } = JSON.parse(readFileSync(join(kit, 'scripts/versions.json'), 'utf8'));
const pins = readFileSync(join(kit, 'scripts/impeccable/SHA256SUMS'), 'utf8').trim().split(/\r?\n/)
  .map(line => { const [hash, name] = line.split(/\s+/); return { hash, name }; });
const base = `https://github.com/pbakaus/impeccable/releases/download/engine-v${version}/`;
const release = () => ({ tag_name: `engine-v${version}`, draft: false, prerelease: false,
  assets: pins.flatMap(({ name, hash }) => [
    { name, digest: `sha256:${hash}`, browser_download_url: base + name },
    { name: `${name}.sha256`, browser_download_url: `${base}${name}.sha256` },
  ]),
});
const checksum = async url => {
  const file = pins.find(pin => url === `${base}${pin.name}.sha256`);
  assert.ok(file, 'Only the fixed official checksum URLs are requested');
  return `${file.hash}  ${file.name}\n`;
};
const metadata = ['scripts/versions.json', 'scripts/impeccable/SHA256SUMS', 'docs/impeccable.md'];
const providers = ['.agents', '.claude'];
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'impeccable update '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['clone', '--quiet', '--shared', kit, root]);
  for (const vendor of ['impeccable', 'matt-pocock-skills', 'ponytail'])
    execFileSync('git', ['-c', 'advice.detachedHead=false', 'clone', '--quiet', '--shared', join(kit, '.vendor', vendor), join(root, '.vendor', vendor)]);
  // The offline fixture models an available official tag, even when CI cloned
  // only the accepted commit. Historical tags are not prerequisites for tests.
  const source = join(root, '.vendor/impeccable');
  const tag = execFileSync('git', ['config', '-f', '.gitmodules', '--get', 'submodule..vendor/impeccable.branch'], { cwd: root, encoding: 'utf8' }).trim();
  if (!execFileSync('git', ['-C', source, 'tag', '--list', tag], { encoding: 'utf8' }).trim())
    execFileSync('git', ['-C', source, 'tag', tag]);
  const expected = new Map(metadata.map(file => [file, readFileSync(join(root, file), 'utf8').replaceAll('\r\n', '\n')]));
  for (const file of metadata) {
    const path = join(root, file);
    let text = readFileSync(path, 'utf8').replaceAll(`engine-${version}`, 'engine-0.1.5')
      .replace(`Engine ${version}`, 'Engine 0.1.5').replace(/pinned to `skill-v[\d.]+`/, 'pinned to `skill-v4.3.1`');
    if (file.endsWith('/versions.json')) text = JSON.stringify({ ...JSON.parse(text), impeccable: '0.1.5' }, null, 2) + '\n';
    if (file.endsWith('/SHA256SUMS')) text = 'not-a-reviewed-checksum\n';
    writeFileSync(path, text);
  }
  for (const provider of providers)
    writeFileSync(join(root, provider, 'skills/impeccable/scripts/VERSION'), '0.1.5\n');
  for (const directory of ['.codex/agents', '.claude/agents']) {
    const file = readdirSync(join(root, directory)).find(name => name.startsWith('impeccable'));
    assert.ok(file, `Existing companion in ${directory}`);
    writeFileSync(join(root, directory, file), 'outdated generated companion\n');
  }
  return { root, expected };
}
function unstagedProposal(root) {
  // Match Renovate's real manager: proposed HEAD/tag, old index gitlink until commit.
  // A gitlink is a commit ID; shallow CI need not contain its historical object.
  const previous = 'cd12f8660e2dde57b9615c8a6b8ea674101f9cfc'; // skill-v4.3.1
  execFileSync('git', ['update-index', '--cacheinfo', `160000,${previous},.vendor/impeccable`], { cwd: root });
}

test('a stale Renovate engine pin is completed for every hook and provider, then reruns without drift', { skip }, async t => {
  const { root, expected } = fixture(t);
  const before = spawnSync(process.execPath, [join(root, 'scripts/provider.mjs'), 'impeccable', 'setup'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(before.status, 0, 'Reproduce the incomplete skill/engine update before fixing it');
  unstagedProposal(root);
  const tree = () => execFileSync('git', ['write-tree'], { cwd: root, encoding: 'utf8' });
  const originalIndex = tree();
  await updateImpeccable(root, { release: release(), checksum });
  assert.notEqual(tree(), originalIndex, 'The validated proposed gitlink replaces the old index pin');
  for (const file of metadata)
    assert.equal(readFileSync(join(root, file), 'utf8').replaceAll('\r\n', '\n'),
      expected.get(file), file);
  for (const provider of providers)
    assert.equal(readFileSync(join(root, provider, 'skills/impeccable/scripts/VERSION'), 'utf8').trim(), version);
  const status = () => execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
  assert.equal(status(), '', 'Metadata and generated outputs match the accepted kit');
  await updateImpeccable(root, { release: release(), checksum });
  assert.equal(status(), '', 'A second complete update introduces no drift');
});

test('incomplete releases, wrong digests and failed checksum reads never partly update metadata', { skip }, async t => {
  const { root } = fixture(t);
  unstagedProposal(root);
  const snapshot = () => metadata.map(file => readFileSync(join(root, file), 'utf8'));
  const before = snapshot();
  const index = execFileSync('git', ['write-tree'], { cwd: root, encoding: 'utf8' });
  for (const change of [
    data => { data.tag_name = 'engine-v0.0.0'; },
    data => { data.assets.pop(); },
    data => { data.assets.push(data.assets[0]); },
    data => { data.assets[0].digest = 'sha256:unreadable'; },
    data => { data.assets[0].browser_download_url = 'https://example.invalid/engine'; },
    data => { data.draft = true; },
    data => { data.prerelease = true; },
  ]) {
    const data = release(); change(data);
    await assert.rejects(updateImpeccable(root, { release: data, checksum }));
    assert.deepEqual(snapshot(), before);
    assert.equal(execFileSync('git', ['write-tree'], { cwd: root, encoding: 'utf8' }), index);
  }
  for (const failed of [async () => { throw new Error('checksum unavailable'); }, async () => 'wrong checksum']) {
    await assert.rejects(updateImpeccable(root, { release: release(), checksum: failed }));
    assert.deepEqual(snapshot(), before);
    assert.equal(execFileSync('git', ['write-tree'], { cwd: root, encoding: 'utf8' }), index);
  }
  assert.equal(await releasePins(release(), version, checksum), pins.map(file => `${file.hash}  ${file.name}\n`).join(''));
});
