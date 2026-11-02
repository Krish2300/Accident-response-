import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { noopLogger } from '@resus/core';
import { Module3Classifier } from '../apps/server/src/nlp/module3Classifier.js';

/**
 * Live test against the actual Module 3 Python service.
 *
 * This is the only test in the repository that invokes the real Python
 * implementation rather than a mock, so it is opt-in and never part of the
 * default suite:
 *
 *   MODULE3_LIVE_TEST=1 npm test -- tests/module3Classifier.live.test.ts
 *
 * It starts `uvicorn` from `modules/module3_emergency_nlp` with no
 * `ANTHROPIC_API_KEY`, so the service takes its documented safe-fallback path.
 * That is what makes the test deterministic and truthful: it proves the adapter
 * speaks to the real service and reports the fallback as degraded, and it makes
 * no claim about a model classification, which would require a paid credential.
 *
 * Set `MODULE3_PYTHON` if the interpreter is not `python`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const serviceDir = resolve(repoRoot, 'modules/module3_emergency_nlp');
const port = Number(process.env.MODULE3_LIVE_TEST_PORT ?? 8044);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('MODULE3_LIVE_TEST_PORT must be an integer from 1 to 65535.');
}
const baseUrl = `http://127.0.0.1:${port}`;

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

describe.runIf(process.env.MODULE3_LIVE_TEST === '1')('Module3Classifier (live Python service)', () => {
  let child: ChildProcess | undefined;
  let started = false;

  beforeAll(async () => {
    const python = process.env.MODULE3_PYTHON ?? 'python';
    const versionProbe = spawnSync(python, ['--version'], { encoding: 'utf8', windowsHide: true });
    const versionOutput = `${versionProbe.stdout ?? ''} ${versionProbe.stderr ?? ''}`;
    const versionMatch = /Python\s+(\d+)\.(\d+)(?:\.\d+)?/.exec(versionOutput);
    if (versionProbe.error || versionProbe.status !== 0 || !versionMatch) {
      throw new Error(
        `Could not determine the selected Module 3 Python version (${python}). Set MODULE3_PYTHON to a Python 3.11+ executable.`,
      );
    }
    const major = Number(versionMatch[1]);
    const minor = Number(versionMatch[2]);
    if (major < 3 || (major === 3 && minor < 11)) {
      throw new Error(
        `Module 3 requires Python 3.11 or newer; ${python} reports ${versionMatch[0]}. Set MODULE3_PYTHON to a supported interpreter.`,
      );
    }

    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    child = spawn(
      python,
      ['-m', 'uvicorn', 'emergency_nlp.api.main:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning'],
      { cwd: serviceDir, env, stdio: 'ignore' },
    );

    started = await waitForHealth(30_000);
  }, 40_000);

  afterAll(() => {
    child?.kill();
  });

  it('invokes the real service and reports its fallback honestly', async () => {
    expect(started).toBe(true);

    const classifier = new Module3Classifier({
      baseUrl,
      timeoutMs: 15_000,
      logger: noopLogger,
    });

    const result = await classifier.classify({
      emergencyId: 'EMG-LIVE-1',
      sessionId: 'CALL-LIVE-1',
      transcriptText: 'My father collapsed and is not breathing.',
      language: 'en',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.degraded).toBe(true);
    expect(result.extraction.category).toBe('UNKNOWN');
    expect(result.extraction.confidence).toBe(0);
  }, 30_000);
});
