// Zweck: `kit setup` stellt sicher, dass `node` in einer NICHT-interaktiven Shell gefunden wird (Hooks laufen so; #1068).
// Aufruf: import { ensureNode, realSystem } (kit.mjs setup). Die Entscheidung steht in reinen Funktionen; Registry, Profile, winget und brew liegen hinter `system`, Tests geben eine Attrappe.
// Nutzen: Nur wenn Node fehlt, wird einmal der stabile Standard-Ordner des Versionsmanagers (fnm) eingetragen oder Node installiert; ein zweiter Lauf ändert nichts.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path, { join } from 'node:path';
import { nodeTooOld } from './versions.mjs';

export const BLOCK_START = '# workflow-kit node (begin)';
export const BLOCK_END = '# workflow-kit node (end)';

/** `value` (a PATH) with `entry` appended once; nothing is shortened or reordered. `fold`: compare without case and trailing slash (Windows). */
export function addPathEntry(value, entry, { sep = ';', fold = false } = {}) {
  const key = text => (fold ? text.toLowerCase() : text).replace(/[\\/]+$/, '');
  const text = value ?? '';
  if (text.split(sep).some(part => part && key(part) === key(entry))) return { value: text, changed: false };
  return { value: text && !text.endsWith(sep) ? text + sep + entry : text + entry, changed: true };
}

/** The profile text with the marked block for `dir` (replaced when present, appended otherwise). */
export function withProfileBlock(text, dir) {
  const block = `${BLOCK_START}\nexport PATH="$PATH:${dir}"\n${BLOCK_END}\n`;
  // The last start before the end marker: a stray start marker never swallows the lines after it.
  const to = text.indexOf(BLOCK_END), from = text.lastIndexOf(BLOCK_START, to);
  if (from >= 0 && to > from) return text.slice(0, from) + block + text.slice(to + BLOCK_END.length).replace(/^\n/, '');
  return text + (text && !text.endsWith('\n') ? '\n' : '') + block;
}

/** Folders that hold the stable default Node of fnm (and Homebrew on macOS), in the order to try. */
export function nodeDirCandidates({ platform, env, home }) {
  const win = platform === 'win32', pjoin = win ? path.win32.join : path.posix.join;
  const roots = win
    ? [env.FNM_DIR, env.APPDATA && pjoin(env.APPDATA, 'fnm')]
    : [env.FNM_DIR, env.XDG_DATA_HOME && pjoin(env.XDG_DATA_HOME, 'fnm'), pjoin(home, '.local/share/fnm'), pjoin(home, 'Library/Application Support/fnm')];
  const dirs = roots.filter(Boolean).map(root => pjoin(root, 'aliases/default', win ? '' : 'bin'));
  if (platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  return dirs.map(dir => dir.replace(/[\\/]+$/, ''));
}

/** Profile files for non-interactive shells: zsh reads .zshenv always; bash reads .bash_profile (or .profile) only as a login shell. */
export function profileFiles({ platform, home, hasZsh, exists }) {
  const files = [exists(path.posix.join(home, '.bash_profile')) ? '.bash_profile' : '.profile'];
  if (platform === 'darwin' || hasZsh) files.push('.zshenv');
  return files.map(name => path.posix.join(home, name));
}

const WINGET = ['winget', 'install', '--id', 'OpenJS.NodeJS.LTS', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'];
const FNM_INSTALL = 'curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell --install-dir ~/.local/share/fnm && ~/.local/share/fnm/fnm install --lts && ~/.local/share/fnm/fnm default lts-latest';

/** The manual command for the person when the automatic route failed. */
export const manualCommand = platform => platform === 'win32' ? WINGET.join(' ') : platform === 'darwin' ? 'brew install node' : FNM_INSTALL;

/**
 * Makes `node` findable in a non-interactive shell. `sys`: { platform, env, home, findNode() -> version | undefined, hasNode(dir), addToPath(dir) -> text,
 * install() -> text | undefined }. Returns { state: 'ok' | 'error', note?, hint? }.
 */
export function ensureNode(sys) {
  const good = () => { const version = sys.findNode(); return version && !nodeTooOld(version.replace(/^v/, '')) ? version : undefined; };
  if (good()) return { state: 'ok', note: 'node in nicht-interaktiver Shell gefunden' };
  const dirs = () => nodeDirCandidates(sys);
  let changed = '';
  let dir = dirs().find(candidate => sys.hasNode(candidate));
  // A failed install (winget needs elevation, no network) ends in the red result with the manual command below.
  if (!dir) { try { changed = sys.install() ?? ''; } catch { /* reported below */ } dir = dirs().find(candidate => sys.hasNode(candidate)); }
  // After an install the folder may already be on the PATH (winget, brew): add it only when a fresh shell still misses node.
  if (dir && !(changed && good())) changed = [changed, sys.addToPath(dir)].filter(Boolean).join('; ');
  if (good()) return { state: 'ok', note: `${changed || 'node jetzt gefunden'}; neue Shells/Sitzungen nötig` };
  return { state: 'error', hint: `Node fehlt oder ist zu alt. Von Hand: ${manualCommand(sys.platform)}` };
}

const sh = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 600000, ...options }).trim();
const tryRun = (...call) => { try { return sh(...call); } catch { return ''; } };
const REG = { user: 'HKCU:\\Environment', machine: 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment' };
// UTF-8 out, so umlauts in a PATH entry survive the round trip; `run` = sh throws on a failed read (the write must not go on with an empty value).
const readRegistry = (hive, run = tryRun) => run('powershell', ['-NoProfile', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-Item '${REG[hive]}').GetValue('Path','','DoNotExpandEnvironmentNames')`]);

/** The real machine: Windows registry via PowerShell, profiles on macOS/Linux, winget / brew / the fnm installer. */
export function realSystem({ platform = process.platform, env = process.env, home = env.HOME ?? env.USERPROFILE } = {}) {
  const win = platform === 'win32';
  const expand = text => text.replace(/%([^%]+)%/g, (all, name) => env[name] ?? all);
  const exe = win ? 'node.exe' : 'node';
  const nodeExists = dir => existsSync(join(dir, exe));
  return {
    platform, env, home,
    hasNode: nodeExists,
    findNode() {
      if (win) {
        // A new shell gets machine + user PATH from the registry, not the PATH of this process.
        const dir = expand(`${readRegistry('machine')};${readRegistry('user')}`).split(';').find(part => part && nodeExists(part));
        return dir ? tryRun(join(dir, exe), ['--version']) : undefined;
      }
      const clean = { HOME: home, PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' };
      return tryRun('bash', ['-c', 'node --version'], { env: clean }) || tryRun('bash', ['-lc', 'node --version'], { env: clean }) || undefined;
    },
    addToPath(dir) {
      if (win) {
        const { value, changed } = addPathEntry(readRegistry('user', sh), dir, { fold: true });
        if (!changed) return '';
        // ExpandString keeps %VAR% entries; the dummy variable write broadcasts the change to running programs.
        sh('powershell', ['-NoProfile', '-Command', "Set-ItemProperty -Path 'HKCU:\\Environment' -Name Path -Value $env:KIT_NEW_PATH -Type ExpandString; [Environment]::SetEnvironmentVariable('KIT_PATH_REFRESH',$null,'User')"], { env: { ...env, KIT_NEW_PATH: value } });
        return `Benutzer-PATH: ${dir} ergänzt (Registry HKCU\\Environment)`;
      }
      const hasZsh = !!tryRun('sh', ['-c', 'command -v zsh']);
      const files = profileFiles({ platform, home, hasZsh, exists: existsSync });
      for (const file of files) {
        let text = '';
        try { text = readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        writeFileSync(file, withProfileBlock(text, dir));
      }
      return `Profil ergänzt (${files.join(', ')}): ${dir}`;
    },
    install() {
      if (win) { sh(WINGET[0], WINGET.slice(1)); return 'Node per winget installiert'; }
      if (platform === 'darwin' && tryRun('sh', ['-c', 'command -v brew || ls /opt/homebrew/bin/brew'])) { sh('sh', ['-c', 'brew install node || /opt/homebrew/bin/brew install node']); return 'Node per brew installiert'; }
      sh('bash', ['-c', FNM_INSTALL]);
      return 'Node per fnm installiert (~/.local/share/fnm)';
    },
  };
}
