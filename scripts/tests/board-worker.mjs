// Runs board-run.mjs (the function behind board.mjs) for board-runner.mjs inside this worker thread instead of a new Node process per call, and hands its
// `gh` calls to the fake gh (fake-gh.mjs) instead of starting a process per call. A case of the board tests makes about
// eight such starts; at 70 to 150 ms each (Windows, virus scanner) they were most of the suite's run time.
import childProcess from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { workerData } from 'node:worker_threads';
import { runBoard } from '../board-run.mjs';
import { useProcessAdapter } from '../run-program.mjs';
import { useGhAdapter } from '../github.mjs';
import { useSonarAdapter } from '../sonar.mjs';
import { fakeGh } from './fake-gh.mjs';
import { fakeSonar } from './fake-sonar.mjs';

const { requests, results, done } = workerData;

// The process variant for board-process.mjs: the targeted tests are only noted, other programs run for real.
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
  // A file affected-tests-base-red (one test name per line) is what a project command that found tests red on the base leaves in the steps file (#1052).
  if (existsSync('affected-tests-base-red')) appendFileSync(args[args.indexOf('--resume') + 1], readFileSync('affected-tests-base-red', 'utf8').split('\n').filter(Boolean).map(name => `base-red: ${name}\n`).join(''));
  if (existsSync('affected-tests-seconds')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(readFileSync('affected-tests-seconds', 'utf8')) * 1000);
};
// Every `gh` call of board.mjs goes through github.mjs, which takes the fake as its test variant.
useGhAdapter(echoingFakeGh);
useSonarAdapter(fakeSonar);
useProcessAdapter((file, args, options) => file === process.execPath && /affected-tests\.mjs$/.test(args[0]) ? noteAffectedTests(args)
  : /(^|[\\/])git(\.exe)?$/.test(file) ? realExecFileSync('git', args, { ...options, env: { ...options?.env, PATH: hostPath } })
    : realExecFileSync(file, args, options));

const say = stream => text => results.postMessage({ stream, text: `${text}\n` });
const io = { log: say('stdout'), error: say('stderr') };

requests.onmessage = async ({ data: { args, env, cwd } }) => {
  let status;
  try {
    status = (await runBoard({ argv: args, env, cwd, io })).exitCode;
  } catch (thrown) {
    // Like Node: an uncaught error prints its stack and ends with 1.
    results.postMessage({ stream: 'stderr', text: `${thrown?.stack ?? thrown}\n` });
    status = 1;
  }
  results.postMessage({ status });
  Atomics.store(done, 0, 1);
  Atomics.notify(done, 0);
};
