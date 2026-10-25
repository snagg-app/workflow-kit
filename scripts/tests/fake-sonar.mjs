// The test variant of the Sonar door (sonar.mjs): answers from files in the working directory instead of the network.
// `sonar.json` is { status, total, issues }, without it the analysis is clean; every request is noted in `sonar-requests` as [url, Authorization header].
// The same door answers when no token is set (the real one then runs the `sonar` CLI, #1055).
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

export function fakeSonar(href, token) {
  appendFileSync('sonar-requests', `${JSON.stringify([href, `Bearer ${token}`])}\n`);
  const { status, total, issues } = existsSync('sonar.json') ? JSON.parse(readFileSync('sonar.json', 'utf8')) : { status: 200, total: 0, issues: [] };
  return { ok: status === 200, status, text: JSON.stringify({ total, issues }) };
}
