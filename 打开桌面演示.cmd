@echo off
chcp 65001 >nul
setlocal
set "STEM_DESKTOP_EXE=%~dp0frontend\release\win-unpacked\NoteWise Lab.exe"
if not exist "%STEM_DESKTOP_EXE%" set "STEM_DESKTOP_EXE=%~dp0NoteWise Lab.exe"
if not exist "%STEM_DESKTOP_EXE%" set "STEM_DESKTOP_EXE=%LOCALAPPDATA%\Programs\NoteWise Lab\NoteWise Lab.exe"
if not exist "%STEM_DESKTOP_EXE%" (
  echo 找不到 NoteWise Lab。请先运行安装包，或在 frontend 目录完成 pnpm desktop:dir 构建。
  pause
  exit /b 1
)
start "" "%STEM_DESKTOP_EXE%" --demo

