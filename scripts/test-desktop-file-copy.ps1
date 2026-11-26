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
try {
    $smoke.Run($fixture)
} catch {
    # Windows PowerShell normally prints only the outer reflection exception.
    Write-Output $_.Exception.ToString()
    throw
}
$message = 'Explorer Ctrl+C / Ctrl+V passed for an existing target and a newly named folder on a redirected Desktop. The two file-only fixtures and complete nested tree were verified, including empty directories, same-task resume and duplicate prevention.'
Write-Output $message
Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $message
