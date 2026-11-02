import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const root = '/mnt/f/minor/artifacts/canonical-english-recognition-4796c0f777094375a47e38ad5ec446c8';
const out = process.argv[2];
const cli = '/home/resus/whisper.cpp/build/bin/whisper-cli';
const model = '/home/resus/whisper.cpp/models/ggml-base.en.bin';
const { decodeAudio, resampleMono16, encodeWav } = await import(pathToFileURL('/mnt/f/minor/modules/module_02_speech_processing/src/providers/audioFormat.ts').href);
const expected = [
'Hello, can you hear me?', 'I need help, please.', 'I am calling from the main road.',
'The nearest landmark is the bus station.', 'The house number is twenty-four.',
'Please send the information to the operator.', 'I will stay here and answer your questions.'
];
const normalize = s => s.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim();
const configurations = [
  { name: 'default-beam5', flags: [] },
  { name: 'greedy-bestof1', flags: ['-bs', '1', '-bo', '1'] },
];
const rows = [];
for (let i=0;i<7;i++) {
  const n=String(i+1).padStart(2,'0');
  const src=await fs.readFile(path.join(root,`sample-${n}.wav`));
  const decoded=decodeAudio(src);
  const pcm=resampleMono16(decoded.pcm, decoded.sampleRate, 16000);
  const wav=encodeWav(pcm,16000);
  const prepared=path.join(out,`sample-${n}-16k.wav`);
  await fs.writeFile(prepared,wav);
  const sample={number:i+1,source:`sample-${n}.wav`,expected:expected[i],sourceSha256:crypto.createHash('sha256').update(src).digest('hex'),preparedFile:path.basename(prepared),preparedSha256:crypto.createHash('sha256').update(wav).digest('hex'),preparedSampleRateHz:16000,preparedChannels:1,durationSeconds:pcm.length/16000,results:{}};
  for (const cfg of configurations) {
    const base=path.join(out,`${cfg.name}-sample-${n}`);
    const args=['-m',model,'-f',prepared,'-t','4','-l','en','-ojf','-nt','-of',base,...cfg.flags];
    const p=spawnSync(cli,args,{encoding:'utf8'});
    const log={status:p.status,signal:p.signal,stderr:(p.stderr||'').slice(-4000),stdout:(p.stdout||'').slice(-1000),args};
    let transcript=''; let technicalError=null;
    try { if(p.status!==0) throw new Error(`whisper-cli exit ${p.status}`); const j=JSON.parse(await fs.readFile(`${base}.json`,'utf8')); transcript=String(j.transcription?.[0]?.text??'').trim(); if(!transcript) throw new Error('empty transcript'); }
    catch(e){ technicalError=String(e); }
    sample.results[cfg.name]={transcript,exact: transcript.trim()===expected[i].trim(),normalized:normalize(transcript)===normalize(expected[i]),technicalError,process:log};
  }
  rows.push(sample);
}
const report={experiment:'Offline whisper.cpp decoding-options comparison',createdUtc:new Date().toISOString(),sourceExperiment:'4796c0f777094375a47e38ad5ec446c8',runtime:cli,model,modelSha256:crypto.createHash('sha256').update(await fs.readFile(model)).digest('hex'),preprocessing:'Same repository decodeAudio/resampleMono16/encodeWav helpers used by WhisperSpeechProvider; mono 16-bit WAV 16 kHz.',normalization:'NFKC, lowercase, Unicode punctuation/symbols replaced by spaces, whitespace collapsed, trim; exact comparison trims outer whitespace only.',configurations:[{name:'default-beam5',settings:'CLI defaults: -bs 5 beam search, -bo 5, -t 4, -l en, -ojf, -nt'},{name:'greedy-bestof1',settings:'-bs 1 -bo 1, otherwise same -t 4, -l en, -ojf, -nt'}],samples:rows,summary:Object.fromEntries(configurations.map(c=>[c.name,{exact:rows.filter(s=>s.results[c.name].exact).length,normalized:rows.filter(s=>s.results[c.name].normalized).length,failures:rows.filter(s=>s.results[c.name].technicalError).length}])),interpretation:'Diagnostic only; no production setting change.'};
await fs.writeFile(path.join(out,'experiment-results.json'),JSON.stringify(report,null,2)+'\n');
await fs.writeFile(path.join(out,'run-report.md'),`# Offline decoding option comparison\n\n- Created: ${report.createdUtc}\n- Input set: existing canonical 7 WAVs; original files unchanged.\n- Preprocessing: provider helper functions; 16 kHz mono PCM WAV.\n- Model SHA-256: ${report.modelSha256}\n- Configurations: default beam search (bs=5, bo=5) vs greedy (bs=1, bo=1).\n- Results: ${JSON.stringify(report.summary)}\n\nSee experiment-results.json for per-sample transcripts, matching, hashes, commands, and technical logs.\n`);
