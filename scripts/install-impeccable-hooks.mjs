import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Setup from the checkout's pinned kit: run by ensure-hooks.mjs at session start, or by hand. The edit and Stop hooks never run this file.
const scripts = new URL("./impeccable/", import.meta.url);
const version = readFileSync(new URL("VERSION", scripts), "utf8").trim();
assert.match(version, /^\d+\.\d+\.\d+$/);
const windows = process.platform === "win32";
const asset = `impeccable-${windows ? "windows" : process.platform}-${windows ? "x64" : process.arch}${windows ? ".exe" : ""}`;
const pins = new Map(readFileSync(new URL("SHA256SUMS", scripts), "utf8").trim().split(/\r?\n/)
  .map((line) => { const [hash, name] = line.trim().split(/\s+/); return [name, hash]; }));
const expected = pins.get(asset);
assert.match(expected ?? "", /^[a-f0-9]{64}$/, `No reviewed engine pin for ${asset}`);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const directory = join(homedir(), ".impeccable", "workflow-kit", `engine-${version}`);
const target = join(directory, windows ? "impeccable.exe" : "impeccable");
mkdirSync(directory, { recursive: true });

if (!existsSync(target)) {
  const base = process.env.IMPECCABLE_DOWNLOAD_BASE ?? "https://github.com/pbakaus/impeccable/releases/download";
  const response = await fetch(`${base}/engine-v${version}/${asset}`, { signal: AbortSignal.timeout(120_000) });
  assert.ok(response.ok, `Engine download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(digest(bytes), expected, "Engine does not match repository SHA256SUMS; refusing installation");
  const temporary = mkdtempSync(join(directory, ".install-"));
  try {
    const staged = join(temporary, "engine");
    writeFileSync(staged, bytes, { flag: "wx", mode: 0o555 });
    chmodSync(staged, 0o555);
    try {
      // Atomic, exclusive publication. Never overwrite an installed hook executable.
      linkSync(staged, target);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
assert.equal(digest(readFileSync(target)), expected,
  "Installed hook engine differs from reviewed pin; inspect/remove it explicitly before reinstalling");
// A verified engine that lost its executable bit would keep the SessionStart hint alive: restore the mode on Unix.
if (!windows) chmodSync(target, 0o555);
// Name, never delete: other checkouts may still pin an older engine.
const list = (dir) => readdirSync(dir).filter((name) => !name.startsWith(".")).map((name) => join(dir, name));
const unused = list(join(directory, "..", "..")).flatMap((dir) => dir === join(directory, "..") ? list(dir).filter((old) => old !== directory) : [dir]);
if (unused.length) console.log(`Unused older Impeccable installations, delete when no checkout pins them: ${unused.join(", ")}`);
console.log(`Verified hook engine: ${target}\nReview and enable the project hooks in your agent.`);
