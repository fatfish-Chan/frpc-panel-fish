@echo off
chcp 65001 >nul
cd /d %~dp0
echo 大肥鱼开始装依赖和打包...
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

where npm >nul 2>nul
if not %errorlevel%==0 (
  echo 没装 Node.js，先去 https://nodejs.org 装一个 LTS 版本
  pause
  exit /b 1
)

call npm install --no-audit --no-fund
if not %errorlevel%==0 (
  echo 依赖装失败了，检查下网络
  pause
  exit /b 1
)

call npm run build
if %errorlevel%==0 (
  echo.
  echo 打好了，在 dist 文件夹里
  explorer dist
) else (
  echo 打包失败了，把上面的报错发给大肥鱼
)
pause
