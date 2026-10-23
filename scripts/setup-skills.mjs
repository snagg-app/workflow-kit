import assert from 'node:assert/strict';
import { lstatSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterCwd } from './checkout-root.mjs';
import { providers, sourceProviders } from './agents.mjs';
import { activeSkills, readProfile } from './project-profile.mjs';
import { checkDirectory, linkSkills, materialize } from './provider-links.mjs';
import { providerList, skillsOf } from './provider-list.mjs';
import { context, setup } from './provider.mjs';

/** The skills of the kit itself: the canonical copy lives in the kit's .agents/skills. */
const kitOwnedSkills = ['find-skills', 'spec-review'];

/**
 * Writes the skills of every provider and of the kit into the project the process runs in (see projectRoot in checkout-root.mjs),
 * then trims them to the project's "skills" choice. Throws on any problem; prints what it did.
 */
export async function setupSkills() {
  const c = context(), { kit, root } = c;
  // Check Matt's ownership manifests before another generator changes discovery files (the list is in that order).
  for (const provider of providerList()) await setup(provider, c);
  for (const skill of kitOwnedSkills) {
    const source = join(kit, '.agents/skills', skill);
    checkDirectory(kit, source);
    for (const provider of sourceProviders)
      materialize(root, join(root, provider, 'skills', skill), source);
  }
  linkSkills(root); // agents that read the shared skills through links
  // The project's "skills" choice: kit skills outside it go again. Skills of the project itself are never touched.
  const project = readProfile(root);
  const active = activeSkills(project);
  if (active) {
    const kitSkills = [...providerList().flatMap(provider => skillsOf(provider, root)), ...kitOwnedSkills];
    const unknown = active.filter(name => !kitSkills.includes(name));
    assert.deepEqual(unknown, [], `skills in .github/workflow-project.json names no kit skill: ${unknown.join(', ')}`);
    const removed = new Set(), removals = [];
    for (const name of kitSkills.filter(name => !active.includes(name)))
      for (const provider of providers) {
        const path = join(root, provider, 'skills', name), entry = lstatSync(path, { throwIfNoEntry: false });
        if (entry) {
          removed.add(name);
          removals.push([path, entry]);
        }
      }
    console.log(`Skills: ${active.length} ${project.skills === undefined ? 'core skills (no "skills" in the profile)' : 'chosen by the project'}, the other kit skills removed.`);
    // A project that committed these skills sees them vanish from git; name them and say how to keep them before deleting.
    if (removed.size) console.log(`Removing kit skills (not in "skills"): ${[...removed].sort().join(', ')}. To keep one, list it in "skills" in .github/workflow-project.json, or use "all" (docs/skill-core.md).`);
    // Generated copies come back with every run; moving them aside would refill .workflow-kit/replaced each time.
    for (const [path, entry] of removals) {
      if (entry.isSymbolicLink()) unlinkSync(path);
      else rmSync(path, { recursive: true });
    }
    if (!removed.size && project.skills === undefined) console.log('Missing a kit skill? Add "skills": ["core", "tdd"] to .github/workflow-project.json, or "all" to keep every kit skill (docs/skill-core.md).');
  }
  console.log('Skills generated for commit. Hook installation and personal trust are separate explicit steps.');
}

// `--cwd PROJECT_DIR` as the argument picks the project; the default is the checkout the command runs in.
if (process.argv[1] && realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url))) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: node <kit>/scripts/setup-skills.mjs [--cwd PROJECT_DIR]');
    process.exit(0);
  }
  enterCwd();
  await setupSkills();
}
