import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { decodeAudio, encodeWav, resampleMono16 } from '../modules/module_02_speech_processing/src/providers/audioFormat.ts';
import { WhisperSpeechProvider, parseWhisperJson, readWhisperJson } from '../modules/module_02_speech_processing/src/providers/whisperProvider.ts';

// New canonical set for this experiment only. Keep expected wording in this harness.
const phrases = [
  'Please close the blue window.',
  'The morning train leaves at eight.',
  'Turn left at the next street.',
  'I packed three apples for lunch.',
  'Rain is falling beside the old bridge.',
  'Keep the silver key in the drawer.',
  'Our meeting starts after the short break.',
];
const dir = process.cwd();
const samplesDir = path.join(dir, 'samples');
const preparedDir = path.join(dir, 'prepared');
const outDir = path.join(dir, 'whisper-output');
const binary = '/home/resus/whisper.cpp/build/bin/whisper-cli';
const model = '/home/resus/whisper.cpp/models/ggml-base.en.bin';
const espeak = '/usr/bin/espeak-ng';
const norm = (s) => s.normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

if (process.argv[2] === 'prepare') {
  await fs.mkdir(samplesDir, { recursive: true });
  const rows = [];
  for (let i = 0; i < phrases.length; i++) {
    const file = path.join(samplesDir, `sample-${String(i + 1).padStart(2, '0')}.wav`);
    const result = spawnSync(espeak, ['-v', 'en-us', '-s', '165', '-w', file, phrases[i]], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`eSpeak generation failed at sample ${i + 1} (exit ${result.status}).`);
    const decoded = decodeAudio(new Uint8Array(await fs.readFile(file)));
    rows.push({ index: i + 1, sampleRateHz: decoded.sampleRate, channels: decoded.channels, bitsPerSample: decoded.bitsPerSample, durationMs: Math.round(decoded.pcm.length * 1000 / decoded.sampleRate), bytes: (await fs.stat(file)).size });
  }
  process.stdout.write(JSON.stringify({ status: 'PREPARED', count: rows.length, samples: rows }));
} else if (process.argv[2] === 'infer') {
  await fs.mkdir(preparedDir, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });
  const provider = new WhisperSpeechProvider({ binary, model, threads: 4, language: 'en', timeoutMs: 60000 });
  let directExact = 0, directNorm = 0, adapterExact = 0, adapterNorm = 0;
  let normalizedAgreement = 0, confidenceAgreement = 0, failures = 0;
  const times = [];
  for (let i = 0; i < phrases.length; i++) {
    try {
      const source = new Uint8Array(await fs.readFile(path.join(samplesDir, `sample-${String(i + 1).padStart(2, '0')}.wav`)));
      const decoded = decodeAudio(source);
      const prepared = encodeWav(resampleMono16(decoded.pcm, decoded.sampleRate, 16000), 16000);
      const preparedPath = path.join(preparedDir, `sample-${String(i + 1).padStart(2, '0')}.wav`);
      await fs.writeFile(preparedPath, prepared);
      const start = performance.now();
      const run = spawnSync(binary, ['-m', model, '-f', preparedPath, '-t', '4', '-l', 'en', '-ojf', '-nt'], { encoding: 'utf8', windowsHide: true });
      const directMs = performance.now() - start;
      if (run.status !== 0) throw new Error(`direct inference failure ${run.status}`);
      const raw = await readWhisperJson([`${preparedPath}.json`, preparedPath.replace(/\.wav$/, '.json')]);
      const direct = parseWhisperJson(raw);
      const adapterStart = performance.now();
      const adapted = await provider.transcribe({ callSessionId: `OFFLINE-NEW-${i + 1}`, emergencyId: `SYNTHETIC-${i + 1}`, language: 'en', audio: prepared, isFinal: true, diagnosticScope: 'synthetic-test' });
      const adapterMs = performance.now() - adapterStart;
      const expected = phrases[i];
      directExact += direct.text.trim() === expected.trim() ? 1 : 0;
      directNorm += norm(direct.text) === norm(expected) ? 1 : 0;
      adapterExact += adapted.text.trim() === expected.trim() ? 1 : 0;
      adapterNorm += norm(adapted.text) === norm(expected) ? 1 : 0;
      normalizedAgreement += norm(direct.text) === norm(adapted.text) ? 1 : 0;
      confidenceAgreement += direct.confidence === adapted.confidence ? 1 : 0;
      times.push({ directMs: Math.round(directMs), adapterMs: Math.round(adapterMs) });
    } catch {
      failures++;
    }
  }
  const avg = (key) => times.length ? Math.round(times.reduce((n, r) => n + r[key], 0) / times.length) : null;
  process.stdout.write(JSON.stringify({ status: 'COMPLETE', count: phrases.length, completed: times.length, failures, direct: { exact: directExact, normalized: directNorm, meanMs: avg('directMs') }, adapter: { exact: adapterExact, normalized: adapterNorm, meanMs: avg('adapterMs') }, agreement: { normalized: normalizedAgreement, confidence: confidenceAgreement } }));
} else {
  throw new Error('Use prepare or infer.');
}
