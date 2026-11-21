; PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2).
; Identity: the installed main binary is prism-agent.exe (tauri.conf.json
; mainBinaryName). Kill only processes whose executable lives inside this
; product's install directory - never by image name, so another harness
; build's dsh-desktop.exe elsewhere on the machine is not touched. The name
; list includes the legacy dsh-desktop.exe because installs before the
; rename may still be running it.
;
; The shell is tray-resident, so TerminateProcess never reaches the exit path
; that deletes its notification-area icon; Windows keeps a ghost entry. Stop
; it through `--quit` first: PRISM_STOP_SHELL starts the installed shell with
; --quit only when a process with that exact path is running, polls for up to
; 15 s, then force-kills by exact executable path (shell, legacy shell, and
; the bundled runtime). A shell that predates --quit starts a second shell
; instead; the poll expires and the forced kill finishes, so the installer
; cannot hang on an unknown binary.

!macro PRISM_STOP_SHELL
  InitPluginsDir
  FileOpen $0 "$PLUGINSDIR\stop-prism-shell.ps1" w
  FileWrite $0 'param([string]$$root)$\r$\n'
  FileWrite $0 'if (-not $$root) { exit 1 }$\r$\n'
  FileWrite $0 '$$shell = Join-Path $$root $\"prism-agent.exe$\"$\r$\n'
  FileWrite $0 '$$legacy = Join-Path $$root $\"dsh-desktop.exe$\"$\r$\n'
  FileWrite $0 '$$running = @(Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath -ieq $$shell })$\r$\n'
  FileWrite $0 'if ($$running.Count -gt 0) {$\r$\n'
  FileWrite $0 '  Start-Process -FilePath $$shell -ArgumentList $\"--quit$\" -WindowStyle Hidden -ErrorAction SilentlyContinue$\r$\n'
  FileWrite $0 '  $$deadline = (Get-Date).AddSeconds(15)$\r$\n'
  FileWrite $0 '  while ((Get-Date) -lt $$deadline) {$\r$\n'
  FileWrite $0 '    Start-Sleep -Milliseconds 250$\r$\n'
  FileWrite $0 '    if (@(Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath -ieq $$shell }).Count -eq 0) { break }$\r$\n'
  FileWrite $0 '  }$\r$\n'
  FileWrite $0 '}$\r$\n'
  FileWrite $0 '$$runtime = (Join-Path $$root $\"runtime$\") + [IO.Path]::DirectorySeparatorChar$\r$\n'
  FileWrite $0 'Get-CimInstance Win32_Process | Where-Object {$\r$\n'
  FileWrite $0 '  $$path = $$_.ExecutablePath$\r$\n'
  FileWrite $0 '  $$path -and ($$path -ieq $$shell -or $$path -ieq $$legacy -or $$path.StartsWith($$runtime, [StringComparison]::OrdinalIgnoreCase))$\r$\n'
  FileWrite $0 '} | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }$\r$\n'
  FileWrite $0 'Start-Sleep -Milliseconds 400$\r$\n'
  FileClose $0
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop-prism-shell.ps1" "$INSTDIR"'
  Pop $0
  Sleep 800
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro PRISM_STOP_SHELL
  ; An install from before the binary rename leaves dsh-desktop.exe behind;
  ; the file copy does not remove it, so delete it explicitly.
  Delete /REBOOTOK "$INSTDIR\dsh-desktop.exe"
!macroend

; PRISM_FIREWALL_RULES keeps the phone able to reach the hub's LAN listener.
; The hub (--bind-lan) serves the machine's private interfaces on INTERNAL_PORT
; (38081), but the default inbound policy is BlockInbound and old Defender
; popups can leave ENABLED Block rules for the bundled runtime node — and
; Block outranks Allow, so the hub's listener would be unreachable from the
; network no matter what port allow rules say. The installer runs elevated, so
; it recreates the two Allow rules (the 38081 port and the bundled node.exe
; program, any profile) and removes exactly the Prism-path node.exe Block
; rules; rules already present when a Defender prompt would appear also
; suppress that prompt, so the deny path that created them never opens again.
!macro PRISM_FIREWALL_RULES
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name=$\"Prism Agent TCP 38081$\"'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall add rule name=$\"Prism Agent TCP 38081$\" dir=in action=allow protocol=TCP localport=38081 profile=any'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name=$\"Prism Agent runtime node$\"'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall add rule name=$\"Prism Agent runtime node$\" dir=in action=allow program=$\"$INSTDIR\runtime\node\node.exe$\" enable=yes profile=any'
  Pop $0
  InitPluginsDir
  FileOpen $0 "$PLUGINSDIR\prism-fw-cleanup.ps1" w
  FileWrite $0 'param([string]$$root)$\r$\n'
  FileWrite $0 'if (-not $$root) { exit 0 }$\r$\n'
  FileWrite $0 '$$runtimeNode = Join-Path $$root $\"runtime\node\node.exe$\"$\r$\n'
  FileWrite $0 'foreach ($$rule in @(Get-NetFirewallRule -DisplayName $$\"node.exe$$\" -ErrorAction SilentlyContinue)) {$\r$\n'
  FileWrite $0 '  if ($$rule.Action -ne $$\"Block$$\") { continue }$\r$\n'
  FileWrite $0 '  $$filter = $$rule | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue$\r$\n'
  FileWrite $0 '  if ($$filter -and $$filter.Program -ieq $$runtimeNode) {$\r$\n'
  FileWrite $0 '    Remove-NetFirewallRule -Name $$rule.Name -ErrorAction SilentlyContinue$\r$\n'
  FileWrite $0 '  }$\r$\n'
  FileWrite $0 '}$\r$\n'
  FileWrite $0 'exit 0$\r$\n'
  FileClose $0
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\prism-fw-cleanup.ps1" "$INSTDIR"'
  Pop $0
!macroend

; PRISM_FIREWALL_REMOVE deletes the rules PRISM_FIREWALL_RULES created, so an
; uninstall does not leave an inbound hole for a program that no longer exists.
!macro PRISM_FIREWALL_REMOVE
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name=$\"Prism Agent TCP 38081$\"'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name=$\"Prism Agent runtime node$\"'
  Pop $0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Tauri skips its built-in shortcut creation in /UPDATE mode. Recreate it
  ; after every successful install so updates cannot leave Start Menu empty.
  CreateShortcut "$SMPROGRAMS\Prism Agent.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\Prism Agent.lnk"
  !insertmacro PRISM_FIREWALL_RULES
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro PRISM_STOP_SHELL
  !insertmacro PRISM_FIREWALL_REMOVE
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$SMPROGRAMS\Prism Agent.lnk"
!macroend
