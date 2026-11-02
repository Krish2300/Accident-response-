# Canonical English Whisper recognition experiment

- Experiment ID: `4796c0f777094375a47e38ad5ec446c8`
- Set: **newly authorized canonical set**; not a reproduction of the missing original seven-phrase set.
- TTS: eSpeak NG 1.52.0, voice `en-gb`, 145 WPM, pitch 50, amplitude 110.
- Human review: **NOT REVIEWED**; checklist fields are blank.
- Normalization: NFKC, lowercase, Unicode punctuation/symbols replaced by spaces, whitespace collapsed, trim; exact comparison trims outer whitespace only.
- Original seven-phrase gate: **UNRESOLVED**; this new set does not replace it.
- New set offline criterion: **FAIL**; measured normalized match rate is below 7/7.

## WAV integrity and metadata

| # | WAV | Bytes | Encoding | Rate | Channels | Bits | Duration (s) | RMS | Peak | Decoded | Non-silent |
|---:|---|---:|---|---:|---:|---:|---:|---:|---:|:---:|:---:|
| 1 | sample-01.wav | 92054 | PCM S16LE | 22050 Hz | 1 | 16 | 2.086 | 2906.1 | 27954 | PASS | PASS |
| 2 | sample-02.wav | 91860 | PCM S16LE | 22050 Hz | 1 | 16 | 2.082 | 2521.82 | 21907 | PASS | PASS |
| 3 | sample-03.wav | 98724 | PCM S16LE | 22050 Hz | 1 | 16 | 2.238 | 3346.08 | 27676 | PASS | PASS |
| 4 | sample-04.wav | 125162 | PCM S16LE | 22050 Hz | 1 | 16 | 2.837 | 3170.49 | 28756 | PASS | PASS |
| 5 | sample-05.wav | 105162 | PCM S16LE | 22050 Hz | 1 | 16 | 2.384 | 3543.11 | 27202 | PASS | PASS |
| 6 | sample-06.wav | 135918 | PCM S16LE | 22050 Hz | 1 | 16 | 3.081 | 3207.53 | 27500 | PASS | PASS |
| 7 | sample-07.wav | 137946 | PCM S16LE | 22050 Hz | 1 | 16 | 3.127 | 3216.14 | 26262 | PASS | PASS |

## Recognition results

| # | Expected phrase | Direct transcript | Direct exact | Direct normalized | Provider transcript | Provider exact | Provider normalized | Exact output agreement | Normalized output agreement | Errors |
|---:|---|---|:---:|:---:|---|:---:|:---:|:---:|:---:|---|
| 1 | Hello, can you hear me? | Hello, can you hear me? | True | True | Hello, can you hear me? | True | True | True | True | None |
| 2 | I need help, please. | I need help, please. | True | True | I need help, please. | True | True | True | True | None |
| 3 | I am calling from the main road. | I am calling from her main road. | False | False | I am calling from her main road. | False | False | True | True | None |
| 4 | The nearest landmark is the bus station. | The nearest landmark is the Mustation. | False | False | The nearest landmark is the Mustation. | False | False | True | True | None |
| 5 | The house number is twenty-four. | The house number is 24. | False | False | The house number is 24. | False | False | True | True | None |
| 6 | Please send the information to the operator. | Please send the information to the operator. | True | True | Please send the information to the operator. | True | True | True | True | None |
| 7 | I will stay here and answer your questions. | I will stay here and answer your question. | False | False | I will stay here and answer your question. | False | False | True | True | None |

## Totals

- Direct whisper.cpp: exact 3/7; normalized 3/7; technical failures 0/7.
- `WhisperSpeechProvider`: exact 3/7; normalized 3/7; technical failures 0/7.
- Direct/provider outputs agree: exact 7/7; normalized 7/7.
- Both paths used the same project audio decode/resample/encode helpers and equivalent English/model/thread/JSON settings. No preprocessing, decode, or inference failure was observed.
- Transcript differences from expected text were identical in both paths. This shows no provider/direct discrepancy in this run; it does not establish why the model produced those transcripts.
- Human-confirmed intelligibility and intended-phrase match remain pending. WAV validity and automated recognition are not human review.
- Keep the original gate unresolved: the original phrase strings are unavailable, and this is a distinct newly authorized set.

## Runtime identification

- whisper.cpp: 1.9.5-dev.
- Model: `/home/resus/whisper.cpp/models/ggml-base.en.bin`, SHA-256 `a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002`.
- Direct command options: `-m MODEL -f PREPARED_WAV -t 4 -l en -ojf -nt`; provider uses the same model/language/thread/json options and its own output parsing.
- The first combined shell generation/validation wrapper returned 1 after writing the WAVs because a stray heredoc delimiter was passed to Python. The separate `verify-wavs.py` rerun completed successfully and validated all seven files; no WAV was regenerated or replaced.
