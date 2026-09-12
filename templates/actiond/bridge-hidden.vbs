' Launches bridge-runner.ps1 with no console window at all.
'
' Why this file exists: the scheduled task runs in the user's interactive
' session, and powershell.exe allocates a console there BEFORE it can apply
' -WindowStyle Hidden. The result is a visible flash on the desktop for every
' single job - measured: 10 jobs, 10 flashes, even when the jobs failed early
' and never launched a child.
'
' wscript.exe allocates no console, and Run(cmd, 0, True) starts the process
' hidden and waits for it, so the task's own lifetime still matches the job's.
' This is the same trick pm2-windows-startup uses for its resurrect script.
Option Explicit

Dim sh, here, cmd
Set sh = CreateObject("WScript.Shell")
here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1)
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & here & "\bridge-runner.ps1"""
WScript.Quit sh.Run(cmd, 0, True)
