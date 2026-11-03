; Installer hooks for the browser link's native messaging host.
;
; `ud-bridge.exe` is installed beside the app, and a browser starts it for a
; moment whenever the signed-in session changes -- whether or not the app is
; running. Tauri's own check only looks for the main program, so an install
; that lands on one of those moments finds the file open and stops at an
; Abort / Retry / Ignore box. That box is the one thing an unattended update
; cannot answer, and on uninstall the same moment leaves the file behind.
;
; The helper keeps nothing in memory -- every message is one process that
; answers from files and exits -- so ending it costs at most one push, which
; the extension sends again at the next cookie change.

; A copy from before the app was renamed has a folder and an uninstall entry
; under its old name, so nothing replaces it: it would stay beside this one, and
; both would answer for the same data folder and browser link. Its uninstaller
; removes the program and leaves the data, which this one carries on from.
!macro RemoveOldName
  ReadRegStr $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Universal Downloader" "InstallLocation"
  ${If} $R1 != ""
    StrCpy $R1 $R1 -1 1 ; written in quotes
    ${If} ${FileExists} "$R1\uninstall.exe"
      ; `_?=` stops it copying itself away, so this waits for it. It cannot
      ; delete itself while running, which is why the file is removed here.
      ExecWait '"$R1\uninstall.exe" /S _?=$R1'
      Delete "$R1\uninstall.exe"
      RMDir "$R1"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  nsis_tauri_utils::KillProcessCurrentUser "ud-bridge.exe"
  Pop $R0
  !insertmacro RemoveOldName
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsis_tauri_utils::KillProcessCurrentUser "ud-bridge.exe"
  Pop $R0
!macroend
