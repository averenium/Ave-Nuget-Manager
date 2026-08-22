#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$pkgDir = Join-Path $here 'sample\Ave.Nexus.Private'
$source = 'http://localhost:8081/repository/nuget-hosted/'
$apiKey = 'nuget:nuget'

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
  throw 'dotnet SDK is required to pack the private test package.'
}

dotnet pack $pkgDir -c Release -o $pkgDir
$nupkg = Get-ChildItem -Path $pkgDir -Filter *.nupkg | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $nupkg) { throw 'pack produced no .nupkg' }

dotnet nuget push $nupkg.FullName --source $source --api-key $apiKey --skip-duplicate
Write-Host "Pushed $($nupkg.Name) -> $source"
