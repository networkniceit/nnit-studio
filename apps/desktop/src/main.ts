import {app,BrowserWindow,ipcMain,dialog,shell} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const __dirname=path.dirname(fileURLToPath(import.meta.url));
let mainWindow:BrowserWindow|null=null;
function scanVst3(root:string,out:string[],depth=0){if(depth>8||!fs.existsSync(root))return;let list:fs.Dirent[]=[];try{list=fs.readdirSync(root,{withFileTypes:true})}catch{return}for(const e of list){const full=path.join(root,e.name);if(e.name.toLowerCase().endsWith('.vst3')){out.push(full);continue}if(e.isDirectory())scanVst3(full,out,depth+1)}}
function registerIpc(){
 ipcMain.handle('nnit:system-info',()=>({platform:process.platform,arch:process.arch,hostname:os.hostname(),cpus:os.cpus().map(x=>x.model),memory:os.totalmem(),electron:process.versions.electron,node:process.versions.node}));
 ipcMain.handle('nnit:scan-vst3',(_e,folders:string[])=>{const out:string[]=[];for(const f of folders||[])scanVst3(f,out);return Array.from(new Set(out));});
 ipcMain.handle('nnit:pick-plugin-folder',async()=>{const r=await dialog.showOpenDialog({properties:['openDirectory']});return r.canceled?'':r.filePaths[0]||''});
 ipcMain.handle('nnit:open-path',async(_e,p:string)=>{await shell.openPath(p);return true});
 ipcMain.handle('nnit:native-audio-status',()=>({wasapi:true,asioHostLoaded:false,asioAdapter:'compiled native host adapter required',recommendedBuffer:256,supportedSampleRates:[44100,48000,88200,96000],nativeHostUrl:'http://127.0.0.1:8766',localAiUrl:'http://127.0.0.1:8765'}));
}
function create(){mainWindow=new BrowserWindow({width:1600,height:1000,minWidth:1100,minHeight:720,backgroundColor:'#090d14',title:'NNIT Studio V39 GitHub + CI/CD Release Engineering',webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:false,preload:path.join(__dirname,'preload.js')}});mainWindow.loadURL(process.env.NNIT_STUDIO_WEB_URL||'http://localhost:5173');mainWindow.on('closed',()=>mainWindow=null)}
app.whenReady().then(()=>{registerIpc();create();app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)create()})});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()});
