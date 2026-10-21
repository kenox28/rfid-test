# USB relay helper (Windows only). Started automatically by server.js when relay.config.json
# uses a "serial" preset (e.g. LC Technology LCUS-1/2/4 USB relays, which appear as a CH340 COM port).
# Reads "<id><TAB><hex bytes>" lines from stdin, writes the bytes to the COM port and answers
# "OK<TAB><id>" or "FAIL<TAB><id><TAB><reason>". It never touches the disk or the network.
param(
    [Parameter(Mandatory = $true)][string]$Port,
    [Parameter(Mandatory = $true)][int]$Baud
)
$ErrorActionPreference = 'Stop'

function Say([string]$line) { [Console]::Out.WriteLine($line); [Console]::Out.Flush() }

if ($Port -eq 'auto') {
    $ports = @([System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object -Unique)
    if ($ports.Count -gt 1) {
        # Prefer the USB-serial chip LCUS relays use (CH340) over built-in ports like COM1
        $usb = @(Get-CimInstance Win32_PnPEntity |
            Where-Object { $_.Name -match 'CH340|CH341|USB-SERIAL|USB Serial' -and $_.Name -match '\(COM\d+\)' } |
            ForEach-Object { [regex]::Match($_.Name, 'COM\d+').Value })
        if ($usb.Count -eq 1) { $ports = $usb }
    }
    if ($ports.Count -eq 0) {
        Say "ERROR`tNo COM port found. Is the relay plugged into USB? Install the CH340 driver if Device Manager shows an unknown device."
        exit 2
    }
    if ($ports.Count -gt 1) {
        Say ("ERROR`tSeveral COM ports found (" + ($ports -join ', ') + '). Set "serialPort" in relay.config.json to the relay''s port.')
        exit 2
    }
    $Port = $ports[0]
}

$sp = New-Object System.IO.Ports.SerialPort $Port, $Baud, ([System.IO.Ports.Parity]::None), 8, ([System.IO.Ports.StopBits]::One)
$sp.WriteTimeout = 2000
try {
    $sp.Open()
} catch {
    Say ("ERROR`tCould not open ${Port}: " + $_.Exception.Message + ' Close other relay software and try again.')
    exit 3
}
Say "READY`t$Port"

while ($null -ne ($line = [Console]::In.ReadLine())) {
    $parts = $line -split "`t", 2
    if ($parts.Count -ne 2) { continue }
    $id = $parts[0]
    try {
        $bytes = [byte[]]@($parts[1] -split ' ' | Where-Object { $_ -ne '' } | ForEach-Object { [Convert]::ToByte($_, 16) })
        $sp.Write($bytes, 0, $bytes.Length)
        Say "OK`t$id"
    } catch {
        Say ("FAIL`t$id`t" + ($_.Exception.Message -replace "[`t`r`n]", ' '))
        if (-not $sp.IsOpen) { exit 4 }   # unplugged: let server.js restart us
    }
}
$sp.Close()
