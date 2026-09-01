# @title   主機健康檢查
# @desc    磁碟空間、記憶體、開機時間
# @group   system
Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" |
  Select-Object DeviceID,
    @{n='Free(GB)';e={[math]::Round($_.FreeSpace/1GB,1)}},
    @{n='Size(GB)';e={[math]::Round($_.Size/1GB,1)}} | Format-Table -AutoSize | Out-String -Width 120
$os = Get-CimInstance Win32_OperatingSystem
"RAM free : {0:N1} GB / {1:N1} GB" -f ($os.FreePhysicalMemory/1MB), ($os.TotalVisibleMemorySize/1MB)
"Uptime   : {0}" -f ((Get-Date) - $os.LastBootUpTime).ToString('d\ hh\:mm')
