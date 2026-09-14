# Clears VS Code's cached extension icons, then relaunches VS Code.
Start-Sleep -Seconds 1
Get-Process Code* -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 3
$b = "$env:APPDATA\Code"
foreach ($d in "Cache", "Code Cache", "GPUCache", "CachedData") {
    Remove-Item (Join-Path $b $d) -Recurse -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1
Start-Process "code" -ArgumentList '"c:\Prashant AI gold standard"'
