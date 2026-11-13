/**
 * Calci desktop — Electron main process.
 *
 * The UI is the Calci web app (built with `npm run build:native` in CALCI-W and
 * copied to ./app). It is served from a privileged custom protocol
 * (app://calci/…) so client-side routing, module workers and fetch behave
 * exactly like on the web, while everything works offline.
 */
const { app, BrowserWindow, Menu, protocol, net, shell, ipcMain, nativeTheme, globalShortcut, screen, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const APP_DIR = path.join(__dirname, '..', 'app');
const SCHEME = 'app';
const HOST = 'calci';
const ORIGIN = `${SCHEME}://${HOST}`;
const PUBLIC_SITE = 'https://calci-web.vercel.app';
const isMac = process.platform === 'darwin';

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

/* ---------------------------------------------------------------- window state */
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return { width: 1280, height: 820 };
  }
}
function saveState(win, extra = {}) {
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized(), ...extra }));
  } catch {
    /* ignore */
  }
}
function visible(bounds) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return bounds.x < a.x + a.width && bounds.x + bounds.width > a.x && bounds.y < a.y + a.height && bounds.y + bounds.height > a.y;
  });
}

/* ---------------------------------------------------------------- protocol */
function registerProtocol() {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) return new Response('Not found', { status: 404 });
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    let file = path.normalize(path.join(APP_DIR, rel));
    // never serve anything outside the app folder
    if (file !== APP_DIR && !file.startsWith(APP_DIR + path.sep)) return new Response('Forbidden', { status: 403 });
    if (!rel || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // SPA fallback for client-side routes like /graph or /stats
      if (path.extname(rel)) return new Response('Not found', { status: 404 });
      file = path.join(APP_DIR, 'index.html');
    }
    const res = await net.fetch(pathToFileURL(file).toString());
    if (!file.endsWith('.html')) return res;
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', CSP);
    return new Response(res.body, { status: res.status, headers });
  });
}

// 'unsafe-eval' is required by the expression compiler and math.js; Pyodide loads from jsDelivr on demand.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "frame-src https:",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

/* ---------------------------------------------------------------- windows */
let mainWindow = null;
let mini = false;

const MODES = [
  ['scientific', 'Scientific'],
  ['graph', 'Graphing'],
  ['3d', '3D Surfaces'],
  ['programmer', 'Programmer'],
  ['matrix', 'Matrix'],
  ['solver', 'Equation Solver'],
  ['calculus', 'Calculus'],
  ['stats', 'Statistics'],
  ['finance', 'Finance'],
  ['units', 'Converter'],
  ['code', 'Code & Library'],
  ['developers', 'API & Embed'],
];

function navigate(mode) {
  if (!mainWindow) return;
  mainWindow.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('calci:navigate', { detail: ${JSON.stringify(mode)} }))`).catch(() => {});
}

const titleBarColors = (dark) => (dark ? { color: '#0e1117', symbolColor: '#a7b0bf', height: 56 } : { color: '#fbfbfc', symbolColor: '#475164', height: 56 });

function createWindow() {
  const st = loadState();
  const dark = nativeTheme.shouldUseDarkColors;
  const opts = {
    width: st.width ?? 1280,
    height: st.height ?? 820,
    minWidth: 360,
    minHeight: 560,
    show: false,
    title: 'Calci',
    backgroundColor: dark ? '#0a0c11' : '#f5f6f8',
    icon: path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: !isMac,
    titleBarStyle: 'hidden',
    titleBarOverlay: isMac ? undefined : titleBarColors(dark),
    trafficLightPosition: { x: 14, y: 20 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  };
  if (st.x !== undefined && visible(st)) Object.assign(opts, { x: st.x, y: st.y });
  mainWindow = new BrowserWindow(opts);
  if (st.maximized) mainWindow.maximize();
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', () => !mini && saveState(mainWindow));
  mainWindow.on('closed', () => (mainWindow = null));

  // external links → default browser; nothing else may open new windows
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${ORIGIN}/`)) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });
  // sub-frames (e.g. the embed preview) may only show https pages or our own app
  mainWindow.webContents.on('will-frame-navigate', (e) => {
    if (e.isMainFrame) return;
    if (!/^https:\/\//.test(e.url) && !e.url.startsWith(`${ORIGIN}/`) && e.url !== 'about:blank') e.preventDefault();
  });
  const startMode = process.env.CALCI_START_MODE && MODES.some(([id]) => id === process.env.CALCI_START_MODE) ? process.env.CALCI_START_MODE : 'scientific';
  mainWindow.loadURL(`${ORIGIN}/${startMode}`);

  // Smoke-test hook: CALCI_CAPTURE=out.png electron .  → screenshot after load, then quit.
  if (process.env.CALCI_CAPTURE) {
    mainWindow.webContents.once('did-finish-load', () =>
      setTimeout(async () => {
        const img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(process.env.CALCI_CAPTURE, img.toPNG());
        app.quit();
      }, 3500),
    );
  }
}

function toggleMini() {
  if (!mainWindow) return;
  mini = !mini;
  if (mini) {
    saveState(mainWindow);
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    mainWindow.setMinimumSize(320, 520);
    mainWindow.setSize(380, 680, true);
    mainWindow.setAlwaysOnTop(true, 'floating');
    navigate('scientific');
  } else {
    const st = loadState();
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setMinimumSize(360, 560);
    mainWindow.setSize(st.width ?? 1280, st.height ?? 820, true);
  }
  buildMenu();
}

function buildMenu() {
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New window state reset', click: () => fs.rmSync(stateFile(), { force: true }) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Modes',
      submenu: MODES.map(([id, label], i) => ({ label, accelerator: i < 9 ? `CmdOrCtrl+${i + 1}` : undefined, click: () => navigate(id) })),
    },
    {
      label: 'View',
      submenu: [
        { label: 'Mini calculator', type: 'checkbox', checked: mini, accelerator: 'CmdOrCtrl+M', click: toggleMini },
        {
          label: 'Always on top',
          type: 'checkbox',
          checked: !!mainWindow?.isAlwaysOnTop(),
          accelerator: 'CmdOrCtrl+Shift+T',
          click: (item) => mainWindow?.setAlwaysOnTop(item.checked, 'floating'),
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Calci on the web', click: () => shell.openExternal(PUBLIC_SITE) },
        { label: 'API & embedding docs', click: () => shell.openExternal(`${PUBLIC_SITE}/developers`) },
        { label: 'Third-party licences', click: () => shell.openExternal(`${PUBLIC_SITE}/licenses.txt`) },
        { type: 'separator' },
        { label: `Version ${app.getVersion()}`, enabled: false },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------------------------------------------------------- IPC */
ipcMain.handle('calci:setAlwaysOnTop', (_e, on) => {
  mainWindow?.setAlwaysOnTop(!!on, 'floating');
  buildMenu();
  return mainWindow?.isAlwaysOnTop() ?? false;
});
ipcMain.handle('calci:isAlwaysOnTop', () => mainWindow?.isAlwaysOnTop() ?? false);
ipcMain.on('calci:titleBarTheme', (_e, theme) => {
  if (!mainWindow || isMac) return;
  try {
    mainWindow.setTitleBarOverlay(titleBarColors(theme === 'dark'));
    mainWindow.setBackgroundColor(theme === 'dark' ? '#0a0c11' : '#f5f6f8');
  } catch {
    /* overlay not supported on this platform */
  }
});
ipcMain.on('calci:openExternal', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});

/* ---------------------------------------------------------------- lifecycle */
app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(() => {
  app.setAppUserModelId('io.github.flamekaizen.calci.desktop');
  registerProtocol();
  // Deny every permission request (camera, mic, geolocation, notifications…) except clipboard writes.
  const allowed = new Set(['clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  buildMenu();
  createWindow();
  // Bring Calci to the front from anywhere
  globalShortcut.register('CommandOrControl+Alt+C', () => {
    if (!mainWindow) return createWindow();
    if (mainWindow.isFocused()) mainWindow.minimize();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => !isMac && app.quit());
