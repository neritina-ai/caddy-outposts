# =============================================================================
#  Bridge runner - executes one queued job as the logged-on user.
#
#  Triggered by the scheduled task `caddy-bridge` (LogonType Interactive,
#  RunLevel Limited), so it runs in the user's interactive session with a
#  FILTERED, non-elevated token. That filtering is the whole point: actiond
#  itself runs as NT AUTHORITY\LocalService and must not be able to reach the
#  user's identity any other way.
#
#  Why a job directory instead of the old fixed request/response file pair:
#  actiond now routes EVERY action through here, so the channel has to carry
#  concurrent jobs, byte-exact stdout (an @page action's stdout IS the HTTP
#  response body), stderr kept separate, stdin, environment and an exit code.
#  The old single-slot protocol could carry none of that.
#
#  Protocol - actiond writes a job directory under <caddy>\actiond\bridge\:
#
#      job.json    {exe, args[], cwd, env{}, hasStdin}
#      stdin.bin   optional, raw bytes fed to the child
#      claim.lock  created here, atomically, by whichever runner takes the job
#      stdout.bin  raw bytes, exactly what the child wrote
#      stderr.bin  raw bytes
#      done.json   {exit, ms, identity} - written LAST; its existence means done
#
#  actiond assembles the job in a temp directory and renames it into place, so
#  a runner never observes a half-written job.
#
#  The task is registered MultipleInstances=Parallel: actiond triggers it once
#  per job, each instance claims exactly one job and exits. A runner that finds
#  nothing to claim exits immediately, which is the normal outcome of a race.
#
#  Two things this deliberately does NOT use, both learned the hard way:
#
#    * Start-Process -ArgumentList. It joins the array with spaces WITHOUT
#      quoting, so any argument containing a space or a double quote arrives
#      at the child shredded. We build the command line ourselves below.
#    * StreamReader (the .StandardOutput property). It decodes, and the child
#      decides the encoding - PowerShell writes OEM codepage when redirected.
#      We copy .BaseStream so the bytes land untouched and actiond decodes
#      exactly as it does for a directly spawned child.
# =============================================================================
$ErrorActionPreference = 'Stop'

$root      = Split-Path $PSScriptRoot -Parent          # <caddy>
$bridgeDir = Join-Path $root 'actiond\bridge'
$logFile   = Join-Path $root 'logs\bridge-runner.log'

function Log($msg) {
    try {
        Add-Content -Path $logFile -Encoding UTF8 -ErrorAction SilentlyContinue `
            -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff') + '  ' + $msg)
    } catch { }
}

# Windows command line quoting (the rules CommandLineToArgvW parses back).
# Backslashes are only special immediately before a quote, which is why the
# run length has to be tracked rather than blanket-escaped.
function Quote-Arg([string]$a) {
    if ($null -eq $a) { return '""' }
    if ($a -eq '')    { return '""' }
    if ($a -notmatch '[\s"]') { return $a }
    $sb = New-Object Text.StringBuilder
    [void]$sb.Append('"')
    $bs = 0
    foreach ($ch in $a.ToCharArray()) {
        if ($ch -eq '\') { $bs++; continue }
        if ($ch -eq '"') { [void]$sb.Append('\' * ($bs * 2 + 1)); [void]$sb.Append('"'); $bs = 0; continue }
        if ($bs) { [void]$sb.Append('\' * $bs); $bs = 0 }
        [void]$sb.Append($ch)
    }
    [void]$sb.Append('\' * ($bs * 2))
    [void]$sb.Append('"')
    return $sb.ToString()
}

if (-not (Test-Path $bridgeDir)) { return }

# ---------------------------------------------------------------- claim a job
# Oldest first, so a burst of jobs keeps its order.
$job = $null
foreach ($d in (Get-ChildItem $bridgeDir -Directory -ErrorAction SilentlyContinue |
                Sort-Object CreationTimeUtc)) {
    if ($d.Name -like '.tmp-*')                         { continue }   # still being written
    if (Test-Path (Join-Path $d.FullName 'done.json'))  { continue }
    if (Test-Path (Join-Path $d.FullName 'claim.lock')) { continue }
    if (-not (Test-Path (Join-Path $d.FullName 'job.json'))) { continue }
    try {
        # CreateNew is the atomic part: exactly one runner wins this file.
        $fs = [IO.File]::Open((Join-Path $d.FullName 'claim.lock'), 'CreateNew', 'Write', 'None')
        $fs.Close()
        $job = $d.FullName
        break
    } catch { continue }          # someone else got it, try the next one
}
if (-not $job) { return }

$outFile = Join-Path $job 'stdout.bin'
$errFile = Join-Path $job 'stderr.bin'
$sw      = [Diagnostics.Stopwatch]::StartNew()
$code    = -1
$fsOut = $null; $fsErr = $null; $proc = $null

try {
    $spec = Get-Content (Join-Path $job 'job.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Log ('claimed ' + (Split-Path $job -Leaf) + '  ' + $spec.exe)

    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName               = $spec.exe
    $psi.WorkingDirectory       = $spec.cwd
    $psi.UseShellExecute        = $false
    $psi.CreateNoWindow         = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    $psi.RedirectStandardInput  = [bool]$spec.hasStdin
    if ($spec.args) {
        $psi.Arguments = (@($spec.args) | ForEach-Object { Quote-Arg ([string]$_) }) -join ' '
    }
    if ($spec.env) {
        foreach ($p in $spec.env.PSObject.Properties) {
            $psi.EnvironmentVariables[$p.Name] = [string]$p.Value
        }
    }

    $proc  = [Diagnostics.Process]::Start($psi)
    $fsOut = [IO.File]::Create($outFile)
    $fsErr = [IO.File]::Create($errFile)
    # Both pipes must be drained concurrently or a chatty child deadlocks on a
    # full pipe buffer while we wait for the other one.
    $tOut = $proc.StandardOutput.BaseStream.CopyToAsync($fsOut)
    $tErr = $proc.StandardError.BaseStream.CopyToAsync($fsErr)

    if ($spec.hasStdin) {
        $inBytes = [IO.File]::ReadAllBytes((Join-Path $job 'stdin.bin'))
        $proc.StandardInput.BaseStream.Write($inBytes, 0, $inBytes.Length)
        $proc.StandardInput.BaseStream.Flush()
        $proc.StandardInput.Close()
    }

    $proc.WaitForExit()
    [Threading.Tasks.Task]::WaitAll(@($tOut, $tErr))
    $code = $proc.ExitCode
} catch {
    $msg = '[bridge-runner] ' + $_.Exception.Message
    try {
        if ($fsErr) { $b = [Text.Encoding]::UTF8.GetBytes("`r`n" + $msg); $fsErr.Write($b, 0, $b.Length) }
        else { [IO.File]::AppendAllText($errFile, "`r`n" + $msg, [Text.UTF8Encoding]::new($false)) }
    } catch { }
    Log ('FAILED ' + (Split-Path $job -Leaf) + ': ' + $_.Exception.Message)
    $code = -1
} finally {
    foreach ($s in $fsOut, $fsErr) { if ($s) { try { $s.Close() } catch { } } }
    if ($proc) { try { $proc.Dispose() } catch { } }
    foreach ($f in $outFile, $errFile) {
        if (-not (Test-Path $f)) { New-Item -ItemType File -Path $f -Force | Out-Null }
    }
    # done.json is written last and is the only completion signal actiond trusts.
    $who  = [Security.Principal.WindowsIdentity]::GetCurrent().Name -replace '\\', '\\'
    $done = '{"exit":' + $code + ',"ms":' + [int]$sw.Elapsed.TotalMilliseconds + ',"identity":"' + $who + '"}'
    [IO.File]::WriteAllText((Join-Path $job 'done.json'), $done, [Text.UTF8Encoding]::new($false))
    Log ('done ' + (Split-Path $job -Leaf) + '  exit=' + $code + '  ' + [int]$sw.Elapsed.TotalMilliseconds + 'ms')
}
