import {contextBridge,ipcRenderer} from 'electron';
contextBridge.exposeInMainWorld('nnitDesktop',{
 isDesktop:true,
 systemInfo:()=>ipcRenderer.invoke('nnit:system-info'),
 nativeAudioStatus:()=>ipcRenderer.invoke('nnit:native-audio-status'),
 scanVst3:(folders:string[])=>ipcRenderer.invoke('nnit:scan-vst3',folders),
 pickPluginFolder:()=>ipcRenderer.invoke('nnit:pick-plugin-folder'),
 openPath:(p:string)=>ipcRenderer.invoke('nnit:open-path',p)
});
