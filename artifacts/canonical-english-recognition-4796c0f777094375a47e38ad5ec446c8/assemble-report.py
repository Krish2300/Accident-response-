import json, os, sys
D=sys.argv[1]
with open(os.path.join(D,'manifest.json'),encoding='utf-8-sig') as f: manifest=json.load(f)
with open(os.path.join(D,'audio-metadata.json'),encoding='utf-8-sig') as f: audio=json.load(f)
with open(os.path.join(D,'comparison-results.json'),encoding='utf-8-sig') as f: results=json.load(f)
for item in audio:
    item['windowsPath']=r'F:\minor\artifacts' + '\\' + os.path.basename(D) + '\\' + item['file']
manifest['wavIntegrity']=audio
manifest['recognitionSummary']=results['summary']
manifest['normalization']=results['normalization']
manifest['technicalFailures']={'direct':results['summary']['directFailures'],'provider':results['summary']['providerFailures']}
manifest['newCanonicalSetResult']='FAIL: fewer than 7/7 normalized expected-text matches; human review pending.'
with open(os.path.join(D,'manifest.json'),'w',encoding='utf-8') as f: json.dump(manifest,f,indent=2,ensure_ascii=False); f.write('\n')

def esc(x): return str(x if x is not None else 'ERROR').replace('|',r'\|').replace('\n',' ')
lines=[
 '# Canonical English Whisper recognition experiment', '',
 f"- Experiment ID: `{results['experimentId']}`",
 '- Set: **newly authorized canonical set**; not a reproduction of the missing original seven-phrase set.',
 '- TTS: eSpeak NG 1.52.0, voice `en-gb`, 145 WPM, pitch 50, amplitude 110.',
 '- Human review: **NOT REVIEWED**; checklist fields are blank.',
 f"- Normalization: {results['normalization']}",
 '- Original seven-phrase gate: **UNRESOLVED**; this new set does not replace it.',
 '- New set offline criterion: **FAIL**; measured normalized match rate is below 7/7.', '',
 '## WAV integrity and metadata', '',
 '| # | WAV | Bytes | Encoding | Rate | Channels | Bits | Duration (s) | RMS | Peak | Decoded | Non-silent |',
 '|---:|---|---:|---|---:|---:|---:|---:|---:|---:|:---:|:---:|'
]
for a in audio:
    lines.append(f"| {a['number']} | {a['file']} | {a['bytes']} | {a['encoding']} | {a['sampleRateHz']} Hz | {a['channels']} | {a['bitsPerSample']} | {a['durationSeconds']:.3f} | {a['rms']} | {a['peak']} | PASS | PASS |")
lines += ['', '## Recognition results', '',
 '| # | Expected phrase | Direct transcript | Direct exact | Direct normalized | Provider transcript | Provider exact | Provider normalized | Exact output agreement | Normalized output agreement | Errors |',
 '|---:|---|---|:---:|:---:|---|:---:|:---:|:---:|:---:|---|']
for s in results['samples']:
    errs='; '.join(filter(None,[s['direct'].get('error'),s['provider'].get('error')])) or 'None'
    lines.append(f"| {s['number']} | {esc(s['expected'])} | {esc(s['direct'].get('transcript'))} | {s['direct'].get('exact')} | {s['direct'].get('normalized')} | {esc(s['provider'].get('transcript'))} | {s['provider'].get('exact')} | {s['provider'].get('normalized')} | {s['agreement'].get('exact')} | {s['agreement'].get('normalized')} | {esc(errs)} |")
s=results['summary']
lines += ['', '## Totals', '',
 f"- Direct whisper.cpp: exact {s['directExact']}/7; normalized {s['directNormalized']}/7; technical failures {s['directFailures']}/7.",
 f"- `WhisperSpeechProvider`: exact {s['providerExact']}/7; normalized {s['providerNormalized']}/7; technical failures {s['providerFailures']}/7.",
 f"- Direct/provider outputs agree: exact {s['exactAgreement']}/7; normalized {s['normalizedAgreement']}/7.",
 '- Both paths used the same project audio decode/resample/encode helpers and equivalent English/model/thread/JSON settings. No preprocessing, decode, or inference failure was observed.',
 '- Transcript differences from expected text were identical in both paths. This shows no provider/direct discrepancy in this run; it does not establish why the model produced those transcripts.',
 '- Human-confirmed intelligibility and intended-phrase match remain pending. WAV validity and automated recognition are not human review.',
 '- Keep the original gate unresolved: the original phrase strings are unavailable, and this is a distinct newly authorized set.'
]
with open(os.path.join(D,'run-report.md'),'w',encoding='utf-8') as f: f.write('\n'.join(lines)+'\n')
print('MANIFEST_AND_RUN_REPORT_UPDATED')
