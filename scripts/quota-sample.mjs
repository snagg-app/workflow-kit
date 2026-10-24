import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { externalTool } from './checkout-root.mjs';

const interval = 60_000, minutes = 60;

export function usedDelta(previous, current) {
  if (!previous) return null;
  return current.resetAt === previous.resetAt ? Math.max(0, current.used - previous.used) : current.used;
}

async function sample(output) {
  const path = resolve(output);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '', { flag: 'wx' });
  const gh = externalTool('gh', process.cwd(), process.cwd()), started = Date.now();
  let previous, errors = 0;
  for (let index = 0; index <= minutes; index++) {
    await new Promise(resolveSleep => setTimeout(resolveSleep, Math.max(0, started + index * interval - Date.now())));
    const at = new Date().toISOString();
    try {
      const response = JSON.parse(execFileSync(gh.file, ['api', 'graphql', '-f', 'query=query{rateLimit{cost used remaining resetAt}}'],
        { encoding: 'utf8', env: gh.env, maxBuffer: 1 << 20 }));
      if (response.errors?.length || !response.data?.rateLimit) throw new Error('unreadable rateLimit response');
      const current = response.data.rateLimit;
      if (![current.cost, current.used, current.remaining].every(Number.isSafeInteger) || typeof current.resetAt !== 'string') {
        throw new Error('unreadable rateLimit fields');
      }
      appendFileSync(path, JSON.stringify({ sample: index, at, ...current, usedDelta: usedDelta(previous, current) }) + '\n');
      previous = current;
    } catch {
      errors++;
      appendFileSync(path, JSON.stringify({ sample: index, at, error: 'rateLimit query failed' }) + '\n');
    }
  }
  console.log(`quota sample complete: ${minutes} minutes, ${minutes + 1 - errors}/${minutes + 1} snapshots, ${path}`);
  if (errors) process.exitCode = 1;
}

const usage = 'Usage: node scripts/quota-sample.mjs OUTPUT.jsonl\n'
  + 'Samples the account GraphQL rate limit once a minute for one hour into OUTPUT.jsonl.\n'
  + 'Options: -h, --help (print this help and exit 0)';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [option] = process.argv.slice(2);
  if (option === '--help' || option === '-h') {
    console.log(usage);
  } else if (process.argv.length !== 3 || option.startsWith('-')) {
    console.error(`${usage}\nOUTPUT.jsonl must be a file name; an argument starting with "-" is refused.`);
    process.exitCode = 2;
  } else {
    await sample(option);
  }
}
