import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {db,newProject,touch,createMediaPath,mediaPath,type Track,type Clip,type MidiNote} from './store.js';

const app=Fastify({logger:true,bodyLimit:200*1024*1024});
await app.register(cors,{origin:true});
await app.register(websocket);
app.addContentTypeParser('application/octet-stream',{parseAs:'buffer'},(_req,body,done)=>done(null,body));

app.get('/health',async()=>({ok:true,service:'nnit-studio-api',version:'0.9.0'}));
app.get('/api/measurement/live',async()=>({status:'ok',source:'nnit-studio-v9',timestamp:new Date().toISOString()}));
app.get('/api/resource-pressure/status',async()=>({status:'normal',cpu:'available',memory:'available'}));
app.get('/api/projects',async()=>({items:db.projects}));
app.post('/api/projects',async(req:any,reply)=>{const p=newProject(String(req.body?.name||`Studio Project ${db.projects.length+1}`));reply.code(201);return p;});
app.patch('/api/projects/:id',async(req:any,reply)=>{const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});const b=req.body||{};for(const k of ['name','bpm','key','sampleRate','bitDepth'] as const)if(b[k]!==undefined)(p as any)[k]=b[k];if(b.master)p.master={...p.master,...b.master};if(b.production)p.production={...p.production,...b.production};if(Array.isArray(b.buses))p.buses=b.buses;touch(p);return p;});
app.put('/api/projects/:id',async(req:any,reply)=>{const p=db.replaceProject(req.params.id,req.body||{});if(!p)return reply.code(404).send({error:'Project not found'});return p;});
app.delete('/api/projects/:id',async(req:any,reply)=>{if(!db.project(req.params.id))return reply.code(404).send({error:'Project not found'});db.removeProject(req.params.id);return reply.code(204).send();});

app.get('/api/projects/:id/versions',async(req:any,reply)=>{if(!db.project(req.params.id))return reply.code(404).send({error:'Project not found'});return {items:db.versions.filter(v=>v.projectId===req.params.id).map(v=>({id:v.id,label:v.label,createdAt:v.createdAt}))};});
app.post('/api/projects/:id/versions',async(req:any,reply)=>{const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});reply.code(201);return db.saveVersion(p,String(req.body?.label||'Manual save'));});
app.post('/api/projects/:id/versions/:versionId/restore',async(req:any,reply)=>{const p=db.restoreVersion(req.params.id,req.params.versionId);if(!p)return reply.code(404).send({error:'Version not found'});return p;});

app.post('/api/projects/:id/tracks',async(req:any,reply)=>{const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});const kind=(['audio','instrument','drums'].includes(req.body?.kind)?req.body.kind:'audio') as Track['kind'];const t:Track={id:randomUUID(),name:String(req.body?.name||'New Track').slice(0,80),kind,gainDb:0,pan:0,mute:false,solo:false,armed:kind==='audio',bus:kind==='audio'?'vocals':kind==='drums'?'drums':'music',group:'',color:'#355178',inputDeviceId:'',monitoring:false,effects:{eq:true,compressor:false,gate:false,reverb:10,delay:0,eqLow:0,eqMid:0,eqHigh:0,compressorThreshold:-20,compressorRatio:4,gateThreshold:-45,deEsser:false,deEsserAmount:35,noiseCleanup:0,vocalPresence:0,pitchCorrection:false,pitchAmount:55,formant:0},clips:[],automation:{gain:[],pan:[]},midiNotes:[],drumPattern:Array(16).fill(false),pluginRack:[]};p.tracks.push(t);touch(p);reply.code(201);return t;});
app.patch('/api/projects/:id/tracks/:trackId',async(req:any,reply)=>{const p=db.project(req.params.id);const t=p?.tracks.find(x=>x.id===req.params.trackId);if(!p||!t)return reply.code(404).send({error:'Track not found'});const b=req.body||{};for(const k of ['name','gainDb','pan','mute','solo','armed','bus','group','color','inputDeviceId','monitoring'] as const)if(b[k]!==undefined)(t as any)[k]=b[k];if(b.effects)t.effects={...t.effects,...b.effects};if(b.automation)t.automation={gain:Array.isArray(b.automation.gain)?b.automation.gain:t.automation.gain,pan:Array.isArray(b.automation.pan)?b.automation.pan:t.automation.pan};if(Array.isArray(b.midiNotes))t.midiNotes=b.midiNotes as MidiNote[];if(Array.isArray(b.drumPattern))t.drumPattern=Array.from({length:16},(_,i)=>Boolean(b.drumPattern[i]));touch(p);return t;});
app.delete('/api/projects/:id/tracks/:trackId',async(req:any,reply)=>{const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});p.tracks=p.tracks.filter(t=>t.id!==req.params.trackId);touch(p);return reply.code(204).send();});

app.post('/api/media',async(req:any,reply)=>{const body=req.body as Buffer;if(!Buffer.isBuffer(body)||body.length===0)return reply.code(400).send({error:'Empty media body'});const id=randomUUID();fs.writeFileSync(createMediaPath(id),body);reply.code(201);return {id,size:body.length,mimeType:String(req.headers['x-media-type']||'application/octet-stream'),name:String(req.headers['x-media-name']||'audio')};});
app.get('/api/media/:id',async(req:any,reply)=>{const file=mediaPath(req.params.id);if(!fs.existsSync(file))return reply.code(404).send({error:'Media not found'});reply.type(String(req.query?.type||'application/octet-stream'));return reply.send(fs.createReadStream(file));});

app.post('/api/projects/:id/tracks/:trackId/clips',async(req:any,reply)=>{const p=db.project(req.params.id);const t=p?.tracks.find(x=>x.id===req.params.trackId);if(!p||!t)return reply.code(404).send({error:'Track not found'});const b=req.body||{};const c:Clip={id:randomUUID(),name:String(b.name||'Audio clip').slice(0,120),start:Math.max(0,Number(b.start||0)),duration:Math.max(0,Number(b.duration||0)),kind:b.kind==='import'?'import':'recording',createdAt:new Date().toISOString(),mediaId:b.mediaId?String(b.mediaId):undefined,mimeType:b.mimeType?String(b.mimeType):undefined,mediaOffset:Math.max(0,Number(b.mediaOffset||0)),fadeIn:Math.max(0,Number(b.fadeIn||0)),fadeOut:Math.max(0,Number(b.fadeOut||0))};t.clips.push(c);touch(p);reply.code(201);return c;});
app.patch('/api/projects/:id/tracks/:trackId/clips/:clipId',async(req:any,reply)=>{const p=db.project(req.params.id);const t=p?.tracks.find(x=>x.id===req.params.trackId);const c=t?.clips.find(x=>x.id===req.params.clipId);if(!p||!t||!c)return reply.code(404).send({error:'Clip not found'});const b=req.body||{};if(typeof b.name==='string')c.name=b.name.slice(0,120);for(const k of ['start','duration','mediaOffset','fadeIn','fadeOut'] as const)if(Number.isFinite(Number(b[k])))(c as any)[k]=Math.max(0,Number(b[k]));touch(p);return c;});
app.delete('/api/projects/:id/tracks/:trackId/clips/:clipId',async(req:any,reply)=>{const p=db.project(req.params.id);const t=p?.tracks.find(x=>x.id===req.params.trackId);if(!p||!t)return reply.code(404).send({error:'Clip not found'});t.clips=t.clips.filter(x=>x.id!==req.params.clipId);touch(p);return reply.code(204).send();});

app.post('/api/projects/:id/master/analyze',async(req:any,reply)=>{const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});return {target:p.master.targetLufs,ceiling:p.master.ceilingDbtp,status:'browser-offline-render-analysis-enabled'};});
app.post('/api/projects/:id/ai/jobs',async(req:any,reply)=>{const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});const job={id:randomUUID(),projectId:p.id,type:String(req.body?.type||'mix-assistant'),status:'queued',provider:String(req.body?.provider||process.env.NNIT_AI_PROVIDER||'adapter-required'),model:String(req.body?.model||process.env.NNIT_AI_MODEL||'not-configured'),trackId:req.body?.trackId?String(req.body.trackId):undefined,settings:req.body?.settings||{},createdAt:new Date().toISOString()};db.aiJobs.push(job);db.save();reply.code(202);return job;});
app.get('/api/ai/jobs',async()=>({items:db.aiJobs}));

app.get('/api/ai/providers',async()=>({
  configured:Boolean(process.env.NNIT_AI_PROVIDER),
  provider:process.env.NNIT_AI_PROVIDER||'Not configured',
  model:process.env.NNIT_AI_MODEL||'Not configured',
  endpointConfigured:Boolean(process.env.NNIT_AI_BASE_URL),
  capabilities:['stem-separation','vocal-isolation','denoise','vocal-tuning','mix-assistant','mastering-assistant']
}));
app.get('/api/mastering/presets',async()=>({items:[
  {id:'streaming-balanced',name:'Streaming Balanced',targetLufs:-14,ceilingDbtp:-1,stereoWidth:100,multibandAmount:25},
  {id:'loud-modern',name:'Loud Modern',targetLufs:-9,ceilingDbtp:-0.8,stereoWidth:110,multibandAmount:45},
  {id:'dynamic-acoustic',name:'Dynamic Acoustic',targetLufs:-16,ceilingDbtp:-1.2,stereoWidth:95,multibandAmount:15},
  {id:'broadcast',name:'Broadcast',targetLufs:-23,ceilingDbtp:-1,stereoWidth:100,multibandAmount:35}
]}));


function walkVst3(root:string,out:any[],depth=0){
  if(depth>8||!fs.existsSync(root))return;
  let entries:fs.Dirent[]=[];try{entries=fs.readdirSync(root,{withFileTypes:true})}catch{return}
  for(const e of entries){const full=path.join(root,e.name);if(e.name.toLowerCase().endsWith('.vst3')){out.push({id:Buffer.from(full).toString('base64url'),name:e.name.replace(/\.vst3$/i,''),path:full,format:'VST3',vendor:'Unknown',enabled:true,lastSeen:new Date().toISOString(),status:'available'});continue}if(e.isDirectory())walkVst3(full,out,depth+1)}
}
app.get('/api/native/status',async()=>({
  platform:process.platform,arch:process.arch,hostname:os.hostname(),cpus:os.cpus().length,totalMemory:os.totalmem(),freeMemory:os.freemem(),
  desktopBridge:'electron-ipc-ready',audioBackend:process.platform==='win32'?'WASAPI architecture / ASIO native-host adapter':'WebAudio/native adapter',
  nativeHostLoaded:false,vst3Hosting:'registry-and-host-bridge-ready',midi:'Web MIDI + Electron bridge',settings:db.nativeSettings
}));
app.get('/api/native/settings',async()=>db.nativeSettings);
app.patch('/api/native/settings',async(req:any)=>db.setNativeSettings(req.body||{}));
app.get('/api/plugins',async()=>({items:db.plugins}));
app.post('/api/plugins/scan',async(req:any)=>{const folders=Array.isArray(req.body?.folders)?req.body.folders:db.nativeSettings.pluginFolders;const found:any[]=[];for(const folder of folders)walkVst3(String(folder),found);const unique=Array.from(new Map(found.map(x=>[x.path.toLowerCase(),x])).values());db.setPlugins(unique as any);return {items:unique,folders,scannedAt:new Date().toISOString()};});
app.patch('/api/plugins/:id',async(req:any,reply)=>{const x=db.plugins.find((p:any)=>p.id===req.params.id);if(!x)return reply.code(404).send({error:'Plugin not found'});Object.assign(x,req.body||{});db.save();return x;});
app.get('/api/ai/local/status',async()=>{const url=db.nativeSettings.localAiUrl;try{const r=await fetch(url+'/health',{signal:AbortSignal.timeout(1200)});return {configured:true,url,reachable:r.ok,status:r.status}}catch{return {configured:Boolean(url),url,reachable:false,status:0}}});


async function safeJsonFetch(url:string,init?:RequestInit){
  try{
    const r=await fetch(url,{...init,signal:AbortSignal.timeout(2500)});
    const text=await r.text();
    let data:any={};try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
    return {ok:r.ok,status:r.status,data};
  }catch(error:any){return {ok:false,status:0,data:{error:String(error?.message||error)}}}
}

app.get('/api/native/host/status',async()=>{
  const r=await safeJsonFetch(db.nativeSettings.nativeHostUrl+'/health');
  return {url:db.nativeSettings.nativeHostUrl,reachable:r.ok,status:r.status,...(r.data||{})};
});
app.get('/api/native/devices',async()=>{
  const r=await safeJsonFetch(db.nativeSettings.nativeHostUrl+'/devices');
  return r.ok?r.data:{audio:[],midi:[],error:r.data?.error||'Native host offline'};
});
app.post('/api/native/host/configure',async(req:any)=>{
  const r=await safeJsonFetch(db.nativeSettings.nativeHostUrl+'/configure',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({...db.nativeSettings,...(req.body||{})})
  });
  return r.data;
});

app.post('/api/projects/:id/tracks/:trackId/plugins',async(req:any,reply)=>{
  const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
  const t=p.tracks.find((x:any)=>x.id===req.params.trackId);if(!t)return reply.code(404).send({error:'Track not found'});
  const plugin=db.plugins.find((x:any)=>x.id===String(req.body?.pluginId));if(!plugin)return reply.code(404).send({error:'Plugin not found'});
  const slot={id:randomUUID(),pluginId:plugin.id,name:plugin.name,enabled:true,preset:'Default',order:t.pluginRack.length};
  t.pluginRack.push(slot);touch(p);return slot;
});
app.patch('/api/projects/:id/tracks/:trackId/plugins/:slotId',async(req:any,reply)=>{
  const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
  const t=p.tracks.find((x:any)=>x.id===req.params.trackId);const slot=t?.pluginRack.find((x:any)=>x.id===req.params.slotId);
  if(!t||!slot)return reply.code(404).send({error:'Plugin slot not found'});
  Object.assign(slot,req.body||{});t.pluginRack.sort((a:any,b:any)=>a.order-b.order);touch(p);return slot;
});
app.delete('/api/projects/:id/tracks/:trackId/plugins/:slotId',async(req:any,reply)=>{
  const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
  const t=p.tracks.find((x:any)=>x.id===req.params.trackId);if(!t)return reply.code(404).send({error:'Track not found'});
  t.pluginRack=t.pluginRack.filter((x:any)=>x.id!==req.params.slotId);t.pluginRack.forEach((x:any,i:number)=>x.order=i);touch(p);return {ok:true};
});
app.post('/api/projects/:id/master/plugins',async(req:any,reply)=>{
  const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
  const plugin=db.plugins.find((x:any)=>x.id===String(req.body?.pluginId));if(!plugin)return reply.code(404).send({error:'Plugin not found'});
  const slot={id:randomUUID(),pluginId:plugin.id,name:plugin.name,enabled:true,preset:'Default',order:p.master.pluginRack.length};
  p.master.pluginRack.push(slot);touch(p);return slot;
});

app.post('/api/ai/jobs/:id/run-local',async(req:any,reply)=>{
  const job=db.aiJobs.find((x:any)=>x.id===req.params.id);if(!job)return reply.code(404).send({error:'AI job not found'});
  job.status='running';db.save();
  const r=await safeJsonFetch(db.nativeSettings.localAiUrl+'/jobs',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify(job)
  });
  if(!r.ok){job.status='worker-offline';job.error=r.data?.error||'Local worker unavailable';db.save();return reply.code(503).send(job);}
  Object.assign(job,{status:r.data?.status||'completed',result:r.data?.result,worker:r.data?.worker||'nnit-local-ai',finishedAt:new Date().toISOString()});
  db.save();return job;
});
app.get('/api/ai/local/capabilities',async()=>{
  const r=await safeJsonFetch(db.nativeSettings.localAiUrl+'/capabilities');
  return r.ok?r.data:{reachable:false,capabilities:[],error:r.data?.error||'Local worker offline'};
});

app.get('/api/cloud/status',async()=>({connected:false,provider:'NNIT Cloud adapter',localPersistence:true,persistentMedia:true,versionHistory:true,sync:'ready-for-provider'}));
app.get('/api/marketplace',async()=>({items:db.marketplace}));
app.get('/api/integrations',async()=>({nnitId:{configured:Boolean(process.env.NNIT_ID_URL)},nnitPay:{configured:Boolean(process.env.NNIT_PAY_URL)}}));
app.get('/ws/projects/:id',{websocket:true},(socket,req:any)=>{socket.send(JSON.stringify({type:'connected',projectId:req.params.id}));socket.on('message',(data:Buffer)=>socket.send(JSON.stringify({type:'ack',received:data.toString()})));});

const port=Number(process.env.PORT||4000);await app.listen({port,host:'0.0.0.0'});
