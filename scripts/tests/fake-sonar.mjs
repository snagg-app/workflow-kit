// The test variant of the Sonar door (sonar.mjs): answers from files in the working directory instead of the network.
// `sonar.json` is { status, total, issues }; every request is noted in `sonar-requests` as [url, Authorization header].
import { appendFileSync, readFileSync } from 'node:fs';

export function fakeSonar(href, token) {
  appendFileSync('sonar-requests', `${JSON.stringify([href, `Bearer ${token}`])}\n`);
  const { status, total, issues } = JSON.parse(readFileSync('sonar.json', 'utf8'));
  return { ok: status === 200, status, text: JSON.stringify({ total, issues }) };
}
