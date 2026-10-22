import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterCwd, projectRoot } from './checkout-root.mjs';
import { providers, sharedSkills, sourceProviders } from './agents.mjs';
import { activeSkills } from './project-profile.mjs';
import { checkDirectory, linkSkills, materialize } from './provider-links.mjs';

// Check Matt's ownership manifests before another generator changes discovery files.
// All setups act on the checkout they run in (see projectRoot in checkout-root.mjs); `--cwd PROJECT_DIR` as the
// first argument picks it, and the setups started below inherit that working directory.
enterCwd();
const scripts = dirname(fileURLToPath(import.meta.url));
for (const name of ['matt-pocock', 'ponytail', 'impeccable'])
  execFileSync(process.execPath, [join(scripts, 'provider.mjs'), name, 'setup'], { stdio: 'inherit' });
const kit = dirname(scripts), root = projectRoot();
// Kit-owned skills: the canonical copy lives in the kit's .agents/skills.
for (const skill of ['find-skills', 'spec-review']) {
  const source = join(kit, '.agents/skills', skill);
  checkDirectory(kit, source);
  for (const provider of sourceProviders)
    materialize(root, join(root, provider, 'skills', skill), source);
}
linkSkills(root); // agents that read the shared skills through links
// The project's "skills" choice: kit skills outside it go again. Skills of the project itself are never touched.
const profilePath = join(root, '.github/workflow-project.json');
const active = activeSkills(existsSync(profilePath) ? JSON.parse(readFileSync(profilePath, 'utf8')) : {});
if (active) {
  const manifest = join(root, sharedSkills, 'MATT-POCOCK-SOURCES.json');
  const kitSkills = [...Object.keys(JSON.parse(readFileSync(manifest, 'utf8')).skills), 'impeccable', 'find-skills', 'spec-review',
    ...readdirSync(join(root, sharedSkills)).filter(name => /^ponytail(?:-[a-z0-9]+)*$/.test(name))];
  const unknown = active.filter(name => !kitSkills.includes(name));
  assert.deepEqual(unknown, [], `skills in .github/workflow-project.json names no kit skill: ${unknown.join(', ')}`);
  for (const name of kitSkills.filter(name => !active.includes(name)))
    for (const provider of providers) {
      const path = join(root, provider, 'skills', name), entry = lstatSync(path, { throwIfNoEntry: false });
      // Generated copies come back with every run; moving them aside would refill .workflow-kit/replaced each time.
      if (entry?.isSymbolicLink()) unlinkSync(path);
      else if (entry) rmSync(path, { recursive: true });
    }
  console.log(`Skills: ${active.length} chosen by the project, the other kit skills removed.`);
}
console.log('Skills generated for commit. Hook installation and personal trust are separate explicit steps.');
