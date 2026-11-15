param([string]$ExpectedHandle, [string]$ExpectedUrl)

# Read the selected URL from browser chrome, excluding page content.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class FocusForeground {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
$handle = [FocusForeground]::GetForegroundWindow()
if ($handle -eq [IntPtr]::Zero) { return }
$window = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
$browser = Get-Process -Id $window.Current.ProcessId -ErrorAction SilentlyContinue
if ($browser.ProcessName -notin 'chrome','msedge','firefox','brave','vivaldi','opera') { return }
$edit = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Edit)
foreach ($element in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $edit)) {
    $parent = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($element)
    $isPage = $false
    while ($null -ne $parent -and -not $parent.Equals($window)) {
        if ($parent.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document) {
            $isPage = $true
            break
        }
        $parent = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($parent)
    }
    if ($isPage -or $element.Current.HasKeyboardFocus -or $element.Current.IsOffscreen) { continue }
    if ($element.Current.AutomationId -notin 'urlbar-input','addressEditBox','omnibox' -and
        $element.Current.Name -notin 'Address and search bar','Search or enter address','Address bar' -and
        -not ($browser.ProcessName -eq 'firefox' -and $element.Current.Name -match '^(Search(?: with .+)? or enter address|Search address)$')) { continue }
    $pattern = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern) -and
        [FocusForeground]::GetForegroundWindow() -eq $handle) {
        $url = $pattern.Current.Value
        if ($ExpectedHandle) {
            if ($handle.ToInt64().ToString() -cne $ExpectedHandle -or $url -cne $ExpectedUrl) { return }
            Add-Type -AssemblyName System.Windows.Forms
            if ([FocusForeground]::GetForegroundWindow() -ne $handle) { return }
            [System.Windows.Forms.SendKeys]::SendWait('^w')
            '{"closeRequested":true}'
        } else {
            @{ handle = $handle.ToInt64().ToString(); url = $url } | ConvertTo-Json -Compress
        }
        return
    }
}
