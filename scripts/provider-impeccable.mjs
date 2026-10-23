// Anbieter Impeccable (pbakaus/impeccable): Skills und Agent-Begleiter aus dem Submodul, Hook-Engine als Release-Binary mit Pruefsumme. Die Engine steht in provider.mjs.
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { agents, providers } from './agents.mjs';
import { checkDirectory } from './provider-links.mjs';

const uiDependencies = ['react', 'react-dom', 'react-native', 'expo', 'vue', 'svelte', 'solid-js', 'preact', 'lit', '@angular/core', 'next', 'astro'];
const uiFile = /\.(?:tsx|jsx|vue|svelte|astro)$/;

/**
 * Whether the project has UI files: a component file (tracked or new, not ignored) or a UI dependency in any package.json. `ask` runs Git in `root` (asking() of git-tool.mjs).
 * shortcut: names the common frameworks only; when it guesses wrong, set "impeccable" to true or false in the profile.
 */
function scanForUi(root, ask) {
  const listed = ask(root, 'ls-files', '--cached', '--others', '--exclude-standard');
  const files = listed.ok ? listed.out.split('\n').filter(Boolean) : [];
  if (files.some(file => uiFile.test(file))) return true;
  return files.filter(file => /(?:^|\/)package\.json$/.test(file)).some(file => {
    try {
      const manifest = JSON.parse(readFileSync(join(root, file), 'utf8'));
      return [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies].some(list => list && uiDependencies.some(name => Object.hasOwn(list, name)));
    } catch { return false; }
  });
}

/**
 * The answer of scanForUi, kept in the git dir (`kit-has-ui`) so a session start does not scan the whole tree again: it holds while the commit is
 * the same and the stamp is under an hour old. A component file added since (uncommitted) shows up with the next commit or the hour.
 */
function hasUi(root, ask) {
  const [gitDir, head] = ask(root, 'rev-parse', '--absolute-git-dir', 'HEAD').out.split('\n');
  const file = gitDir && head && join(gitDir, 'kit-has-ui');
  try {
    const stamp = file && JSON.parse(readFileSync(file, 'utf8'));
    if (stamp && stamp.head === head && Date.now() - stamp.at < 3600_000) return stamp.ui;
  } catch { /* no or broken stamp: scan */ }
  const ui = scanForUi(root, ask);
  try { if (file) writeFileSync(file, JSON.stringify({ head, ui, at: Date.now() })); } catch { /* best effort */ }
  return ui;
}

const folders = Object.values(agents).map(agent => agent.agents);
const skills = providers.map(provider => `${provider}/skills/impeccable`);
const windows = process.platform === 'win32';
const asset = `impeccable-${windows ? 'windows' : process.platform}-${windows ? 'x64' : process.arch}${windows ? '.exe' : ''}`;

const engineFile = windows ? 'impeccable.exe' : 'impeccable';

const filesBelow = (base, directory = '') => readdirSync(join(base, directory), { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? filesBelow(base, `${directory}${entry.name}/`) : [`${directory}${entry.name}`]).sort();

const companionFiles =base => folders.flatMap(directory => existsSync(join(base, directory))
  ? readdirSync(join(base, directory)).filter(name => /^impeccable[-_.][\w.-]+$/.test(name)).map(name => `${directory}/${name}`) : []);

export default {
  name: 'impeccable',
  label: 'Impeccable',
  source: '.vendor/impeccable',
  // The skills, generated per agent (every agent keeps its own copy), and the profile switch ("auto": on with UI files).
  skills: ['impeccable'],
  perAgent: true,
  feature: { default: 'auto', auto: hasUi, hint: ' (on when the project has UI files)' },

  build(c, next) {
    const version = c.versions.impeccable;
    const copyTracked = (from, to) => {
      const files = c.git('-C', c.source, 'ls-files', '-z', '--', from).split('\0').filter(Boolean);
      assert.ok(files.length, `Missing upstream files: ${from}`);
      for (const file of files) {
        assert.ok(file.startsWith(`${from}/`) && lstatSync(join(c.source, file)).isFile(), `Unexpected upstream path/link: ${file}`);
        const target = join(to, file.slice(from.length + 1));
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(c.source, file), target);
        // Match checkout line endings, including Windows command files, for stable regeneration.
        if (/(?:\.(?:md|json|js|toml|cmd|ya?ml)|\/(?:LICENSE|VERSION|impeccable))$/.test(file)) {
          let content = c.text(target);
          if (/\/reference\/(?:extract|harden|optimize)\.md$/.test(file))
            content = content.split('\n').map(line => line.trimEnd()).join('\n').trimEnd() + '\n';
          writeFileSync(target, file.endsWith('.cmd') ? content.replaceAll('\n', '\r\n') : content);
        }
      }
    };
    for (const skill of skills) {
      assert.equal(c.text(join(c.source, skill, 'scripts/VERSION')).trim(), version,
        'Upstream engine changed: review VERSION, SHA256SUMS and fixed hook definitions together');
      // Ignored local binaries/caches must never enter the pinned installation.
      copyTracked(skill, join(next, skill));
      // Release archives add these root attribution files to every provider package.
      for (const file of ['LICENSE', 'NOTICE.md']) writeFileSync(join(next, skill, file), c.text(join(c.source, file)));
      // Git for Windows may check upstream out as CRLF; the POSIX launcher needs LF.
      writeFileSync(join(next, skill, 'scripts/impeccable'), c.text(join(next, skill, 'scripts/impeccable')));
      chmodSync(join(next, skill, 'scripts/impeccable'), 0o755);
    }
    for (const agent of Object.values(agents)) copyTracked(agent.upstreamAgents, join(next, agent.agents));
    // The Codex definitions are committed once, in .codex/agents; the skill folder keeps the rest of agents/.
    for (const file of readdirSync(join(next, agents.codex.upstreamAgents)).filter(name => /^impeccable_.+\.toml$/.test(name)))
      rmSync(join(next, agents.codex.upstreamAgents, file));
    // Claude Code's folder commits only the files that differ from the shared one; the equal ones are copied on every setup and ignored by a generated .gitignore.
    const [shared, own] = skills.map(skill => join(next, skill));
    const equal = filesBelow(own).filter(file => existsSync(join(shared, file)) && readFileSync(join(shared, file)).equals(readFileSync(join(own, file))));
    writeFileSync(join(own, '.gitignore'), `# Generated by the workflow kit: these files equal ${skills[0]} and are copied by setup, not committed.\n${equal.map(file => `/${file}`).join('\n')}\n`);
    // Reject redirected ancestors before inspecting existing companion files.
    for (const directory of folders) checkDirectory(c.root, join(c.root, directory));
    const fresh = companionFiles(next), stale = companionFiles(c.root).filter(file => !fresh.includes(file));
    return {
      outputs: [...skills, ...fresh].map(file => [file, file]),
      retire: stale.map(file => join(c.root, file)),
      message: `Impeccable ${c.revision.slice(0, 7)}: committed Codex and Claude Code skills and companions refreshed.\n`
        + `Hook engine ${version} is installed by "provider.mjs impeccable install" and needs personal trust.`,
    };
  },

  install: {
    home: ['.impeccable', 'workflow-kit'],
    directory: version => `engine-${version}`,
    launcher: engineFile, // the engine itself: the hook runs it
    files(c, version) {
      assert.match(version, /^\d+\.\d+\.\d+$/);
      const pins = new Map(readFileSync(join(c.kit, 'scripts/impeccable/SHA256SUMS'), 'utf8').trim().split(/\r?\n/)
        .map(line => { const [hash, name] = line.trim().split(/\s+/); return [name, hash]; }));
      const sha256 = pins.get(asset);
      assert.match(sha256 ?? '', /^[a-f0-9]{64}$/, `No reviewed engine pin for ${asset}`);
      const base = process.env.IMPECCABLE_DOWNLOAD_BASE ?? 'https://github.com/pbakaus/impeccable/releases/download';
      return { [engineFile]: { url: `${base}/engine-v${version}/${asset}`, sha256, mode: 0o555 } };
    },
  },

  // Take over the pinned skill tag and its engine release into the kit's data, then regenerate everything.
  async update(c) {
    const { updateImpeccable } = await import('./impeccable-release.mjs'); // only the maintainer's update needs it
    await updateImpeccable(c.kit);
  },
};
