// `start`: the `blocked` label and the hint about related work of the last 48 hours (#1056).
// Its functions run nothing when imported; run-time data comes from board-context.mjs.
import { rest } from './board-context.mjs';

export const blockedLabel = 'blocked';
const WINDOW_MS = 48 * 3600 * 1000, MAX_TERMS = 5, MAX_HITS = 5;

export const isBlocked = issue => (issue.labels?.nodes ?? []).some(label => label.name.toLowerCase() === blockedLabel);

/** The reason in the issue text: the first line that names a prerequisite or a wait, else a pointer to the text. */
export function blockedReason(body = '') {
  const line = body.split('\n').map(text => text.replace(/^[\s>*_#-]+/, '').trim()).find(text => /^(voraussetzung|blockiert|wartet|blocked|waits|prerequisite)/i.test(text));
  return line ? `"${line.slice(0, 200)}"` : 'no reason line (Voraussetzung/Blockiert/Wartet) in the issue text: read it';
}

/** Backtick values that name a path, a Java-style class or a test: what another PR about the same work would repeat. */
export function relatedTerms(body = '') {
  const found = [...body.matchAll(/`([^`\s]{4,120})`/g)].map(([, text]) => text.replace(/^\.\//, ''))
    .filter(text => !/^https?:/.test(text) && !/[*<>{}$?|"]/.test(text))
    .filter(text => /\/[^/]*\.[A-Za-z]{1,6}$/.test(text) || /^[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+(?:\.[a-z]\w*)?$/.test(text) || /^[a-z]+(?:_[a-z0-9]+){2,}$/.test(text));
  return [...new Set(found)].slice(0, MAX_TERMS);
}

/** One REST search (issues and PRs together): open or merged work of the last 48 hours that names a term of the issue. A hint only, so a failed search says so and goes on. */
export function relatedLines(issue, repository, now = Date.now()) {
  const terms = relatedTerms(issue.body);
  if (!terms.length) return [];
  const since = new Date(now - WINDOW_MS).toISOString().slice(0, 10);
  const query = `repo:${repository} updated:>=${since} (${terms.map(term => `"${term}"`).join(' OR ')})`;
  let items;
  try { items = rest(`search/issues?advanced_search=true&sort=updated&order=desc&per_page=20&q=${encodeURIComponent(query)}`).items ?? []; } catch (error) {
    return [`note: the search for related work failed (${String(error.stderr || error.message).trim().split('\n')[0]}); no hint`];
  }
  const hits = items.filter(item => item.number !== issue.number && Date.parse(item.updated_at) >= now - WINDOW_MS
    && (!item.pull_request || item.state === 'open' || item.pull_request.merged_at)).slice(0, MAX_HITS);
  if (!hits.length) return [];
  return [`related work of the last 48 h (names ${terms.map(term => `\`${term}\``).join(', ')}; check it before you start):`,
    ...hits.map(item => `- #${item.number} ${item.pull_request ? (item.pull_request.merged_at ? 'PR merged' : 'PR open') : item.state === 'open' ? 'issue open' : 'issue closed'}: ${item.title}`)];
}
