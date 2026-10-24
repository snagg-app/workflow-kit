// Anbieter Ponytail (DietrichGebert/ponytail): Skills und Hook-Quellen, angepasst durch scripts/ponytail/adaptations.patch. Die Engine steht in provider.mjs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { agentLabels, providers, sharedSkills, sourceProviders } from './agents.mjs';
import { setVersion } from './versions.mjs';

const patch = 'scripts/ponytail/adaptations.patch';
const skillName = /^ponytail(?:-[a-z0-9]+)*$/;
const hooks = ['activate', 'config', 'instructions', 'mode-tracker', 'runtime', 'subagent'].map(name => `ponytail-${name}`);
// What the personal installation copies from the project's committed files.
const installed = ['.agents/hooks/LICENSE.md', ...hooks.map(name => `.agents/hooks/${name}.js`),
  '.agents/skills/ponytail/SKILL.md', '.agents/skills/ponytail/LICENSE.md', '.agents/skills/ponytail/NOTICE.md'];
/** The committed files the personal installation copies, by name. */
const sources = root => installed.map(file => {
  if (!existsSync(path.join(root, file))) throw new Error(`Committed Ponytail sources missing in ${root} (${file}); restore the project's skill/hook files or complete its reviewed kit update.`);
  return [file, readFileSync(path.join(root, file))];
});
/** Version plus a hash of the copied files: checkouts at different states get different snapshots instead of refusing each other's. */
export function snapshotDirectory(version, root) {
  const hash = createHash('sha256');
  for (const [file, bytes] of sources(root)) hash.update(`${file}|${bytes.length}|`).update(bytes);
  return `${version}-${hash.digest('hex').slice(0, 12)}`;
}
const put = (file, content) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content); };

/** The installed snapshots are personal and pinned to the Node that installed them, never a PATH lookup. */
function launcher(file, agent, action, ...extra) {
  const args = [action, agent, ...extra];
  return process.platform === 'win32'
    ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `""${file}" ${args.join(' ')}"`], options: { windowsVerbatimArguments: true } }
    : { file: '/bin/sh', args: [file, ...args], options: {} };
}

/** SessionStart and SubagentStart: the launcher's answer joins the hook's output (`h` is the hook context of kit-hook.mjs). */
function start(h) {
  const file = h.installed(self);
  const command = file && launcher(file, h.agent, h.event === 'SessionStart' ? 'activate' : 'subagent', ...(h.event === 'SessionStart' && !h.fresh ? ['continue'] : []));
  if (!command) {
    if (h.event === 'SessionStart') h.say(h.texts().hooksOff(self.label, h.installCommand(self)));
    return;
  }
  const child = spawnSync(command.file, command.args, { ...command.options, input: h.raw, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  h.exitCode = child.status ?? 0;
  const text = (child.stdout ?? '').trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed.systemMessage) h.user.push(parsed.systemMessage);
    if (parsed.hookSpecificOutput?.additionalContext) h.context.push(parsed.hookSpecificOutput.additionalContext);
  } catch { if (text) h.context.push(text); }
}

const self = {
  name: 'ponytail',
  label: 'Ponytail',
  source: '.vendor/ponytail',
  // The skills the project has after setup, and the profile switch ("ponytail": false turns the hooks off).
  skills: root => existsSync(path.join(root, sharedSkills)) ? readdirSync(path.join(root, sharedSkills)).filter(name => skillName.test(name)) : [],
  feature: { default: true },
  // The hook events this provider answers; an entry with `kind` also owns the event's settings (hooks.mjs).
  hooks: {
    UserPromptSubmit: { kind: 'simple', timeout: 5, run: h => h.passThrough((file => file && launcher(file, h.agent, 'mode-tracker'))(h.installed(self))) },
    SessionStart: { run: start },
    SubagentStart: { run: start },
  },

  build(c, next) {
    const skills = c.git('-C', c.source, 'ls-tree', '-d', '--name-only', `${c.revision}:skills`).trim().split('\n');
    assert.ok(skills.includes('ponytail') && skills.every(s => skillName.test(s)), 'Invalid pinned skill names');
    const files = [...skills.map(s => `skills/${s}/SKILL.md`), ...hooks.map(name => `hooks/${name}.js`)];
    const agents = path.join(next, '.agents');
    // The source is clean and at the pin, so its working tree holds the pinned files.
    for (const file of files) put(path.join(agents, file), c.text(path.join(c.source, file)));
    c.git('apply', '--whitespace=error-all', `--directory=${path.relative(c.root, agents).split(path.sep).join('/')}`, path.join(c.kit, patch));
    for (const file of files) put(path.join(agents, file), c.text(path.join(agents, file)));
    const license = c.text(path.join(c.source, 'LICENSE'));
    put(path.join(agents, 'hooks/LICENSE.md'), license);
    put(path.join(agents, 'skills/ponytail/LICENSE.md'), license);
    put(path.join(agents, 'skills/ponytail/NOTICE.md'), c.text(path.join(c.kit, 'scripts/ponytail/NOTICE.md')));
    const outputs = sourceProviders.flatMap(p => skills.map(s => [`${p}/skills/${s}`, `.agents/skills/${s}`]));
    outputs.push(['.agents/hooks', '.agents/hooks']);
    // Skills dropped upstream, including a project's files at a kit-owned name, move aside.
    const retire = providers.map(p => path.join(c.root, p, 'skills')).filter(existsSync)
      .flatMap(dir => readdirSync(dir).filter(name => skillName.test(name) && !skills.includes(name)).map(name => path.join(dir, name)));
    return { outputs, retire, message: `Ponytail ${c.revision.slice(0, 7)}: committed ${agentLabels()} skills and hook sources refreshed.` };
  },

  install: {
    home: ['.ponytail', 'workflow-kit'],
    directory: (version, c) => snapshotDirectory(version, c.root),
    launcher: process.platform === 'win32' ? 'launch.cmd' : 'launch.sh', // the hook starts this file
    // The launchers pin the Node that runs the installer, which must be personal trusted code too.
    before: c => c.outside(path.dirname(realpathSync(process.execPath)), 'Run the installer with a Node installed outside Git checkouts.'),
    files: c => Object.fromEntries(sources(c.root).map(([file, bytes]) => [file, { bytes }])),
    // The launchers only bind this Node; rerunning the installer after a Node change rewrites them.
    after(destination) {
      const node = realpathSync(process.execPath);
      const hookDirectory = path.join(destination, '.agents', 'hooks');
      const shellQuote = String.raw`'\''`;
      const sh = value => `'${value.replaceAll('\\', '/').replaceAll("'", shellQuote)}'`;
      const cmd = value => value.replaceAll('%', '%%');
      // A removed Node (version manager update) must not switch the hooks off silently: SessionStart says so; kit-hook.mjs reinstalls at the same start.
      const hint = JSON.stringify({ systemMessage: 'Ponytail hooks are OFF: the pinned Node is gone. They reinstall themselves at session start (needs node on PATH): restart the session once. If still OFF, run node .vendor/workflow-kit/scripts/provider.mjs ponytail install (maintainer pre-authorized, writes no trust).' });
      const launchers = {
        'launch.sh': `#!/bin/sh
# Generated by provider.mjs: starts the Node that ran the installer, never a PATH lookup.
case "$1" in activate|subagent|mode-tracker) ;; *) exit 2;; esac
unset NODE_OPTIONS NODE_PATH
[ -f ${sh(node)} ] || { [ "$1" = activate ] && printf '%s\\n' '${hint}'; exit 0; }
exec ${sh(node)} ${sh(hookDirectory)}'/ponytail-'"$1"'.js' "$2" "\${3:-}"
`,
        // One file for cmd.exe and POSIX shells: cmd skips the ':' label line, sh skips the heredoc.
        'launch.cmd': `: <<'WINDOWS'
@echo off
setlocal
set NODE_OPTIONS=
set NODE_PATH=
if not "%~1"=="activate" if not "%~1"=="subagent" if not "%~1"=="mode-tracker" exit /b 2
if not exist "${cmd(node)}" (
if "%~1"=="activate" echo ${cmd(hint)}
exit /b 0
)
"${cmd(node)}" "${cmd(hookDirectory)}\\ponytail-%~1.js" %2 %3
exit /b %errorlevel%
WINDOWS
exec /bin/sh "\${0%/*}/launch.sh" "$@"
`,
      };
      for (const [name, content] of Object.entries(launchers)) {
        const temporary = path.join(destination, `.${name}.tmp`);
        writeFileSync(temporary, content, { mode: 0o755 });
        renameSync(temporary, path.join(destination, name));
      }
    },
  },

  // Port the adaptation patch to the new pin (a real conflict stops with the file name), then publish.
  async update(c, from) {
    const { updatePatch } = await import('./ponytail-patch.mjs'); // only the maintainer's update needs it
    await updatePatch(c.kit, this.source, patch, from);
    // The snapshot folder name comes from the manifest, so it must name the pinned version (Impeccable's release does the same).
    const ponytail = JSON.parse(c.text(path.join(c.kit, this.source, 'package.json'))).version;
    setVersion('ponytail', ponytail, c.kit);
    await c.setup();
  },
};

export default self;
