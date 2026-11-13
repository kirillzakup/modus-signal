# Offline Russian narration. UTF-8 source text, PCM WAV output, no paid API.
# powershell -NoProfile -File speech.ps1 -TextPath path\voice.txt -OutputPath path\voice.wav
# Rate is SAPI's -10..10 scale. -1 is a measured tutorial delivery.
param(
    [Parameter(Mandatory=$true)][string]$TextPath,
    [Parameter(Mandatory=$true)][string]$OutputPath,
    [ValidateRange(-10,10)][int]$Rate = -1,
    [string]$Voice = 'Microsoft Irina Desktop'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$inputFile = (Resolve-Path -LiteralPath $TextPath).Path
$outputFile = [IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $outputFile) { throw "Refusing to overwrite existing audio: $outputFile" }
$text = [IO.File]::ReadAllText($inputFile, [Text.Encoding]::UTF8).Trim()
if ([string]::IsNullOrWhiteSpace($text)) { throw 'Narration text is empty' }
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($outputFile)) | Out-Null
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $synth.SelectVoice($Voice)
    $synth.Rate = $Rate
    $synth.Volume = 100
    $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $synth.SetOutputToWaveFile($outputFile, $format)
    $synth.Speak($text)
    $synth.SetOutputToNull()
} finally { $synth.Dispose() }
Get-Item -LiteralPath $outputFile | Select-Object FullName,Length
