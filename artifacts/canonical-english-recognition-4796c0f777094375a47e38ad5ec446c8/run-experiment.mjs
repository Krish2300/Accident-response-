import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
const execFileAsync = promisify(execFile);
const runDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(runDir, '../..');
const binary = '/home/resus/whisper.cpp/build/bin/whisper-cli';
const model = '/home/resus/whisper.cpp/models/ggml-base.en.bin';
const phrases = [
  'Hello, can you hear me?',
  'I need help, please.',
  'I am calling from the main road.',
  'The nearest landmark is the bus station.',
  'The house number is twenty-four.',
  'Please send the information to the operator.',
  'I will stay here and answer your questions.',
];
const [{ WhisperSpeechProvider, parseWhisperJson }, { decodeAudio, resampleMono16, encodeWav }] = await Promise.all([
  import(pathToFileURL(path.join(repo, 'modules/module_02_speech_processing/src/providers/whisperProvider.ts')).href),
  import(pathToFileURL(path.join(repo, 'modules/module_02_speech_processing/src/providers/audioFormat.ts')).href),
]);
const provider = new WhisperSpeechProvider({ binary, model, threads: 4, language: 'en', timeoutMs: 60000 });
const normalize = (text) => text.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim();
const equal = (actual, expected) => ({ exact: actual.trim() === expected.trim(), normalized: normalize(actual) === normalize(expected) });
const samples = [];
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'resus-canonical-whisper-'));
try {
  for (let i = 0; i < phrases.length; i++) {
    const file = `sample-${String(i + 1).padStart(2, '0')}.wav`;
    const wavPath = path.join(runDir, file);
    const bytes = new Uint8Array(await fs.readFile(wavPath));
    const decoded = decodeAudio(bytes);
    const pcm16k = resampleMono16(decoded.pcm, decoded.sampleRate, 16000);
    const prepared = encodeWav(pcm16k, 16000);
    const preparedPath = path.join(tempRoot, `sample-${i + 1}-16k.wav`);
    await fs.writeFile(preparedPath, prepared);
    const sample = {
      number: i + 1, file, expected: phrases[i],
      inputSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      source: { sampleRateHz: decoded.sampleRate, channels: decoded.channels, bitsPerSample: decoded.bitsPerSample,
        durationSeconds: decoded.pcm.length / decoded.sampleRate, bytes: bytes.length },
      providerPrepared: { sampleRateHz: 16000, channels: 1, bitsPerSample: 16,
        bytes: prepared.byteLength, sha256: crypto.createHash('sha256').update(prepared).digest('hex') },
      direct: null, provider: null, agreement: null,
    };
    try {
      const started = Date.now();
      await execFileAsync(binary, ['-m', model, '-f', preparedPath, '-t', '4', '-l', 'en', '-ojf', '-nt'],
        { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
      const candidates = [`${preparedPath}.json`, preparedPath.replace(/\.wav$/, '.json')];
      let json;
      for (const candidate of candidates) {
        try {
          json = await fs.readFile(candidate, 'utf8');
          break;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
      if (json === undefined) throw new Error('whisper.cpp returned success but no JSON result file was found');
      const parsed = parseWhisperJson(json);
      sample.direct = { transcript: parsed.text, ...equal(parsed.text, phrases[i]), confidence: parsed.confidence, inferenceMs: Date.now() - started, error: null };
      for (const candidate of candidates) await fs.rm(candidate, { force: true });
    } catch (error) {
      sample.direct = { transcript: null, exact: null, normalized: null, confidence: null, error: String(error?.message ?? error) };
    }
    try {
      const started = Date.now();
      const result = await provider.transcribe({ callSessionId: `CANONICAL-SYNTH-${i + 1}`, emergencyId: `CANONICAL-TEST-${i + 1}`,
        language: 'en', audio: bytes, isFinal: true, diagnosticScope: 'synthetic-test' });
      sample.provider = { transcript: result.text, ...equal(result.text, phrases[i]), confidence: result.confidence,
        inferenceMs: Date.now() - started, error: null };
    } catch (error) {
      sample.provider = { transcript: null, exact: null, normalized: null, confidence: null, error: String(error?.message ?? error) };
    }
    sample.agreement = {
      exact: sample.direct.transcript !== null && sample.provider.transcript !== null
        ? sample.direct.transcript.trim() === sample.provider.transcript.trim() : null,
      normalized: sample.direct.transcript !== null && sample.provider.transcript !== null
        ? normalize(sample.direct.transcript) === normalize(sample.provider.transcript) : null,
    };
    samples.push(sample);
    console.log(`Completed recognition comparison ${i + 1}/7`);
  }
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
const count = (path, key) => samples.filter((s) => s[path]?.[key] === true).length;
const summary = {
  samples: samples.length,
  directFailures: samples.filter((s) => s.direct?.error).length,
  providerFailures: samples.filter((s) => s.provider?.error).length,
  directExact: count('direct', 'exact'), directNormalized: count('direct', 'normalized'),
  providerExact: count('provider', 'exact'), providerNormalized: count('provider', 'normalized'),
  exactAgreement: samples.filter((s) => s.agreement?.exact === true).length,
  normalizedAgreement: samples.filter((s) => s.agreement?.normalized === true).length,
};
const result = {
  experimentId: path.basename(runDir).replace('canonical-english-recognition-', ''),
  type: 'NEWLY AUTHORIZED CANONICAL SET; not a reproduction of the missing original set',
  normalization: 'NFKC, lowercase, Unicode punctuation/symbols replaced by spaces, whitespace collapsed, trim; exact comparison trims outer whitespace only.',
  inference: { runtime: binary, model, language: 'en', threads: 4, translation: false, jsonFlag: '-ojf', noTimestamps: true,
    directPreparedWith: 'same repository decodeAudio/resampleMono16/encodeWav helpers used internally by WhisperSpeechProvider',
    provider: 'actual repository WhisperSpeechProvider; input is original eSpeak WAV; provider resamples to 16 kHz mono WAV' },
  samples, summary,
  humanReview: 'NOT REVIEWED; checklist fields remain blank',
  originalSevenPhraseAcceptanceGate: 'UNRESOLVED; this new canonical experiment is separate and cannot retroactively reproduce or satisfy the missing original set.',
};
await fs.writeFile(path.join(runDir, 'comparison-results.json'), JSON.stringify(result, null, 2) + '\n');
const cell = (v) => String(v ?? 'ERROR').replaceAll('|', '\\|').replaceAll('\n', ' ');
const rows = samples.map((s) => `| ${s.number} | ${cell(s.expected)} | ${cell(s.direct?.transcript)} | ${cell(s.direct?.exact)} | ${cell(s.direct?.normalized)} | ${cell(s.provider?.transcript)} | ${cell(s.provider?.exact)} | ${cell(s.provider?.normalized)} | ${cell(s.agreement?.exact)} | ${cell(s.direct?.error ?? s.provider?.error ?? 'None')} |`).join('\n');
const report = `# Canonical English Whisper recognition experiment\n\n- Experiment ID: \`${result.experimentId}\`\n- Type: **newly authorized canonical set**; not a reproduction of the missing original set.\n- Voice/settings: eSpeak NG en-gb, 145 WPM, pitch 50, amplitude 110.\n- WAVs: all seven kept in this directory for human review.\n- Human review: **NOT REVIEWED**.\n- Normalization: ${result.normalization}\n- Original seven-phrase acceptance gate: **UNRESOLVED**.\n\n| # | Expected | Direct transcript | Direct exact | Direct normalized | Provider transcript | Provider exact | Provider normalized | Outputs exact-equal | Technical error |\n|---:|---|---|:---:|:---:|---|:---:|:---:|:---:|---|\n${rows}\n\n## Totals\n\n- Direct: exact ${summary.directExact}/7; normalized ${summary.directNormalized}/7; failures ${summary.directFailures}/7.\n- Provider: exact ${summary.providerExact}/7; normalized ${summary.providerNormalized}/7; failures ${summary.providerFailures}/7.\n- Direct/provider exact output agreement: ${summary.exactAgreement}/7; normalized agreement: ${summary.normalizedAgreement}/7.\n- Human intelligibility and intended-text match: pending human review in \`human-review-checklist.md\`.\n- These synthetic results do not establish real-caller audio quality or a general model defect.\n`;
await fs.writeFile(path.join(runDir, 'run-report.md'), report);
console.log(JSON.stringify(summary, null, 2));
