import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { externalTool, projectRoot } from "./checkout-root.mjs";
import { checkDirectory, localDirectory, materialize, moveAside } from "./provider-links.mjs";

// Explicit setup from a reviewed checkout, never an install/agent/Git hook.
const kit = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = projectRoot();
const source = join(kit, ".vendor/impeccable");
const state = join(root, ".impeccable");
const security = join(kit, "scripts/impeccable");
const providers = [".agents", ".claude"];
const skills = providers.map((provider) => `${provider}/skills/impeccable`);
const text = (path) => readFileSync(path, "utf8").replaceAll("\r\n", "\n");
// Resolve installed Git once; neither it nor child commands may come from checkout/PATH-relative entries.
const gitTool = externalTool("git", root, kit, process.cwd());
const git = (...args) => execFileSync(gitTool.file, args, { cwd: root, env: gitTool.env, encoding: "utf8" });

function companionFiles(base) {
  return [".claude/agents", ".codex/agents"]
    .flatMap((directory) => existsSync(join(base, directory))
      ? readdirSync(join(base, directory)).filter((name) => /^impeccable[-_.][\w.-]+$/.test(name))
        .map((name) => `${directory}/${name}`) : []);
}

function copyTracked(from, to) {
  const files = git("-C", source, "ls-files", "-z", "--", from).split("\0").filter(Boolean);
  assert.ok(files.length, `Missing upstream files: ${from}`);
  for (const file of files) {
    assert.ok(file.startsWith(`${from}/`) && lstatSync(join(source, file)).isFile(),
      `Unexpected upstream path/link: ${file}`);
    const target = join(to, file.slice(from.length + 1));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, file), target);
    // Match checkout line endings, including Windows command files, for stable regeneration.
    if (/(?:\.(?:md|json|js|toml|cmd|ya?ml)|\/(?:LICENSE|VERSION|impeccable))$/.test(file)) {
      let content = text(target);
      if (/\/reference\/(?:extract|harden|optimize)\.md$/.test(file))
        content = content.split("\n").map((line) => line.trimEnd()).join("\n").trimEnd() + "\n";
      writeFileSync(target, file.endsWith('.cmd') ? content.replaceAll('\n', '\r\n') : content);
    }
  }
}

/** Build one provider package from the pinned upstream. */
function generateSkill(skill, to) {
  // Ignored local binaries/caches must never enter the pinned installation.
  copyTracked(skill, to);
  // Release archives add these root attribution files to every provider package.
  for (const file of ["LICENSE", "NOTICE.md"])
    writeFileSync(join(to, file), text(join(source, file)));
  // Git for Windows may check upstream out as CRLF; the POSIX launcher needs LF.
  writeFileSync(join(to, "scripts/impeccable"), text(join(to, "scripts/impeccable")));
  chmodSync(join(to, "scripts/impeccable"), 0o755);
}

localDirectory(root, state);
git("-C", kit, "submodule", "update", "--init", "--", ".vendor/impeccable");
assert.equal(git("-C", source, "status", "--porcelain", "--untracked-files=all").trim(), "",
  "Impeccable submodule has local changes; preserve/review them before setup");
// assume-unchanged (lowercase tag) or skip-worktree (S) would hide edits from the status check above.
assert.ok(!/^(?:[a-z]|S) /m.test(git("-C", source, "ls-files", "-v")), "Impeccable source hides local changes from git status");
// submodule.<name>.update=none skips the checkout above; only the kit's pin may be packaged.
assert.equal(git("-C", source, "rev-parse", "HEAD").trim(), git("-C", kit, "rev-parse", ":.vendor/impeccable").trim(),
  "Impeccable source is not at the kit pin");
const version = JSON.parse(text(join(kit, "scripts/versions.json"))).impeccable;
const stage = mkdtempSync(join(state, "setup-"));
const next = join(stage, "next");
// ponytail: reviewed updates run serially; add a lock if updates become concurrent.
try {
  for (const skill of skills) {
    assert.equal(text(join(source, skill, "scripts/VERSION")).trim(), version,
      "Upstream engine changed: review VERSION, SHA256SUMS and fixed hook definitions together");
    generateSkill(skill, join(next, skill));
  }
  copyTracked(".claude/agents", join(next, ".claude/agents"));
  copyTracked(".agents/skills/impeccable/agents", join(next, ".codex/agents"));
  const revision = git("-C", source, "rev-parse", "HEAD").trim();
  // Reject redirected ancestors before replacing output or inspecting existing companion files.
  for (const directory of [".claude/agents", ".codex/agents"])
    checkDirectory(root, join(root, directory));
  const fresh = companionFiles(next), stale = companionFiles(root).filter((file) => !fresh.includes(file));
  for (const file of [...skills, ...stale, ...fresh]) localDirectory(root, dirname(join(root, file)));
  checkDirectory(root, join(root, ".workflow-kit/replaced"));
  for (const file of [...skills, ...fresh]) materialize(root, join(root, file), join(next, file));
  for (const file of stale) moveAside(root, join(root, file));
  console.log(`Impeccable ${revision.slice(0, 7)}: committed Codex and Claude Code skills and companions refreshed.\n`
    + `Hook engine ${version} requires explicit installation with install-impeccable-hooks.mjs and personal trust.`);
} finally {
  // Only this invocation's generated staging, confined to state.
  assert.equal(dirname(stage), state);
  assert.ok(!lstatSync(stage).isSymbolicLink());
  rmSync(stage, { recursive: true, force: true });
}
