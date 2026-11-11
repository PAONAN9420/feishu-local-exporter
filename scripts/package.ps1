$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$manifest=Get-Content -LiteralPath (Join-Path $root 'dist/manifest.json') -Raw | ConvertFrom-Json
$out=Join-Path $root 'artifacts'
New-Item -ItemType Directory -Path $out -Force | Out-Null
$name='feishu-local-exporter-v'+$manifest.version+'.zip'
$zip=Join-Path $out $name
if(Test-Path -LiteralPath $zip){throw "Archive already exists: $zip"}
$files=Get-ChildItem -LiteralPath (Join-Path $root 'dist') -File
Compress-Archive -LiteralPath $files.FullName -DestinationPath $zip -CompressionLevel Optimal
$hash=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $out 'SHA256SUMS.txt'),"$hash  $name`n",[Text.UTF8Encoding]::new($false))
Write-Output "PASS $zip"
