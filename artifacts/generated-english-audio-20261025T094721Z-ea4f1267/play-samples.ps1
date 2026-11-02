$ErrorActionPreference = 'Stop'
$ffplay = 'F:\aimovie\ffmpeg_extracted\ffmpeg-8.0.1-essentials_build\bin\ffplay.exe'
if (-not (Test-Path -LiteralPath $ffplay -PathType Leaf)) {
    throw "Required ffplay.exe is missing: $ffplay"
}
$expectedFiles = @(
    (Join-Path $PSScriptRoot 'greeting.wav'),
    (Join-Path $PSScriptRoot 'location.wav'),
    (Join-Path $PSScriptRoot 'number-and-landmark.wav')
)
foreach ($file in $expectedFiles) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Required generated sample is missing: $file"
    }
    if ((Get-Item -LiteralPath $file).Length -le 0) {
        throw "Generated sample is empty: $file"
    }
}
foreach ($file in $expectedFiles) {
    Write-Host "Playing $([System.IO.Path]::GetFileName($file))"
    & $ffplay -nodisp -autoexit -loglevel error $file
    if ($LASTEXITCODE -ne 0) {
        throw "ffplay failed for $file (exit $LASTEXITCODE)"
    }
}