param([Parameter(Mandatory = $true)][string]$Executable)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CaptionProbe {
    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
}
'@

$assembly = [Reflection.Assembly]::LoadFrom((Resolve-Path -LiteralPath $Executable).Path)
$type = $assembly.GetType('XutiDesktop.DesktopShell', $true)
$form = [Activator]::CreateInstance($type, $true)
try {
    # Creating the handle tests the native caption without raising Shown or starting the device engine.
    $handle = $form.Handle
    $applyTheme = $type.GetMethod('ApplyTheme', [Reflection.BindingFlags]'Instance,NonPublic')
    $build = [int](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuildNumber
    foreach ($dark in $true, $false, $true) {
        $applyTheme.Invoke($form, @($dark))
        if ($form.Text -cne 'XUTI DESKTOP') { throw 'Unexpected desktop title' }
        $highContrast = [Windows.Forms.SystemInformation]::HighContrast
        if ($build -ge 19041) {
            $flag = 0
            $hr = [CaptionProbe]::DwmGetWindowAttribute($handle, 20, [ref]$flag, 4)
            if ($hr -ne 0 -or ($flag -ne 0) -ne ($dark -and -not $highContrast)) {
                throw "Caption dark mode flag mismatch (HRESULT $hr, received $flag)"
            }
        }
        # Explicit caption and text COLORREF values are supported starting at build 22000.
        if ($build -ge 22000) {
            $background, $text = if ($highContrast) {
                -1, -1
            } elseif ($dark) {
                0x171312, 0xfff7f4
            } else {
                0xffffff, 0x3d2c27
            }
            foreach ($entry in @{35 = $background; 36 = $text}.GetEnumerator()) {
                $actual = 0
                $hr = [CaptionProbe]::DwmGetWindowAttribute($handle, $entry.Key, [ref]$actual, 4)
                if ($hr -ne 0 -or $actual -ne $entry.Value) {
                    throw "Caption attribute $($entry.Key) mismatch on build $build (HRESULT $hr, received $actual, expected $($entry.Value))"
                }
            }
        }
    }
    Write-Output "Desktop caption and theme transitions checked on Windows build $build"
} finally {
    $form.Dispose()
}
