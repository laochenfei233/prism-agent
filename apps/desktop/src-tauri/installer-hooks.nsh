; PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2).
; Identity: the installed main binary is prism-agent.exe (tauri.conf.json
; mainBinaryName). Kill only processes whose executable lives inside this
; product's install directory - never by image name, so another harness
; build's dsh-desktop.exe elsewhere on the machine is not touched. The name
; list includes the legacy dsh-desktop.exe because installs before the
; rename may still be running it.

!macro NSIS_HOOK_PREINSTALL
  ; The tray process owns the bundled Node runtime as a child. Kill the whole
  ; product-scoped process set (shell, legacy shell, bundled node) before
  ; copying so node.exe cannot keep koffi.node open.
  ExecWait '$SYSDIR\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand RwBlAHQALQBQAHIAbwBjAGUAcwBzACAALQBOAGEAbQBlACAAJwBwAHIAaQBzAG0ALQBhAGcAZQBuAHQAJwAsACcAZABzAGgALQBkAGUAcwBrAHQAbwBwACcALAAnAG4AbwBkAGUAJwAgAC0ARQByAHIAbwByAEEAYwB0AGkAbwBuACAAUwBpAGwAZQBuAHQAbAB5AEMAbwBuAHQAaQBuAHUAZQAgAHwAIABXAGgAZQByAGUALQBPAGIAagBlAGMAdAAgAHsAIAAkAF8ALgBQAGEAdABoACAALQBsAGkAawBlACAAJwAqAFwAUAByAGkAcwBtACAAQQBnAGUAbgB0AFwAKgAnACAAfQAgAHwAIABTAHQAbwBwAC0AUAByAG8AYwBlAHMAcwAgAC0ARgBvAHIAYwBlAA==' $0
  ; An install from before the binary rename leaves dsh-desktop.exe behind;
  ; the file copy does not remove it, so delete it explicitly.
  Delete /REBOOTOK "$INSTDIR\dsh-desktop.exe"
  Sleep 800
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Tauri skips its built-in shortcut creation in /UPDATE mode. Recreate it
  ; after every successful install so updates cannot leave Start Menu empty.
  CreateShortcut "$SMPROGRAMS\Prism Agent.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\Prism Agent.lnk"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Same product-scoped kill as PREINSTALL: uninstall must not end another
  ; harness build's processes, and must release our files before deletion.
  ExecWait '$SYSDIR\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand RwBlAHQALQBQAHIAbwBjAGUAcwBzACAALQBOAGEAbQBlACAAJwBwAHIAaQBzAG0ALQBhAGcAZQBuAHQAJwAsACcAZABzAGgALQBkAGUAcwBrAHQAbwBwACcALAAnAG4AbwBkAGUAJwAgAC0ARQByAHIAbwByAEEAYwB0AGkAbwBuACAAUwBpAGwAZQBuAHQAbAB5AEMAbwBuAHQAaQBuAHUAZQAgAHwAIABXAGgAZQByAGUALQBPAGIAagBlAGMAdAAgAHsAIAAkAF8ALgBQAGEAdABoACAALQBsAGkAawBlACAAJwAqAFwAUAByAGkAcwBtACAAQQBnAGUAbgB0AFwAKgAnACAAfQAgAHwAIABTAHQAbwBwAC0AUAByAG8AYwBlAHMAcwAgAC0ARgBvAHIAYwBlAA==' $0
  Sleep 800
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$SMPROGRAMS\Prism Agent.lnk"
!macroend
