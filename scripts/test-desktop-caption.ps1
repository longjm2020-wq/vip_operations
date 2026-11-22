param([Parameter(Mandatory = $true)][string]$Executable)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CaptionProbe {
    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
    [DllImport("dwmapi.dll")]
    public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
}
'@

$assembly = [Reflection.Assembly]::LoadFrom((Resolve-Path -LiteralPath $Executable).Path)
$type = $assembly.GetType('XutiDesktop.DesktopShell', $true)
$form = [Activator]::CreateInstance($type, $true)
$reference = [Windows.Forms.Form]::new()
try {
    # Creating the handle tests the native caption without raising Shown or starting the device engine.
    $handle = $form.Handle
    $applyTheme = $type.GetMethod('ApplyTheme', [Reflection.BindingFlags]'Instance,NonPublic')
    $build = [int](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuildNumber
    $readableColors = @()
    if ($build -ge 22000) {
        # Some Windows Server desktop sessions share a Windows 11 build number but do
        # not expose custom colors for readback. Probe a separate window so a failure
        # on the app under test cannot turn into a skipped assertion.
        foreach ($attribute in 35, 36) {
            $sentinel = 0x123456
            $actual = 0
            $set = [CaptionProbe]::DwmSetWindowAttribute($reference.Handle, $attribute, [ref]$sentinel, 4)
            $get = [CaptionProbe]::DwmGetWindowAttribute($reference.Handle, $attribute, [ref]$actual, 4)
            if ($set -eq -2147024809 -or $get -eq -2147024809) {
                Write-Output "Custom color $attribute readback unavailable on build $build (set $set, get $get)"
            } elseif ($set -ne 0 -or $get -ne 0 -or $actual -ne $sentinel) {
                throw "Cannot validate reference caption attribute $attribute (set $set, get $get, received $actual)"
            } else {
                $readableColors += $attribute
            }
        }
    }
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
        if ($readableColors.Count -gt 0) {
            $background, $text = if ($highContrast) {
                -1, -1
            } elseif ($dark) {
                0x171312, 0xfff7f4
            } else {
                0xffffff, 0x3d2c27
            }
            $expectedColors = @{35 = $background; 36 = $text}
            foreach ($attribute in $readableColors) {
                $actual = 0
                $hr = [CaptionProbe]::DwmGetWindowAttribute($handle, $attribute, [ref]$actual, 4)
                if ($hr -ne 0 -or $actual -ne $expectedColors[$attribute]) {
                    throw "Caption attribute $attribute mismatch on build $build (HRESULT $hr, received $actual, expected $($expectedColors[$attribute]))"
                }
            }
        }
    }
    Write-Output "Desktop caption and theme transitions checked on Windows build $build"
} finally {
    $reference.Dispose()
    $form.Dispose()
}
