import http from 'node:http';
import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const PORT=Number(process.env.NNIT_NATIVE_HOST_PORT||8766);
let config={driverMode:'WASAPI Shared',sampleRate:48000,bufferSize:256,exclusiveMode:false};
let engine={running:false,startedAt:null,xruns:0,cpuLoad:0,lastError:null};

const json=(res,status,data)=>{const body=JSON.stringify(data);res.writeHead(status,{'content-type':'application/json','content-length':Buffer.byteLength(body)});res.end(body)};
const body=async req=>new Promise((resolve,reject)=>{let x='';req.on('data',c=>x+=c);req.on('end',()=>{try{resolve(x?JSON.parse(x):{})}catch(e){reject(e)}});req.on('error',reject)});

function ps(script){
  return new Promise(resolve=>{
    if(process.platform!=='win32')return resolve([]);
    execFile('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',script],{windowsHide:true,timeout:5000,maxBuffer:1024*1024},(err,stdout)=>{
      if(err||!stdout.trim())return resolve([]);
      try{const v=JSON.parse(stdout);resolve(Array.isArray(v)?v:[v])}catch{resolve([])}
    });
  });
}

async function devices(){
  const audio=await ps(`Get-CimInstance Win32_SoundDevice | Select-Object Name,Manufacturer,Status,PNPDeviceID | ConvertTo-Json -Compress`);
  const endpoints=await ps(`Get-PnpDevice -Class AudioEndpoint -ErrorAction SilentlyContinue | Select-Object FriendlyName,Status,InstanceId | ConvertTo-Json -Compress`);
  return {audio,endpoints,midi:[],platform:process.platform,note:'MIDI hardware enumeration is completed in Electron/Web MIDI; ASIO driver enumeration requires the compiled ASIO adapter.'};
}

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url||'/',`http://${req.headers.host||'127.0.0.1'}`);
  if(req.method==='GET'&&url.pathname==='/health')return json(res,200,{ok:true,service:'nnit-native-host',version:'0.39.0',pid:process.pid,platform:process.platform,arch:process.arch,hostname:os.hostname(),audioHost:'service-boundary-ready',vst3HostLoaded:false,asioAdapterLoaded:false});
  if(req.method==='GET'&&url.pathname==='/devices')return json(res,200,await devices());
  if(req.method==='GET'&&url.pathname==='/config')return json(res,200,config);
  if(req.method==='POST'&&url.pathname==='/configure'){try{config={...config,...await body(req)};return json(res,200,{ok:true,config})}catch(e){return json(res,400,{error:String(e)})}}
  if(req.method==='POST'&&url.pathname==='/plugins/validate'){try{const b=await body(req);const p=String(b.path||'');return json(res,200,{path:p,exists:fs.existsSync(p),format:p.toLowerCase().endsWith('.vst3')?'VST3':'unknown',loadable:false,reason:'V9 validates and isolates plugin paths; Steinberg VST3 SDK native loader is not bundled.'})}catch(e){return json(res,400,{error:String(e)})}}
  if(req.method==='GET'&&url.pathname==='/engine/status')return json(res,200,{...engine,driverMode:config.driverMode,sampleRate:config.sampleRate,bufferSize:config.bufferSize,estimatedBufferLatencyMs:(Number(config.bufferSize)/Number(config.sampleRate))*1000,estimatedRoundTripMs:(Number(config.bufferSize)/Number(config.sampleRate))*2000,nativeDsp:false});
  if(req.method==='POST'&&url.pathname==='/engine/start'){engine={...engine,running:true,startedAt:new Date().toISOString(),lastError:null};return json(res,200,{ok:true,...engine,config})}
  if(req.method==='POST'&&url.pathname==='/engine/stop'){engine={...engine,running:false};return json(res,200,{ok:true,...engine})}
  return json(res,404,{error:'Not found'});
});
server.listen(PORT,'127.0.0.1',()=>console.log(`NNIT Native Host V9 listening on http://127.0.0.1:${PORT}`));

app.get('/audio/devices',async()=>({backend:'native-host-sandbox',inputs:[{id:'input-default',name:'System Default Input',channels:2,sampleRates:[44100,48000,96000]}],outputs:[{id:'output-default',name:'System Default Output',channels:2,sampleRates:[44100,48000,96000]}]}));
app.get('/audio/status',async()=>({status:'ready',backend:'native-host-sandbox',lowLatencyNativeDriver:false,recordingAdapter:true}));
app.get('/render/status',async()=>({status:'ready',offlineRenderAdapter:true,formats:['wav','flac','mp3'],realDspRender:false}));
app.post('/render/offline',async(req)=>({status:'adapter-ready',jobId:String(req.body?.jobId||''),rendered:false,progress:0,reason:'Native offline DSP renderer not linked yet'}));
app.post('/render/cancel',async(req)=>({status:'cancel-requested',jobId:String(req.body?.jobId||'')}));


