param([Parameter(Mandatory = $true)][string]$Executable)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:XUTI_RUNNER_ENVIRONMENT -ne 'github-hosted' -or -not $env:RUNNER_TEMP) {
    throw 'This interactive file-copy smoke is restricted to disposable GitHub-hosted runners.'
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Path (Join-Path $PSScriptRoot 'test-desktop-file-copy.cs') -ReferencedAssemblies System.Windows.Forms,System.Core,System.Drawing
$unavailable = [ExplorerCopySmoke]::UnavailableDesktop()
if ($unavailable) {
    $message = "Explorer Ctrl+C / Ctrl+V: **not executed** because $unavailable."
    Write-Output "::notice::$message"
    Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $message
    return
}
$fixture = Join-Path $env:RUNNER_TEMP ('xuti-explorer-smoke-' + [Guid]::NewGuid().ToString('N'))
$smoke = [ExplorerCopySmoke]::new((Resolve-Path -LiteralPath $Executable).Path)
$smoke.Run($fixture)
$message = 'Explorer Ctrl+C / Ctrl+V: passed. Two fixture files were copied by Explorer, verified byte-for-byte, and retained in the source. The nested directory was excluded.'
Write-Output $message
Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $message
