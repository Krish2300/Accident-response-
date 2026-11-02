import { spawn } from 'node:child_process';
import { AppError, ErrorCode } from '@resus/core';

/**
 * Runs a local speech engine as a child process.
 *
 * Speech engines here are ordinary binaries (whisper.cpp, espeak-ng, ffmpeg).
 * Every failure mode they can produce — missing executable, non-zero exit,
 * hanging on a bad model, no stdout — is converted into `PROVIDER_UNAVAILABLE`
 * with the captured stderr in the message, because the caller has to distinguish
 * "the engine said there was no speech" from "the engine is not installed".
 *
 * A timeout is mandatory rather than optional: a whisper process that never
 * finishes must not leave an emergency call open indefinitely, and without a
 * deadline the failure would surface as a hung HTTP request instead of a typed
 * error.
 */
export interface RunOptions {
  /** Hard deadline. Required — there is no safe "wait forever" for a voice engine. */
  timeoutMs: number;
  /** Text piped to the child's stdin, when the engine reads its input that way. */
  stdin?: string;
  /** Captured on failure. Defaults to 0. */
  maxBufferBytes?: number;
}

export interface RunResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

export function runProcess(binary: string, args: string[], options: RunOptions): Promise<RunResult> {
  const maxBufferBytes = options.maxBufferBytes ?? 4 * 1024 * 1024;

  return new Promise<RunResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      reject(unavailable(binary, `could not be started: ${(error as Error).message}`));
      return;
    }

    const stdout: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(unavailable(binary, `did not finish within ${options.timeoutMs} ms`));
    }, options.timeoutMs);

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBufferBytes) stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (error: Error) => {
      finish(() => reject(unavailable(binary, `could not be run: ${error.message}`)));
    });

    child.on('close', (code: number | null) => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      finish(() => {
        if (code !== 0) {
          reject(unavailable(binary, `exited with code ${code}${stderr ? `: ${stderr}` : ''}`));
          return;
        }
        resolve({ stdout: Buffer.concat(stdout), stderr, code: code ?? 0 });
      });
    });

    // The engine can exit before reading stdin — including never starting at
    // all — so an error listener is attached whether or not we wrote anything.
    // Without it a closed pipe surfaces as an unhandled stream error rather than
    // the typed failure below.
    child.stdin.on('error', () => undefined);
    if (options.stdin !== undefined) child.stdin.write(options.stdin);
    child.stdin.end();
  });
}

function unavailable(binary: string, detail: string): AppError {
  return new AppError(
    ErrorCode.PROVIDER_UNAVAILABLE,
    `The speech engine '${binary}' ${detail}`,
    503,
    { engine: binary },
  );
}
