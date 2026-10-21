Option Explicit
Dim shell, files, scriptPath, powerShellPath, command, result
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
scriptPath = files.BuildPath(files.GetParentFolderName(WScript.ScriptFullName), "start-workbench-agent.ps1")
If WScript.Arguments.Count <> 1 Then
    Fail "PowerShell 7 path is missing. Please repair the desktop shortcut."
End If
powerShellPath = WScript.Arguments(0)
If Not files.FileExists(powerShellPath) Then Fail "PowerShell 7 was not found: " & powerShellPath
If Not files.FileExists(scriptPath) Then Fail "Workbench startup script was not found: " & scriptPath

' wscript has no console; the child process starts hidden from creation.
command = Quote(powerShellPath) & " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Quote(scriptPath)
On Error Resume Next
result = shell.Run(command, 0, True)
If Err.Number <> 0 Then
    Dim message
    message = Err.Description
    On Error GoTo 0
    Fail "Could not start the workbench: " & message
End If
On Error GoTo 0
If result <> 0 Then Fail "Workbench startup failed (exit " & result & "). See agent-launch-error.log in the application folder."
WScript.Quit 0

Function Quote(value)
    Quote = Chr(34) & value & Chr(34)
End Function

Sub Fail(message)
    shell.Popup message, 0, "DIY Tools startup", 16
    WScript.Quit 1
End Sub
