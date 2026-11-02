import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
const execFileAsync = promisify(execFile);
const root = process.cwd();
const runDir = path.join(root, 'artifacts/offline-whisper-control-20261025-49381978e33047a587f90a6ac4e6c21e');
const binary = '/home/resus/whisper.cpp/build/bin/whisper-cli';
const model = '/home/resus/whisper.cpp/models/ggml-base.en.bin';
const phrases = [
  'This is a synthetic audio recognition test.',
  'A blue kite is flying above the quiet park.',
  'The library opens at nine on Tuesday morning.',
];
const names = ['sample-01.wav', 'sample-02.wav', 'sample-03.wav'];
const providerPath = pathToFileURL(path.join(root, 'modules/module_02_speech_processing/src/providers/whisperProvider.ts')).href;
const audioPath = pathToFileURL(path.join(root, 'modules/module_02_speech_processing/src/providers/audioFormat.ts')).href;
const [{ WhisperSpeechProvider, parseWhisperJson }, { decodeAudio, resampleMono16, encodeWav }] = await Promise.all([import(providerPath), import(audioPath)]);
const provider = new WhisperSpeechProvider({ binary, model, threads: 4, language: 'en', timeoutMs: 30000 });
const normalize = (s) => s.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim();
const matches = (actual, expected) => ({ exact: actual.trim() === expected.trim(), normalized: normalize(actual) === normalize(expected) });
const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'resus-whisper-control-'));
const results = [];
try {
  for (let i = 0; i < names.length; i++) {
    const inputPath = path.join(runDir, names[i]);
    const source = new Uint8Array(await fs.readFile(inputPath));
    const decoded = decodeAudio(source);
    const prepared = encodeWav(resampleMono16(decoded.pcm, decoded.sampleRate, 16000), 16000);
    const preparedPath = path.join(runRoot, `sample-${i + 1}-16k.wav`);
    await fs.writeFile(preparedPath, prepared);
    const args = ['-m', model, '-f', preparedPath, '-t', '4', '-l', 'en', '-ojf', '-nt'];
    const directStarted = Date.now();
    await execFileAsync(binary, args, { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    const directMs = Date.now() - directStarted;
    const directJsonCandidates = [`${preparedPath}.json`, preparedPath.replace(/\.wav$/, '.json')];
    let directJson;
    for (const candidate of directJsonCandidates) {
      try {
        directJson = await fs.readFile(candidate, 'utf8');
        break;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    if (!directJson) throw new Error(`Direct CLI produced no JSON for sample ${i + 1}`);
    const direct = parseWhisperJson(directJson);
    const providerStarted = Date.now();
    const adapted = await provider.transcribe({
      callSessionId: `SYNTHETIC-CONTROL-${i + 1}`,
      emergencyId: `SYNTHETIC-EMERGENCY-${i + 1}`,
      language: 'en', audio: source, isFinal: true, diagnosticScope: 'synthetic-test',
    });
    const providerMs = Date.now() - providerStarted;
    const directMatches = matches(direct.text, phrases[i]);
    const providerMatches = matches(adapted.text, phrases[i]);
    results.push({
      sample: i + 1, inputSha256: crypto.createHash('sha256').update(source).digest('hex'),
      sourceRateHz: decoded.sampleRate, sourceChannels: decoded.channels,
      providerResampleTargetHz: 16000, directPreparedRateHz: 16000,
      preparedBytes: prepared.byteLength, directInferenceMs: directMs, providerInferenceMs: providerMs,
      direct: directMatches, provider: providerMatches,
      outputsEqualExact: direct.text.trim() === adapted.text.trim(),
      outputsEqualNormalized: normalize(direct.text) === normalize(adapted.text),
      confidenceDirect: direct.confidence, confidenceProvider: adapted.confidence,
      inferenceFailure: null,
    });
    for (const candidate of directJsonCandidates) await fs.rm(candidate, { force: true });
  }
} catch (error) {
  results.push({ inferenceFailure: String(error?.message ?? error) });
} finally {
  await fs.rm(runRoot, { recursive: true, force: true });
}
const report = {
  scope: 'synthetic-only; no call; human intelligibility unverified',
  settings: { voice: 'en-gb', speedWpm: 145, pitch: 50, amplitude: 110, model: 'ggml-base.en.bin', language: 'en', threads: 4, translation: false, jsonMode: '-ojf', noTimestamps: true },
  results,
  summary: {
    inferenceFailures: results.filter((r) => r.inferenceFailure).length,
    directExact: results.filter((r) => r.direct?.exact).length,
    directNormalized: results.filter((r) => r.direct?.normalized).length,
    providerExact: results.filter((r) => r.provider?.exact).length,
    providerNormalized: results.filter((r) => r.provider?.normalized).length,
    normalizedOutputAgreement: results.filter((r) => r.outputsEqualNormalized).length,
  },
};
await fs.writeFile(path.join(runDir, 'metrics.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
