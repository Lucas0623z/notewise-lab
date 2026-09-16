; electron-builder nsis.include. Uses a visible official Microsoft installer.
; No app-local DLL copying, shared-runtime uninstall, or automatic reboot.
!ifndef STEM_VC_PREREQUISITES_INCLUDED
!define STEM_VC_PREREQUISITES_INCLUDED

!include LogicLib.nsh
!include WordFunc.nsh
!include nsDialogs.nsh
!include MUI2.nsh

!define STEM_VC_VERSION "14.51.36247.0"
; MUI's default Finish page can invoke Reboot when the flag is set. Keep only
; our explicit notice: the user restarts Windows themselves after setup.
!ifndef MUI_FINISHPAGE_NOREBOOTSUPPORT
  !define MUI_FINISHPAGE_NOREBOOTSUPPORT
!endif
!ifndef STEM_VC_INSTALLER
  !define STEM_VC_INSTALLER "${PROJECT_DIR}\build-resources\prerequisites\vc_redist.x64.exe"
!endif

!ifndef BUILD_UNINSTALLER
Var stemVcReady
Var stemVcDetected
Var stemVcDialog
Var stemVcLabel
Var stemVcExit

; Probe the x64 runtime key in both registry views. Never accepts an x86 key.
; Return global stemVcReady=1 only when Installed=1 and all version fields exist.
Function StemCheckVcRuntime
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  StrCpy $stemVcReady 0
  StrCpy $stemVcDetected "未安装"
  SetRegView 64
  StrCpy $4 64
stem_vc_probe:
  ClearErrors
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ${IfNot} ${Errors}
  ${AndIf} $0 == 1
    ClearErrors
    ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Major"
    ReadRegDWORD $1 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Minor"
    ReadRegDWORD $2 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Bld"
    ReadRegDWORD $3 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Rbld"
    ${IfNot} ${Errors}
      StrCpy $stemVcDetected "$0.$1.$2.$3"
      ${VersionCompare} "$stemVcDetected" "${STEM_VC_VERSION}" $0
      ${If} $0 != 2
        StrCpy $stemVcReady 1
        Goto stem_vc_probe_done
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${If} $4 == 64
    SetRegView 32
    StrCpy $4 32
    Goto stem_vc_probe
  ${EndIf}
stem_vc_probe_done:
  SetRegView 64 ; this product and electron-builder install registry are x64
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function StemVcPrerequisitePage
  Call StemCheckVcRuntime
  ${If} $stemVcReady == 1
    Abort ; skip only this page when the installed version already satisfies it
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "安装所需的微软运行组件" "本机音频识别需要 Microsoft Visual C++ x64 运行库。"
  nsDialogs::Create 1018
  Pop $stemVcDialog
  ${If} $stemVcDialog == error
    MessageBox MB_OK|MB_ICONSTOP "无法显示运行组件说明，安装已停止。"
    SetErrorLevel 1603
    Quit
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 22u "需要版本：${STEM_VC_VERSION} 或更高版本。当前检测：$stemVcDetected。"
  Pop $stemVcLabel
  ${NSD_CreateLabel} 0 29u 100% 36u "点击“下一步”将打开微软官方安装窗口。请在该窗口阅读并接受微软许可条款，按提示完成安装；Windows 可能要求管理员确认。"
  Pop $stemVcLabel
  ${NSD_CreateLabel} 0 72u 100% 34u "本应用不会代您接受条款。取消微软安装后，可留在此页重试或退出本应用安装。此过程不会自动重启电脑。"
  Pop $stemVcLabel
  ${NSD_CreateLabel} 0 111u 100% 24u "无需另行安装 Python。此微软运行库由多个程序共享，卸载本应用时会保留它。"
  Pop $stemVcLabel
  nsDialogs::Show
FunctionEnd

Function StemVcPrerequisiteLeave
  Call StemCheckVcRuntime
  ${If} $stemVcReady == 1
    Return
  ${EndIf}
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=vc_redist.x64.exe "${STEM_VC_INSTALLER}"
  ClearErrors
  ; Burn presents its own full UI and requests elevation after user consent.
  ; Deliberately omit /quiet and /passive so Microsoft terms remain visible.
  ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /norestart /log "$TEMP\stem-studio-vc-redist.log"' $stemVcExit
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "无法启动微软运行库安装程序。请确认 Windows 允许运行该微软签名文件后重试。"
    Abort
  ${EndIf}
  ${If} $stemVcExit == 1602
  ${OrIf} $stemVcExit == 1223
  ${OrIf} $stemVcExit == -2147023294 ; HRESULT_FROM_WIN32(1602)
  ${OrIf} $stemVcExit == -2147023673 ; HRESULT_FROM_WIN32(1223)
    MessageBox MB_OK|MB_ICONINFORMATION "已取消微软运行库安装。您可以重试，或点击“取消”退出本应用安装。"
    Abort
  ${EndIf}
  ${If} $stemVcExit == 3010
    SetRebootFlag true
    MessageBox MB_OK|MB_ICONINFORMATION "微软运行库已安装，需要重启电脑才能完成。您可以继续安装本应用；请自行重启后再使用本机识别。不会自动重启。"
    Return
  ${EndIf}
  ${If} $stemVcExit == 1641
    SetRebootFlag true
    MessageBox MB_OK|MB_ICONINFORMATION "微软运行库安装程序报告系统正在重启。请重启后重新打开本应用安装程序。"
    SetErrorLevel 1641
    Quit
  ${EndIf}
  Call StemCheckVcRuntime
  ${If} $stemVcExit == 0
  ${OrIf} $stemVcExit == 1638
  ${OrIf} $stemVcExit == -2147023258 ; HRESULT_FROM_WIN32(1638)
    ${If} $stemVcReady == 1
      Return
    ${EndIf}
  ${EndIf}
  ${If} $stemVcExit == 1618
  ${OrIf} $stemVcExit == -2147023278 ; HRESULT_FROM_WIN32(1618)
    MessageBox MB_OK|MB_ICONEXCLAMATION "Windows 正在安装其他程序。请等它完成后点击“下一步”重试。"
  ${Else}
    MessageBox MB_OK|MB_ICONSTOP "微软运行库尚未安装成功，返回码：$stemVcExit。$\r$\n日志：$TEMP\stem-studio-vc-redist.log$\r$\n请检查日志后重试；本应用安装尚未开始。"
  ${EndIf}
  Abort ; remain on this page, before files/old versions are changed
FunctionEnd

; Silent upgrades may skip an already satisfied prerequisite. They must not
; install a missing prerequisite silently or consent to Microsoft terms.
!macro customInit
  ${If} ${Silent}
    Call StemCheckVcRuntime
    ${If} $stemVcReady != 1
      SetErrorLevel 1603
      Abort "Microsoft Visual C++ x64 ${STEM_VC_VERSION} required; rerun installer interactively."
    ${EndIf}
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom StemVcPrerequisitePage StemVcPrerequisiteLeave
!macroend
!endif ; BUILD_UNINSTALLER
!endif ; STEM_VC_PREREQUISITES_INCLUDED
