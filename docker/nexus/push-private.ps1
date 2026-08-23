#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$pkgDir = Join-Path $here 'sample\Ave.Nexus.Private'
$source = if ($env:NEXUS_PUSH_SOURCE) { $env:NEXUS_PUSH_SOURCE } else { 'nexus-hosted' }

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
  throw 'dotnet SDK is required to pack the private test package.'
}

dotnet pack $pkgDir -c Release -o $pkgDir
if ($LASTEXITCODE -ne 0) { throw "dotnet pack failed ($LASTEXITCODE)" }

$nupkg = Get-ChildItem -Path $pkgDir -Filter *.nupkg | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $nupkg) { throw 'pack produced no .nupkg' }

dotnet nuget push $nupkg.FullName `
  --source $source `
  --skip-duplicate `
  --allow-insecure-connections
if ($LASTEXITCODE -ne 0) { throw "dotnet nuget push failed ($LASTEXITCODE)" }

Write-Host "Pushed $($nupkg.Name) -> $source"
