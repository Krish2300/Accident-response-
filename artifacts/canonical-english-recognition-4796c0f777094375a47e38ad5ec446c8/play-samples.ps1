$ErrorActionPreference = 'Stop'
$ffplay = 'F:\aimovie\ffmpeg_extracted\ffmpeg-8.0.1-essentials_build\bin\ffplay.exe'
if (-not (Test-Path -LiteralPath $ffplay -PathType Leaf)) {
    throw ('Required ffplay.exe is missing: {0}' -f $ffplay)
}

$base = $PSScriptRoot
$samples = @(
    @{ Name = 'sample-01.wav'; Phrase = 'Hello, can you hear me?' },
    @{ Name = 'sample-02.wav'; Phrase = 'I need help, please.' },
    @{ Name = 'sample-03.wav'; Phrase = 'I am calling from the main road.' },
    @{ Name = 'sample-04.wav'; Phrase = 'The nearest landmark is the bus station.' },
    @{ Name = 'sample-05.wav'; Phrase = 'The house number is twenty-four.' },
    @{ Name = 'sample-06.wav'; Phrase = 'Please send the information to the operator.' },
    @{ Name = 'sample-07.wav'; Phrase = 'I will stay here and answer your questions.' }
)

# Confirm the complete fixed sample set exists before playing any audio.
for ($i = 0; $i -lt $samples.Count; $i++) {
    $path = Join-Path $base $samples[$i].Name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw ('Expected experiment WAV is missing: {0}' -f $path)
    }
}

for ($i = 0; $i -lt $samples.Count; $i++) {
    $path = Join-Path $base $samples[$i].Name
    Write-Host ('Phrase {0}: {1} — {2}' -f ($i + 1), $samples[$i].Name, $samples[$i].Phrase)
    & $ffplay -nodisp -autoexit -loglevel error $path
    $playerExitCode = $LASTEXITCODE
    if ($playerExitCode -ne 0) {
        throw ('ffplay failed for expected sample: {0} (exit code {1})' -f $path, $playerExitCode)
    }
}
