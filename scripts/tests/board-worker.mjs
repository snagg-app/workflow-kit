// Runs board.mjs for board-runner.mjs inside this worker thread instead of a new Node process per call, and hands its
// `gh` calls to the fake gh (fake-gh.mjs) instead of starting a process per call. A case of the board tests makes about
// eight such starts; at 70 to 150 ms each (Windows, virus scanner) they were most of the suite's run time.
import childProcess from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { format } from 'node:util';
import { workerData } from 'node:worker_threads';
import { useGhAdapter } from '../github.mjs';
import { fakeGh } from './fake-gh.mjs';

const { requests, results, done } = workerData;
const boardUrl = new URL('../board.mjs', import.meta.url).href;

// board.mjs imports execFileSync from node:child_process: only calls of `gh` are faked, other programs (the Sonar request) run for real.
// Their stderr would go to this process's file descriptor, past the captured result; it is routed into the result like board.mjs's own output.
const realSpawnSync = childProcess.spawnSync;
function realExecFileSync(file, args, options) {
  const child = realSpawnSync(file, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  if (child.stderr?.length) results.postMessage({ stream: 'stderr', text: String(child.stderr) });
  if (child.error) throw child.error;
  // The message names the command; `stderr` is empty when it was inherited, and the text of a piped one (board.mjs's git) when it was piped, as board.mjs reads it (#566).
  const piped = options?.stdio?.[2] === 'pipe';
  if (child.status !== 0) throw Object.assign(new Error(`Command failed: ${file} ${args.join(' ')}`), { status: child.status, signal: child.signal, stdout: child.stdout, stderr: piped ? String(child.stderr) : null });
  return options?.encoding ? String(child.stdout) : child.stdout;
}
// A `git` that board.mjs finds is an empty placeholder in the test's bin (the tests run with that bin as PATH); the call goes to the host's real git.
const hostPath = process.env.PATH;
// Like execFileSync: without `stdio`, the stderr of a failed gh is copied to the caller's stderr as well as thrown (#332).
function echoingFakeGh(args, options) {
  try { return fakeGh(args, options?.input); } catch (error) {
    if (error.stderr && !options?.stdio) results.postMessage({ stream: 'stderr', text: error.stderr });
    throw error;
  }
}
// affected-tests.mjs has its own tests: the start of the targeted tests of `done` is only written down in affected-tests-calls, without the script path.
// A file affected-tests-seconds makes them take that long (the clock of `done` starts before them).
const noteAffectedTests = args => {
  appendFileSync('affected-tests-calls', `${args.slice(1).join(' ')}\n`);
  if (existsSync('affected-tests-seconds')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(readFileSync('affected-tests-seconds', 'utf8')) * 1000);
};
// Every `gh` call of board.mjs goes through github.mjs, which takes the fake as its test variant.
useGhAdapter(echoingFakeGh);
childProcess.execFileSync = (file, args, options) => file === process.execPath && /affected-tests\.mjs$/.test(args[0]) ? noteAffectedTests(args)
  : /(^|[\\/])git(\.exe)?$/.test(file) ? realExecFileSync('git', args, { ...options, env: { ...options?.env, PATH: hostPath } })
    : realExecFileSync(file, args, options);
syncBuiltinESMExports();

class ProcessExit extends Error {}

let count = 0;
requests.onmessage = async ({ data: { args, env } }) => {
  let status = 0;
  const say = stream => (...parts) => results.postMessage({ stream, text: `${format(...parts)}\n` });
  const [log, error, warn, exit] = [console.log, console.error, console.warn, process.exit];
  [console.log, console.error, console.warn] = [say('stdout'), say('stderr'), say('stderr')];
  process.exit = code => { throw Object.assign(new ProcessExit(), { code: code ?? process.exitCode ?? 0 }); };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  process.argv = [process.execPath, 'board.mjs', ...args];
  process.exitCode = undefined;
  try {
    await import(`${boardUrl}?call=${++count}`);
    status = process.exitCode ?? 0;
  } catch (thrown) {
    // Like Node: process.exit() ends with its code, any other uncaught error prints its stack and ends with 1.
    if (thrown instanceof ProcessExit) status = thrown.code;
    else { results.postMessage({ stream: 'stderr', text: `${thrown?.stack ?? thrown}\n` }); status = 1; }
  } finally {
    [console.log, console.error, console.warn, process.exit] = [log, error, warn, exit];
  }
  results.postMessage({ status });
  Atomics.store(done, 0, 1);
  Atomics.notify(done, 0);
};
