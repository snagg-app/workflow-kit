import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';

// One worker thread per test file runs board.mjs (see board-worker.mjs); the tests stay synchronous: the call blocks on a
// flag the worker sets when board.mjs has finished, then reads what it printed.
let current;
function start() {
  const requests = new MessageChannel(), results = new MessageChannel();
  const done = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(new URL('board-worker.mjs', import.meta.url), {
    workerData: { requests: requests.port2, results: results.port2, done }, transferList: [requests.port2, results.port2] });
  worker.unref();
  return { worker, requests: requests.port1, results: results.port1, done };
}

/**
 * Runs `board.mjs ARGS` in directory `cwd` with environment `env` and returns { status, stdout, stderr } like spawnSync.
 * After `timeout` ms the call is cut off: the result then has `timedOut` and what was printed until then.
 */
export function runBoard({ cwd, env, args, timeout }) {
  current ??= start();
  const { worker, requests, results, done } = current;
  Atomics.store(done, 0, 0);
  const before = process.cwd();
  // The working directory belongs to the whole process: board.mjs reads .github/workflow-project.json and the fake gh its files from it.
  process.chdir(cwd);
  try {
    requests.postMessage({ args, env, cwd: process.cwd() });
    const timedOut = Atomics.wait(done, 0, 0, timeout) === 'timed-out';
    const result = { status: null, stdout: '', stderr: '' };
    for (let message; (message = receiveMessageOnPort(results));) {
      if ('stream' in message.message) result[message.message.stream] += message.message.text;
      else result.status = message.message.status;
    }
    if (timedOut) {
      // A hung board.mjs (a `wait` that never ends) stops with its worker; the next call starts a fresh one.
      worker.terminate();
      current = undefined;
      return { ...result, timedOut: true };
    }
    return result;
  } finally {
    process.chdir(before);
  }
}
