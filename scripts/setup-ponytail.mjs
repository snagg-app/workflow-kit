// Generate committed Ponytail discovery files during reviewed kit updates, never per checkout/task.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { externalTool, projectRoot } from './checkout-root.mjs';
import { checkDirectory, localDirectory, materialize, moveAside } from './provider-links.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = projectRoot();
const source = join(kit, '.vendor/ponytail');
const state = join(root, '.workflow-kit');
const providers = ['.agents', '.claude'];
const text = p => readFileSync(p, 'utf8').replaceAll('\r\n', '\n');
const gitTool = externalTool('git', root, kit, process.cwd());
const git = (...args) => execFileSync(gitTool.file, args, { cwd: root, env: gitTool.env, encoding: 'utf8' });
const skillName = /^ponytail(?:-[a-z0-9]+)*$/;

localDirectory(root, state);
if (existsSync(join(source, '.git'))) assert.equal(git('-C', source, 'status', '--porcelain', '--untracked-files=all').trim(), '', 'Ponytail source has local changes');
git('-C', kit, 'submodule', 'update', '--init', '--', '.vendor/ponytail');
// assume-unchanged (lowercase tag) or skip-worktree (S) would hide edits from the status check above.
assert.ok(!/^(?:[a-z]|S) /m.test(git('-C', source, 'ls-files', '-v')), 'Ponytail source hides local changes from git status');
const revision = git('-C', source, 'rev-parse', 'HEAD').trim();
// submodule.<name>.update=none skips the checkout above; only the kit's pin may be packaged.
assert.equal(revision, git('-C', kit, 'rev-parse', ':.vendor/ponytail').trim(), 'Ponytail source is not at the kit pin');
const skills = git('-C', source, 'ls-tree', '-d', '--name-only', `${revision}:skills`).trim().split('\n');
assert.ok(skills.includes('ponytail') && skills.every(s => skillName.test(s)), 'Invalid pinned skill names');
const files = [...skills.map(s => `skills/${s}/SKILL.md`),
  ...['activate', 'config', 'instructions', 'mode-tracker', 'runtime', 'subagent'].map(n => `hooks/ponytail-${n}.js`)];
// The source is clean and at the pin, so its working tree holds the pinned files.
const contents = new Map([...files, 'LICENSE'].map(file => [file, text(join(source, file))]));
const stage = mkdtempSync(join(state, 'setup-'));
const next = join(stage, 'next');
try {
  for (const file of files) {
    const p = join(next, '.agents', file);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, contents.get(file));
  }
  git('apply', '--whitespace=error-all', `--directory=${relative(root, join(next, '.agents')).split(sep).join('/')}`,
    join(kit, 'scripts/ponytail/adaptations.patch'));
  for (const file of files) writeFileSync(join(next, '.agents', file), text(join(next, '.agents', file)));
  const license = contents.get('LICENSE');
  writeFileSync(join(next, '.agents/hooks/LICENSE.md'), license);
  writeFileSync(join(next, '.agents/skills/ponytail/LICENSE.md'), license);
  writeFileSync(join(next, '.agents/skills/ponytail/NOTICE.md'), text(join(kit, 'scripts/ponytail/NOTICE.md')));
  const outputs = providers.flatMap(p => skills.map(s => [`${p}/skills/${s}`, `.agents/skills/${s}`]));
  outputs.push(['.agents/hooks', '.agents/hooks']);
  // Reject redirected ancestors before replacing any output. Old skill junctions themselves migrate safely.
  for (const [dest] of outputs) localDirectory(root, dirname(join(root, dest)));
  checkDirectory(root, join(state, 'replaced'));
  for (const [dest, from] of outputs) materialize(root, join(root, dest), join(next, from));
  // Preserve skills dropped upstream, including a project's files at a kit-owned name.
  for (const directory of providers.map(p => join(root, p, 'skills')))
    for (const entry of readdirSync(directory).filter(name => skillName.test(name)))
      if (!skills.includes(entry)) moveAside(root, join(directory, entry));
  console.log(`Ponytail ${revision.slice(0, 7)}: committed Codex and Claude Code skills and hook sources refreshed.`);
} finally {
  assert.equal(dirname(stage), state);
  assert.ok(!lstatSync(stage).isSymbolicLink());
  rmSync(stage, { recursive: true, force: true });
}
