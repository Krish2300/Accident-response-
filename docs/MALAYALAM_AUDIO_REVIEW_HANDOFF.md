# Malayalam synthetic audio — fluent-speaker handoff

Please ask a fluent Malayalam speaker to listen to each original WAV and mark
both judgments independently. Do not use ASR output or WAV metadata to answer
either question. Leave the original audio files unchanged.

For every clip, record:

- **Intelligibility:** Yes or No.
- **Intended phrase match:** Yes or No.

Add reviewer name/fluency basis and review date below. These are human judgments;
this template is intentionally blank.

| ID | Intended Malayalam phrase | WAV | Intelligible? | Intended phrase match? |
|---:|---|---|---|---|
| 1 | ഇത് ഒരു പരിശീലന സന്ദേശമാണ്. | `01.wav` | [ ] Yes [ ] No | [ ] Yes [ ] No |
| 2 | പരിശീലന വാഹനം റോഡരികിൽ നിൽക്കുന്നു. | `02.wav` | [ ] Yes [ ] No | [ ] Yes [ ] No |
| 3 | സഹായസംഘം സ്ഥലത്തെത്തി. | `03.wav` | [ ] Yes [ ] No | [ ] Yes [ ] No |
| 4 | സിമുലേഷൻ ഇപ്പോൾ ആരംഭിക്കുന്നു. | `04.wav` | [ ] Yes [ ] No | [ ] Yes [ ] No |
| 5 | ഈ ഉദാഹരണം യഥാർത്ഥ അടിയന്തരാവസ്ഥയല്ല. | `05.wav` | [ ] Yes [ ] No | [ ] Yes [ ] No |
| 6 | പരിശീലന സംഘത്തിൽ മൂന്ന് പേർ ഉണ്ട്. | `06.wav` | [ ] Yes [ ] No | [ ] Yes [ ] No |
| 7 | പരീക്ഷണ സന്ദേശം ഇപ്പോൾ അവസാനിക്കുന്നു. | `07.wav` | [ ] Yes [ ] No | [ ] Yes [ ] No |

Reviewer: ____________________  Fluency basis: ____________________

Review date: ____________________  Notes (optional): ____________________

## Play clips in sequence on Windows

The source WAVs and source checklist are in:

`\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z`

The following PowerShell snippet uses the installed `ffplay.exe`, opens each
clip in order, waits for playback to finish, then pauses for the reviewer to
record both judgments before continuing:

```powershell
$audioRoot = '\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z'
$ffplay = 'F:\aimovie\ffmpeg_extracted\ffmpeg-8.0.1-essentials_build\bin\ffplay.exe'
1..7 | ForEach-Object {
    $clip = Join-Path $audioRoot ('{0:D2}.wav' -f $_)
    & $ffplay -nodisp -autoexit $clip
    Read-Host "Clip $_: record Intelligible Yes/No and Intended phrase match Yes/No, then press Enter"
}
```

The previous automated phrase-recognition result was **0/7**. That result does
not establish whether a clip is unintelligible, was generated incorrectly, or
was simply not recognized by the ASR model. Only the fluent speaker should
complete these fields. Preserve this handoff as a separate copy; do not replace
or edit the experiment's original checklist. A completed review must contain 14
explicit Yes/No judgments and reviewer/date details before it is summarized.
