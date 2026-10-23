#!/usr/bin/env node
// Base load per task: what every agent reads before it starts (kit #747). Tokens are characters / 4.
// Usage: node scripts/measure-base-load.mjs [ROOT] [--skills a,b,c]   ROOT = a kit checkout (default: this one);
// --skills lists the skills a project activated (default: all skills in ROOT/.agents/skills).
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = args.indexOf('--skills');
const chosen = flag < 0 ? null : args.splice(flag, 2)[1].split(',');
const root = resolve(args[0] ?? new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const field = (text, name) => {
  const all = text.split(/\r?\n/);
  const lines = all.slice(1, all.indexOf('---', 1));
  const start = lines.findIndex(line => line.startsWith(`${name}:`));
  if (start < 0) return '';
  const rest = [lines[start].slice(name.length + 1).trim()];
  for (const line of lines.slice(start + 1)) { if (!/^\s/.test(line)) break; rest.push(line.trim()); }
  return rest.join(' ').replace(/^[>|][-+]?\s*/, '').replace(/^(["'])(.*)\1$/, '$2').trim();
};
const skills = readdirSync(join(root, '.agents/skills'), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && (!chosen || chosen.includes(entry.name)))
  .map(entry => {
    const text = readFileSync(join(root, '.agents/skills', entry.name, 'SKILL.md'), 'utf8');
    return `${field(text, 'name') || entry.name}: ${field(text, 'description')}`;
  });

const hook = (name, input) => {
  const run = spawnSync(process.execPath, [join(root, '.agents/hooks', name), 'claude'], {
    input: JSON.stringify(input), encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'k747-')) },
  });
  const out = run.stdout.trim();
  try { return JSON.parse(out).hookSpecificOutput?.additionalContext ?? ''; } catch { return out; }
};

const rows = [
  ['Regeln (AGENT_RULES.md)', readFileSync(join(root, 'AGENT_RULES.md'), 'utf8').length],
  [`Skill-Liste (${skills.length} Skills, Name + Beschreibung)`, skills.join('\n').length],
  ['Ponytail bei SessionStart', hook('ponytail-activate.js', { source: 'startup' }).length],
  ['Ponytail je Subagent (agent_type general-purpose)', hook('ponytail-subagent.js', { agent_type: 'general-purpose' }).length],
  ['Ponytail je Fork-Subagent (agent_type fork)', hook('ponytail-subagent.js', { agent_type: 'fork' }).length],
];
for (const [name, chars] of rows) console.log(`${name.padEnd(55)} ${String(chars).padStart(7)} Zeichen ${String(Math.round(chars / 4)).padStart(6)} Tokens`);
