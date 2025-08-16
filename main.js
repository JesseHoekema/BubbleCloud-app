const { app, BrowserWindow, Tray, Menu, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch'); 
const FormData = require('form-data');

let tray;
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');

let config = {};
try {
  if (fs.existsSync(CONFIG_FILE)) {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE));
  } else {
    const configDir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    config = {};
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  }
} catch (error) {
  console.error('Error initializing config:', error);
  config = {};
}

function saveConfig() {
  try {
    const configDir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (error) {
    console.error('Error saving config:', error);
  }
}

function showUrlPopup() {
  return new Promise(resolve => {
    const urlWindow = new BrowserWindow({
      width: 400,
      height: 200,
      alwaysOnTop: true,
      webPreferences: { 
        nodeIntegration: true, 
        contextIsolation: false,
        enableRemoteModule: true
      }
    });

    urlWindow.loadFile('url.html');

    urlWindow.on('closed', () => {
      try {
        if (fs.existsSync(CONFIG_FILE)) {
          config = JSON.parse(fs.readFileSync(CONFIG_FILE));
        }
      } catch (error) {
        console.error('Error reading config:', error);
      }
      resolve();
    });
  });
}

function showLoginPopup() {
  return new Promise((resolve) => {
    const loginWindow = new BrowserWindow({
      width: 500,
      height: 700,
      alwaysOnTop: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });

    const loginUrl = `${config.url}/login`;
    loginWindow.loadURL(loginUrl);

    loginWindow.webContents.on('did-navigate', async (event, url) => {
      if (url.endsWith('/dashboard')) {
        const cookies = await loginWindow.webContents.session.cookies.get({});
        const sessionCookie = cookies.find(c => c.name.includes('session') || c.name.includes('auth'));
        if (sessionCookie) {
          config.authToken = sessionCookie.value;
          saveConfig();
          loginWindow.close();
          resolve(true);
        }
      }
    });

    loginWindow.on('closed', () => resolve(false));
  });
}

async function uploadFiles() {
  if (!config.authToken) {
    const loggedIn = await showLoginPopup();
    if (!loggedIn) return;
  }

  const tempWindow = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
    width: 800,
    height: 400,
    title: "BubbleCloud - Upload Files"
  });

  const { canceled, filePaths } = await dialog.showOpenDialog(tempWindow, {
    properties: ['openFile', 'multiSelections']
  });

  tempWindow.close();

  if (canceled || filePaths.length === 0) return;

  try {
    for (const filePath of filePaths) {
      const form = new FormData();
      form.append('file', fs.createReadStream(filePath));

      const res = await fetch(`${config.url}/dashboard`, {
        method: 'POST',
        body: form,
        headers: { Cookie: `session=${config.authToken}` }
      });

      if (res.redirected && res.url.endsWith('/login')) {
        config.authToken = null;
        saveConfig();
        await showLoginPopup();
        return uploadFiles();
      }
    }

    dialog.showMessageBox({ type: 'info', message: 'File(s) uploaded successfully!' });
    updateTrayMenu();
  } catch (err) {
    dialog.showErrorBox('Upload Error', err.message);
  }
}

async function downloadFile(url, savePath, window) {
    return new Promise((resolve, reject) => {
        window.webContents.session.once('will-download', (event, item, webContents) => {
            item.setSavePath(savePath);
            
            item.on('updated', (event, state) => {
                if (state === 'progressing') {
                    const progress = (item.getReceivedBytes() / item.getTotalBytes()) * 100;
                    window.setProgressBar(progress / 100);
                }
            });
            
            item.once('done', (event, state) => {
                window.setProgressBar(-1);
                
                if (state === 'completed') {
                    dialog.showMessageBox(window, {
                        type: 'info',
                        title: 'Download Complete',
                        message: 'File downloaded successfully!',
                        detail: `Saved as: ${path.basename(savePath)}\nLocation: ${path.dirname(savePath)}`,
                        buttons: ['OK', 'Show in Finder']
                    }).then(result => {
                        if (result.response === 1) {
                            const { shell } = require('electron');
                            shell.showItemInFolder(savePath);
                        }
                    });
                    
                    resolve(savePath);
                } else {
                    dialog.showErrorBox('Download Failed', `Download failed: ${state}`);
                    reject(new Error(`Download failed: ${state}`));
                }
            });
        });
        
        window.webContents.downloadURL(url);
    });
}

async function downloadFiles() {
    if (!config.authToken) {
        const loggedIn = await showLoginPopup();
        if (!loggedIn) return;
    }
    
    const downloadWindow = new BrowserWindow({
        width: 800,
        height: 600,
        alwaysOnTop: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true }
    });

    await downloadWindow.webContents.session.cookies.set({
        url: config.url,
        name: 'session',
        value: config.authToken,
        domain: new URL(config.url).hostname,
        path: '/',
        secure: false, 
        httpOnly: false
    });
    
    downloadWindow.webContents.on('will-navigate', async (event, navigationUrl) => {
        if (!navigationUrl.startsWith(`${config.url}/app-api/get-files`)) {
            event.preventDefault();
            
            const urlPath = new URL(navigationUrl).pathname;
            const originalFilename = path.basename(urlPath);
            
            const result = await dialog.showSaveDialog(downloadWindow, {
                title: 'Save File As...',
                defaultPath: originalFilename,
                buttonLabel: 'Download',
                properties: ['createDirectory']
            });
            
            if (!result.canceled) {
                try {
                    await downloadFile(navigationUrl, result.filePath, downloadWindow);
                    downloadWindow.close();
                } catch (error) {
                    console.error('Download failed, keeping window open:', error);
                }
            }
        }
    });

    downloadWindow.loadURL(`${config.url}/app-api/get-files`);
}

function updateTrayMenu() {
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Upload Files', click: uploadFiles },
    { label: 'Download Files', click: downloadFiles },
    { type: 'separator' },
    {
      label: 'Change URL',
      click: async () => {
        await showUrlPopup();
        config.authToken = null;
        saveConfig();
        await showLoginPopup();
        updateTrayMenu();
      }
    },
    {
      label: config.authToken ? 'Authenticated ✓' : 'Not authenticated',
      enabled: false
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);

  tray.setContextMenu(contextMenu);
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock.hide();

  if (!config.url) await showUrlPopup();
  if (!config.authToken) await showLoginPopup();

  let iconPath;
  if (app.isPackaged) {
    iconPath = path.join(process.resourcesPath, 'assets', process.platform === 'win32' ? 'icon.ico' : 'iconTemplate@2x.png');
  } else {
    iconPath = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'iconTemplate@2x.png');
  }

  if (!fs.existsSync(iconPath)) {
    const fallbackPath = path.join(__dirname, 'iconTemplate@2x.png');
    if (fs.existsSync(fallbackPath)) {
      iconPath = fallbackPath;
    } else {
      console.error('Tray icon not found at:', iconPath);
      tray = new Tray(require('nativeImage').createEmpty());
    }
  }

  if (!tray) {
    tray = new Tray(iconPath);
  }
  
  updateTrayMenu();
  tray.setToolTip('BubbleCloud');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});