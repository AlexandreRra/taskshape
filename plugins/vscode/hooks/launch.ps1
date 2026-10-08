param([string]$Script, [Parameter(ValueFromRemainingArguments=$true)][string[]]$Rest,
  [Parameter(ValueFromPipeline=$true)][string]$PipelinePayload)
$ErrorActionPreference = 'Stop'
$NeedMajor = 22
$NeedMinor = 6
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginRoot = Split-Path -Parent $ScriptDir
$TaskshapeHome = if ($env:TASKSHAPE_HOME) { $env:TASKSHAPE_HOME } else { Join-Path $HOME '.taskshape' }
$NodeRoot = Join-Path $TaskshapeHome 'node'
$Assets = if ($env:TASKSHAPE_NODE_ASSETS) { $env:TASKSHAPE_NODE_ASSETS } else { Join-Path $PluginRoot 'runtime/node-assets.tsv' }
$BaseUrl = if ($env:TASKSHAPE_NODE_BASE_URL) { $env:TASKSHAPE_NODE_BASE_URL } else { $null }
$StatusFile = Join-Path $NodeRoot 'status.txt'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $OutputEncoding
[Console]::OutputEncoding = $OutputEncoding
$HookInput = ''
if ($Script -ne '--install-node') {
  $PipelineText = if ($PipelinePayload) { $PipelinePayload } else { @($input) -join [Environment]::NewLine }
  $HookInput = if ($PipelineText.Length -gt 0) { $PipelineText } else { [Console]::In.ReadToEnd() }
}

function Test-Node([string]$Node) {
  if (-not $Node -or -not (Test-Path -LiteralPath $Node -PathType Leaf)) { return $false }
  try { & $Node -e 'const m=/^(\d+)\.(\d+)/.exec(process.versions.node);process.exit(+m[1]>22||(+m[1]===22&&+m[2]>=6)?0:1)' *> $null }
  catch { return $false }
  return $LASTEXITCODE -eq 0
}
function Get-SystemNode {
  if ($env:TASKSHAPE_FORCE_BUNDLED_NODE -eq '1') { return $null }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and (Test-Node $cmd.Source)) { return $cmd.Source }
  return $null
}
function Get-Platform {
  if ($IsWindows -or $env:OS -eq 'Windows_NT') {
    if ([Environment]::Is64BitOperatingSystem -and $env:PROCESSOR_ARCHITECTURE -match 'ARM64') { return 'win-arm64' }
    if ([Environment]::Is64BitOperatingSystem) { return 'win-x64' }
    return 'win-x86'
  }
  return $null
}
function Get-Asset([string]$Platform) {
  if (-not (Test-Path $Assets)) { return $null }
  foreach ($line in Get-Content $Assets) {
    if ($line.StartsWith('#')) { continue }
    $parts = $line -split "`t"
    if ($parts.Length -ge 4 -and $parts[0] -eq $Platform) {
      return @{ version = $parts[1]; filename = $parts[2]; sha256 = $parts[3] }
    }
  }
  return $null
}
function Write-NodeStatus([string]$Value) {
  New-Item -ItemType Directory -Force -Path $NodeRoot | Out-Null
  Set-Content -Path $StatusFile -Value $Value -Encoding UTF8
}
function Fail-Install([string]$Message) { Write-NodeStatus ('error: ' + $Message); return }
function Start-LayaPrepare([string]$Node) {
  $Cli = Join-Path $ScriptDir 'runtime-cli.ts'
  if (Test-Path $Cli) { Start-Process -FilePath $Node -ArgumentList @('--no-warnings','--experimental-strip-types',('"' + $Cli + '"'),'prepare') -WindowStyle Hidden | Out-Null }
}
function Install-Node {
  $Platform = Get-Platform
  if (-not $Platform) { return }
  $Asset = Get-Asset $Platform
  if (-not $Asset) { return }
  $Dest = Join-Path $NodeRoot (Join-Path ('v' + $Asset.version) $Platform)
  $Node = Join-Path $Dest 'node.exe'
  if (Test-Node $Node) { Start-LayaPrepare $Node; return }
  New-Item -ItemType Directory -Force -Path $NodeRoot | Out-Null
  $Lock = Join-Path $NodeRoot 'install.lock'
  try { New-Item -ItemType Directory -Path $Lock -ErrorAction Stop | Out-Null } catch {
    $Item = Get-Item $Lock -ErrorAction SilentlyContinue
    if ($Item -and $Item.LastWriteTime -lt (Get-Date).AddMinutes(-30)) { Remove-Item -Recurse -Force $Lock -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Path $Lock -ErrorAction SilentlyContinue | Out-Null } else { return }
  }
  try {
    Write-NodeStatus 'installing'
    $Tmp = Join-Path $NodeRoot ([Guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
    $Archive = Join-Path $Tmp $Asset.filename
    if ($BaseUrl) {
      if ($BaseUrl -notlike 'https://nodejs.org/*' -and $BaseUrl -notlike 'file://*') { Fail-Install 'untrusted Node.js download URL'; return }
      $Url = $BaseUrl.TrimEnd('/') + '/' + $Asset.filename
    } else { $Url = 'https://nodejs.org/dist/v' + $Asset.version + '/' + $Asset.filename }
    Invoke-WebRequest -Uri $Url -OutFile $Archive -UseBasicParsing
    $Hash = (Get-FileHash -Algorithm SHA256 $Archive).Hash.ToLowerInvariant()
    if ($Hash -ne $Asset.sha256) { Fail-Install 'Node.js checksum mismatch'; return }
    $TmpDest = "$Dest.tmp"
    Remove-Item -Recurse -Force $TmpDest -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $TmpDest | Out-Null
    Expand-Archive -Path $Archive -DestinationPath $TmpDest -Force
    $Expanded = Get-ChildItem $TmpDest | Select-Object -First 1
    if ($Expanded -and (Test-Path (Join-Path $Expanded.FullName 'node.exe'))) {
      Remove-Item -Recurse -Force $Dest -ErrorAction SilentlyContinue
      Move-Item $Expanded.FullName $Dest -Force
      Write-NodeStatus 'ready'
      Start-LayaPrepare $Node
    } else { Fail-Install 'could not extract Node.js' }
  } catch { Fail-Install 'could not download or install Node.js' } finally {
    if ($Tmp) { Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue }
    if ($TmpDest) { Remove-Item -Recurse -Force $TmpDest -ErrorAction SilentlyContinue }
    Remove-Item -Recurse -Force $Lock -ErrorAction SilentlyContinue
  }
}
function Get-BundledNode {
  $Platform = Get-Platform
  $Asset = Get-Asset $Platform
  if (-not $Asset) { return $null }
  $Node = Join-Path $NodeRoot (Join-Path (Join-Path ('v' + $Asset.version) $Platform) 'node.exe')
  if (Test-Node $Node) { return $Node }
  return $null
}

if ($Script -eq '--install-node') { Install-Node; exit 0 }
$NodeBin = Get-SystemNode
if (-not $NodeBin) { $NodeBin = Get-BundledNode }
if (-not $NodeBin -and $env:TASKSHAPE_REQUIRE_BUNDLED_NODE -eq '1') {
  Install-Node
  $NodeBin = Get-BundledNode
  if (-not $NodeBin) {
    [Console]::Error.WriteLine('Taskshape: private Node.js setup did not produce a runnable Node.js binary')
    exit 1
  }
}
if ($NodeBin) {
  if (-not $Script) { exit 0 }
  $HookArgs = @('--no-warnings', '--experimental-strip-types', (Join-Path $ScriptDir $Script)) + $Rest
  if ($HookInput.Length -gt 0) { $HookInput | & $NodeBin @HookArgs }
  else { & $NodeBin @HookArgs }
  exit $LASTEXITCODE
}
if ((Test-Path $StatusFile) -and ((Get-Content $StatusFile -Raw) -match '^error:')) {
  $Msg = (Get-Content $StatusFile -Raw).Trim() -replace '^error: ', ''
  [Console]::Error.WriteLine('Taskshape: private Node.js setup failed: ' + $Msg + '; original model kept')
} else { [Console]::Error.WriteLine('Taskshape: preparing private Node.js runtime; original model kept') }
Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"' + $MyInvocation.MyCommand.Path + '"'),'--install-node') -WindowStyle Hidden | Out-Null
exit 0
