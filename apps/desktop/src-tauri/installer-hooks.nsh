; PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2).
!macro NSIS_HOOK_PREINSTALL
  ; The tray process owns the bundled Node runtime as a child. Kill the whole
  ; process tree before copying so node.exe cannot keep koffi.node open.
  ExecWait 'taskkill /F /T /IM dsh-desktop.exe' $0
  ; Also catch an orphaned Prism node process whose parent already exited.
  ExecWait '$SYSDIR\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand RwBlAHQALQBQAHIAbwBjAGUAcwBzACAALQBOAGEAbQBlACAAbgBvAGQAZQAgAC0ARQByAHIAbwByAEEAYwB0AGkAbwBuACAAUwBpAGwAZQBuAHQAbAB5AEMAbwBuAHQAaQBuAHUAZQAgAHwAIABXAGgAZQByAGUALQBPAGIAagBlAGMAdAAgAHsAIAAkAF8ALgBQAGEAdABoACAALQBsAGkAawBlACAAJwAqAFwAUAByAGkAcwBtACAAQQBnAGUAbgB0AFwAcgB1AG4AdABpAG0AZQBcAG4AbwBkAGUAXABuAG8AZABlAC4AZQB4AGUAJwAgAH0AIAB8ACAAUwB0AG8AcAAtAFAAcgBvAGMAZQBzAHMAIAAtAEYAbwByAGMAZQA=' $0
  Sleep 800
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Tauri skips its built-in shortcut creation in /UPDATE mode. Recreate it
  ; after every successful install so updates cannot leave Start Menu empty.
  CreateShortcut "$SMPROGRAMS\Prism Agent.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\Prism Agent.lnk"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ExecWait 'taskkill /F /T /IM dsh-desktop.exe' $0
  ExecWait '$SYSDIR\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand RwBlAHQALQBQAHIAbwBjAGUAcwBzACAALQBOAGEAbQBlACAAbgBvAGQAZQAgAC0ARQByAHIAbwByAEEAYwB0AGkAbwBuACAAUwBpAGwAZQBuAHQAbAB5AEMAbwBuAHQAaQBuAHUAZQAgAHwAIABXAGgAZQByAGUALQBPAGIAagBlAGMAdAAgAHsAIAAkAF8ALgBQAGEAdABoACAALQBsAGkAawBlACAAJwAqAFwAUAByAGkAcwBtACAAQQBnAGUAbgB0AFwAcgB1AG4AdABpAG0AZQBcAG4AbwBkAGUAXABuAG8AZABlAC4AZQB4AGUAJwAgAH0AIAB8ACAAUwB0AG8AcAAtAFAAcgBvAGMAZQBzAHMAIAAtAEYAbwByAGMAZQA=' $0
  Sleep 800
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$SMPROGRAMS\Prism Agent.lnk"
!macroend
