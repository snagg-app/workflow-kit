// Complete a reviewed submodule update before committing its generated outputs (the update of provider-impeccable.mjs).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { externalTool } from './checkout-root.mjs';
import { providers } from './agents.mjs';
import { checkDirectory } from './write-guard.mjs';

const assets = ['impeccable-darwin-arm64', 'impeccable-darwin-x64',
  'impeccable-linux-arm64', 'impeccable-linux-x64', 'impeccable-windows-x64.exe'];
const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const text = file => readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
const download = async url => {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, `Release download failed: HTTP ${response.status}`);
  return response.text();
};

/** Validate every supported artifact and its official checksum before returning any pin. */
export async function releasePins(release, version, checksum = download) {
  assert.equal(release.tag_name, `engine-v${version}`, 'Release does not match the skill engine');
  assert.equal(release.draft, false, 'Engine release is a draft');
  assert.equal(release.prerelease, false, 'Engine release is a prerelease');
  assert.ok(Array.isArray(release.assets), 'Release assets are unreadable');
  const base = `https://github.com/pbakaus/impeccable/releases/download/engine-v${version}/`;
  const files = assets.map(name => {
    const named = asset => {
      const matches = release.assets.filter(file => file.name === asset);
      assert.equal(matches.length, 1, `Missing or duplicated release asset: ${asset}`);
      assert.equal(matches[0].browser_download_url, base + asset, 'Unexpected release asset URL');
      return matches[0];
    };
    const binary = named(name), sum = named(`${name}.sha256`);
    assert.match(binary.digest ?? '', /^sha256:[a-f0-9]{64}$/, `Missing SHA256 digest: ${name}`);
    return { name, hash: binary.digest.slice(7), url: sum.browser_download_url };
  });
  const sums = await Promise.all(files.map(file => checksum(file.url)));
  return files.map((file, i) => {
    assert.match(sums[i].trim(), new RegExp(`^${file.hash}\\s+\\*?${RegExp.escape(file.name)}$`),
      `Release digest and checksum disagree: ${file.name}`);
    return `${file.hash}  ${file.name}\n`;
  }).join('');
}

/** Update kit-owned metadata, then reuse the normal hook and skill generators. */
export async function updateImpeccable(kit, { release, checksum } = {}) {
  const tool = externalTool('git', kit, kitRoot, process.cwd());
  const git = (...args) => execFileSync(tool.file, args, { cwd: kit, env: tool.env, encoding: 'utf8' }).trim();
  const source = join(kit, '.vendor/impeccable');
  const read = name => {
    const file = join(kit, name);
    checkDirectory(kit, dirname(file));
    assert.ok(lstatSync(file).isFile(), `Refusing non-file metadata: ${name}`);
    return text(file);
  };
  checkDirectory(kit, source);
  read('.gitmodules');
  assert.equal(git('config', '-f', '.gitmodules', '--get', 'submodule..vendor/impeccable.url'),
    'https://github.com/pbakaus/impeccable.git', 'Unexpected Impeccable source');
  // Renovate checks out the proposed gitlink without staging it. Updating an
  // already initialized submodule here would reset that proposal to the old pin.
  if (!existsSync(join(source, '.git')))
    git('submodule', 'update', '--init', '--', '.vendor/impeccable');
  assert.equal(git('-C', source, 'status', '--porcelain', '--untracked-files=all'), '', 'Preserve dirty upstream source');
  assert.ok(!/^(?:[a-z]|S) /m.test(git('-C', source, 'ls-files', '-v')), 'Upstream source hides local changes');
  const revision = git('-C', source, 'rev-parse', 'HEAD');
  const version = read('.vendor/impeccable/.agents/skills/impeccable/scripts/VERSION').trim();
  assert.match(version, /^\d+\.\d+\.\d+$/);
  for (const provider of providers)
    assert.equal(read(`.vendor/impeccable/${provider}/skills/impeccable/scripts/VERSION`).trim(), version, 'Provider engine versions disagree');
  const tag = git('config', '-f', '.gitmodules', '--get', 'submodule..vendor/impeccable.branch');
  assert.match(tag, /^skill-v\d+\.\d+\.\d+$/);
  // A shallow checkout can contain the proposed commit without its tag ref.
  if (git('-C', source, 'tag', '--list', tag) !== tag)
    git('-C', source, 'fetch', '--no-tags', 'https://github.com/pbakaus/impeccable.git',
      `refs/tags/${tag}:refs/tags/${tag}`);
  assert.equal(git('-C', source, 'rev-parse', `${tag}^{commit}`), revision, 'Skill tag does not match the proposed pin');
  release ??= JSON.parse(await download(`https://api.github.com/repos/pbakaus/impeccable/releases/tags/engine-v${version}`));
  const pins = await releasePins(release, version, checksum);
  const manifest = JSON.parse(read('scripts/versions.json'));
  const changes = new Map([['scripts/versions.json', JSON.stringify({ ...manifest, impeccable: version }, null, 2) + '\n'], ['scripts/impeccable/SHA256SUMS', pins]]);
  const doc = read('docs/impeccable.md');
  assert.match(doc, /pinned to `skill-v\d+\.\d+\.\d+`/);
  assert.match(doc, /Engine \d+\.\d+\.\d+/);
  changes.set('docs/impeccable.md', doc.replace(/pinned to `skill-v\d+\.\d+\.\d+`/, `pinned to \`${tag}\``)
    .replace(/Engine \d+\.\d+\.\d+/, `Engine ${version}`));
  // Validate every target and all release data before the first metadata write.
  const previous = new Map([...changes.keys()].map(name => [name, read(name)]));
  // Existing generators read the index pin. Stage only the validated, existing
  // gitlink; Renovate collects generated files through postUpgradeTasks.fileFilters.
  if (git('rev-parse', ':.vendor/impeccable') !== revision)
    git('add', '--', '.vendor/impeccable');
  for (const [name, value] of changes)
    if (previous.get(name) !== value) writeFileSync(join(kit, name), value);
  for (const command of ['init-project.mjs', 'setup-skills.mjs'])
    execFileSync(process.execPath, [join(kit, 'scripts', command), ...command === 'init-project.mjs' ? ['--existing'] : []],
      { cwd: kit, stdio: 'inherit' });
  console.log(`Complete Impeccable update: ${tag}, engine ${version}; review and commit the generated diff.`);
}
