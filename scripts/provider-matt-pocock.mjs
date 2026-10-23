// Anbieter Matt Pocock (mattpocock/skills): vollstaendige Skill-Baeume, ohne Upstream-Code auszufuehren. Die Engine steht in provider.mjs.
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { agentLabels, providers, sharedSkills, sourceProviders } from './agents.mjs';
import { adaptCodeReview } from './code-review-failure-paths.mjs';
import { checkDirectory } from './write-guard.mjs';

// Documented deviations from upstream (docs/matt-pocock.md): agents run the retro before every
// handoff, which upstream's `disable-model-invocation` makes the Skill tool refuse (#212), and
// `implement` leaves the full suite to CI (#230).
const implementTests = [', and the full test suite once at the end.', ', and leave the full test suite to CI (run it once at the end only if CI does not).'];
// Only a human closes a spec (AGENT_RULES.md, Hard rules, #508): the integration PR of `implement-spec` closes the tickets, and `chief-of-staff` is told.
const specRule = ['All work should be done in subagents. Protect your context window.\n',
  'All work should be done in subagents. Protect your context window.\n\nNo agent closes a spec or sets it to Done, a subagent and you included: only a human accepts a spec (`AGENT_RULES.md`, Hard rules).\n'];
const specPr = [' marked as closing the spec and tickets.', ' marked as closing the tickets, never the spec (only a human closes a spec: `AGENT_RULES.md`, Hard rules).'];
const adapt = (skill, path, content) => path !== 'SKILL.md' ? content
  : skill === 'retro' ? content.replace(/^disable-model-invocation: true\n/m, '')
    : skill === 'implement' ? content.replace(implementTests[0], implementTests[1])
      : skill === 'implement-spec' ? content.replace(specPr[0], specPr[1])
        : skill === 'chief-of-staff' ? content.replace(specRule[0], specRule[1])
          : skill === 'code-review' ? adaptCodeReview(content) : content;

export default {
  name: 'matt-pocock',
  label: 'Matt Pocock',
  source: '.vendor/matt-pocock-skills',
  // The skills the pinned source gave the project (its ownership manifest); no profile switch: the "skills" choice trims them.
  skills: root => Object.keys(JSON.parse(readFileSync(join(root, sharedSkills, 'MATT-POCOCK-SOURCES.json'), 'utf8')).skills),

  build(c, next) {
    const files = c.git('-C', c.source, 'ls-tree', '-r', '-z', c.revision, '--', 'skills', 'LICENSE')
      .split('\0').filter(Boolean).map(record => {
        const match = /^(100644|100755) blob [a-f0-9]+\t(.+)$/.exec(record);
        assert.ok(match, 'Pinned Matt Pocock source must contain ordinary files');
        const [, mode, path] = match;
        assert.ok(path.split('/').every(part => /^[a-z0-9][a-z0-9._-]*$/i.test(part)
          && !/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(part)
          && !part.endsWith('.')), `Unsafe upstream path: ${path}`);
        checkDirectory(c.source, dirname(join(c.source, path)));
        assert.ok(lstatSync(join(c.source, path)).isFile(), `Unexpected upstream link: ${path}`);
        return { mode, path };
      });
    const skills = files.filter(file => file.path.endsWith('/SKILL.md')).map(file => dirname(file.path).replaceAll('\\', '/'));
    const names = skills.map(path => basename(path));
    assert.ok(skills.length && names.every(name => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)), 'Invalid pinned skill names');
    assert.equal(new Set(names).size, names.length, 'Duplicate pinned skill names');
    assert.ok(files.some(file => file.path === 'LICENSE'), 'Missing upstream license');

    // A previous manifest owns only its validated skill names; never sweep unrelated provider directories.
    const retire = [];
    for (const provider of providers) {
      const directory = join(c.root, provider, 'skills');
      checkDirectory(c.root, directory);
      const manifest = join(directory, 'MATT-POCOCK-SOURCES.json');
      const entry = lstatSync(manifest, { throwIfNoEntry: false });
      if (!entry) continue;
      assert.ok(entry.isFile(), `Previous Matt Pocock manifest must be an ordinary file: ${manifest}`);
      const previous = JSON.parse(c.text(manifest));
      assert.ok(previous?.repository === 'https://github.com/mattpocock/skills'
        && /^[a-f0-9]{40}$/.test(previous.revision) && previous.license === 'MATT-POCOCK-LICENSE.md'
        && previous.skills && typeof previous.skills === 'object' && !Array.isArray(previous.skills),
      `Invalid previous Matt Pocock manifest: ${manifest}`);
      for (const [name, path] of Object.entries(previous.skills)) {
        assert.ok(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && !/^(?:con|prn|aux|nul|com\d|lpt\d)$/.test(name)
          && typeof path === 'string' && /^skills\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(path)
          && path.endsWith(`/${name}`), `Invalid previous Matt Pocock skill: ${name}`);
        if (!names.includes(name)) retire.push(join(directory, name));
      }
    }

    for (const skill of skills) {
      const entries = files.filter(file => file.path.startsWith(`${skill}/`));
      const relativePaths = entries.map(file => file.path.slice(skill.length + 1));
      assert.equal(new Set(relativePaths.map(path => path.toLowerCase())).size, relativePaths.length, `Case-colliding files in ${skill}`);
      for (const { mode, path } of entries) {
        const target = join(next, basename(skill), path.slice(skill.length + 1));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, adapt(basename(skill), path.slice(skill.length + 1), c.text(join(c.source, path))));
        chmodSync(target, mode === '100755' ? 0o755 : 0o644);
      }
    }
    writeFileSync(join(next, 'MATT-POCOCK-LICENSE.md'), c.text(join(c.source, 'LICENSE')));
    writeFileSync(join(next, 'MATT-POCOCK-SOURCES.json'), JSON.stringify({
      repository: 'https://github.com/mattpocock/skills', revision: c.revision,
      license: 'MATT-POCOCK-LICENSE.md',
      skills: Object.fromEntries(skills.map(path => [basename(path), path])),
    }, null, 2) + '\n');
    const outputs = sourceProviders.flatMap(provider => [...names, 'MATT-POCOCK-LICENSE.md', 'MATT-POCOCK-SOURCES.json']
      .map(name => [`${provider}/skills/${name}`, name]));
    return { outputs, retire, message: `Matt Pocock ${c.revision.slice(0, 7)}: ${skills.length} complete skill trees published for ${agentLabels()}.` };
  },
};
