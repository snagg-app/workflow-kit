// Zweck: Die Anbieterliste ist die einzige Quelle für Skills und Schalter (#757).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { projectFeatures } from '../project-profile.mjs';
import { featureProviders, ownSkills, providerList } from '../provider-list.mjs';

test('every provider describes its skills and the switch of each installable one', () => {
  for (const provider of providerList()) {
    assert.ok(Array.isArray(provider.skills) || typeof provider.skills === 'function', `${provider.name} names its skills`);
    if (provider.install) assert.ok(provider.feature, `${provider.name} has a switch in the profile`);
  }
  assert.deepEqual(ownSkills(), ['impeccable']);
});

test('the profile switches are exactly the providers with a feature', t => {
  const root = mkdtempSync(join(tmpdir(), 'provider-list-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.github'));
  writeFileSync(join(root, '.github/workflow-project.json'), '{"impeccable": false}');
  assert.deepEqual(Object.keys(projectFeatures(root)).sort(), featureProviders().map(provider => provider.name).sort());
});

test('the hook events come from the providers, and every named handler is callable (#795)', async () => {
  const { hookEvents } = await import('../hooks.mjs');
  const named = providerList().flatMap(provider => Object.entries(provider.hooks ?? {}));
  assert.ok(named.length && named.every(([, hook]) => typeof hook.run === 'function'));
  for (const [event] of named) assert.ok(hookEvents.includes(event), `${event} is a hook event`);
});
