import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function runJob<T>(job: Record<string, unknown>, signal?: AbortSignal, timeout = 120_000): Promise<T> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url))], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    });
    let settled = false, stderr = '';
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      child.kill();
      error ? reject(error) : resolve(value as T);
    };
    const abort = () => finish(new Error('Document operation aborted'));
    const timer = setTimeout(() => finish(new Error(`Document operation timed out after ${timeout} ms`)), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-3000); });
    child.on('error', error => finish(error));
    child.on('exit', code => { if (!settled) finish(new Error(`Document worker exited (${code}): ${stderr}`)); });
    child.on('message', (message: any) => message.ok ? finish(undefined, message.result) : finish(new Error(message.error)));
    child.send!(job);
    if (signal?.aborted) abort();
  });
}
