// Electron 主进程：起内置后端 + 开窗口 + 托盘
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const backend = require('./server');

const PORT = 8899;
const START_MIN = process.argv.includes('--minimized') || process.argv.includes('--hidden');

let win = null;
let tray = null;
let quitting = false;

function iconPath() {
  return path.join(__dirname, 'renderer', 'img', 'icon-192.png');
}

async function boot() {
  try {
    await backend.start(PORT);
  } catch (e) {
    // 端口被占：可能已经有一个实例在跑，直接连上去
    if (e.code !== 'EADDRINUSE') {
      dialog.showErrorBox('大肥鱼起不来了', String(e && e.message ? e.message : e));
      app.quit();
      return;
    }
  }
  createWindow();
  createTray();
}

function createWindow() {
  const { screen } = require('electron');
  const area = screen.getPrimaryDisplay().workAreaSize;
  const w = Math.min(1180, Math.max(960, area.width - 80));
  const h = Math.min(860, Math.max(640, area.height - 80));
  win = new BrowserWindow({
    width: w,
    height: h,
    minWidth: w,
    maxWidth: w,
    minHeight: h,
    maxHeight: h,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: '#0a1322',
    title: '大肥鱼 frpc 面板',
    icon: iconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.loadURL('http://127.0.0.1:' + PORT + '/');

  win.once('ready-to-show', () => {
    if (START_MIN) {
      win.minimize();
    } else {
      win.show();
    }
  });

  // 关窗口不退出，藏到托盘
  win.on('close', e => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
      if (tray) tray.displayBalloon && process.platform === 'win32' && tray.displayBalloon({
        title: '大肥鱼在后台待着',
        content: '点托盘图标能叫回来',
      });
    }
  });

  // 外链走系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

ipcMain.on('win:min', () => { if (win) win.minimize(); });
ipcMain.on('win:hide', () => { if (win) win.hide(); });
ipcMain.handle('win:toggle-max', () => false);
ipcMain.handle('win:is-max', () => !!(win && win.isMaximized()));

function createTray() {
  const img = nativeImage.createFromPath(iconPath());
  tray = new Tray(img.resize({ width: 16, height: 16 }));
  tray.setToolTip('大肥鱼 frpc 面板');
  const menu = Menu.buildFromTemplate([
    {
      label: '显示面板',
      click: () => { if (win) { win.show(); win.focus(); } },
    },
    {
      label: '最小化到托盘',
      click: () => { if (win) win.hide(); },
    },
    { type: 'separator' },
    {
      label: '打开 frp 目录',
      click: () => shell.openPath(backend.FRP_DIR),
    },
    {
      label: '打开数据目录',
      click: () => shell.openPath(backend.DATA),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => { quitting = true; app.quit(); },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (!win) return;
    if (win.isVisible()) { win.hide(); } else { win.show(); win.focus(); }
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });
  app.whenReady().then(boot);
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', e => { /* 留在托盘里 */ });
}
