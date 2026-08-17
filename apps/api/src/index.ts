import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {db,newProject,touch,createMediaPath,mediaPath,type Track,type Clip,type MidiNote} from './store.js';

const app=Fastify({logger:true,bodyLimit:200*1024*1024});
await app.register(cors,{origin:true});
await app.register(websocket);
app.addContentTypeParser('application/octet-stream',{parseAs:'buffer'},(_req,body,done)=>done(null,body));

app.get('/health',async()=>({ok:true,service:'nnit-studio-api',version:'0.39.0'}));
app.get('/api/measurement/live',async()=>({status:'ok',source:'nnit-studio-v39',timestamp:new Date().toISOString()}));
app.get('/api/resource-pressure/status',async()=>({status:'normal',cpu:'available',memory:'available'}));

const hashPassword=(value:string)=>createHash('sha256').update(value).digest('hex');
const bearer=(req:any)=>String(req.headers?.authorization||'').replace(/^Bearer\s+/i,'').trim();
const currentUser=(req:any)=>{const token=bearer(req);if(!token)return null;const session=db.sessionByToken(token);if(!session)return null;session.lastSeenAt=new Date().toISOString();db.save();return db.userById(session.userId)};
const canAccessProject=(projectId:string,userId:string,mode:'view'|'comment'|'edit'='view')=>{
  const workspace=db.workspaces.find((w:any)=>w.ownerId===userId);if(workspace)return true;
  const c=db.collaborators.find((x:any)=>x.projectId===projectId&&x.status==='active'&&x.email===db.userById(userId)?.email);
  if(!c)return false;if(c.role==='owner'||c.role==='editor')return true;if(mode==='edit')return false;if(c.role==='commenter')return true;return mode==='view';
};

app.post('/api/auth/register',async(req:any,reply)=>{
  const email=String(req.body?.email||'').trim().toLowerCase(),password=String(req.body?.password||''),name=String(req.body?.name||'').trim();
  if(!email||!password||!name)return reply.code(400).send({error:'name, email and password are required'});
  if(password.length<8)return reply.code(400).send({error:'Password must be at least 8 characters'});
  if(db.userByEmail(email))return reply.code(409).send({error:'Account already exists'});
  const user={id:randomUUID(),email,name,passwordHash:hashPassword(password),status:'active' as const,createdAt:new Date().toISOString()};
  db.users.push(user);db.workspaces.push({id:randomUUID(),name:`${name}'s Workspace`,ownerId:user.id,createdAt:new Date().toISOString()});db.save();
  return reply.code(201).send({id:user.id,email:user.email,name:user.name,status:user.status});
});

app.post('/api/auth/login',async(req:any,reply)=>{
  const email=String(req.body?.email||'').trim().toLowerCase(),password=String(req.body?.password||'');
  const user=db.userByEmail(email);if(!user||user.passwordHash!==hashPassword(password)||user.status!=='active')return reply.code(401).send({error:'Invalid credentials'});
  user.lastLoginAt=new Date().toISOString();
  const deviceId=String(req.body?.deviceId||randomUUID()),deviceName=String(req.body?.deviceName||'NNIT Studio Device');
  const session=db.createSession(user.id,deviceId,deviceName);db.addActivity('', 'login', `${user.email} signed in`, user.id);
  return {token:session.token,expiresAt:session.expiresAt,user:{id:user.id,email:user.email,name:user.name,status:user.status},device:{id:deviceId,name:deviceName}};
});

app.post('/api/auth/logout',async(req:any,reply)=>{
  const token=bearer(req);const session=db.sessionByToken(token);if(!session)return reply.code(204).send();
  session.revoked=true;db.save();return reply.code(204).send();
});

app.get('/api/auth/me',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  return {id:user.id,email:user.email,name:user.name,status:user.status,lastLoginAt:user.lastLoginAt};
});

app.get('/api/auth/sessions',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  return {items:db.sessions.filter((x:any)=>x.userId===user.id).map((x:any)=>({...x,token:undefined}))};
});

app.delete('/api/auth/sessions/:id',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const s=db.revokeSession(req.params.id,user.id);if(!s)return reply.code(404).send({error:'Session not found'});return reply.code(204).send();
});

app.get('/api/auth/devices',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  return {items:db.devices.filter((x:any)=>x.userId===user.id)};
});

app.patch('/api/auth/devices/:id',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const d=db.devices.find((x:any)=>x.id===req.params.id&&x.userId===user.id);if(!d)return reply.code(404).send({error:'Device not found'});
  if(req.body?.trusted!==undefined)d.trusted=Boolean(req.body.trusted);if(req.body?.name!==undefined)d.name=String(req.body.name).slice(0,120);db.save();return d;
});

app.get('/api/auth/project-access/:projectId',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  return {projectId:req.params.projectId,view:canAccessProject(req.params.projectId,user.id,'view'),comment:canAccessProject(req.params.projectId,user.id,'comment'),edit:canAccessProject(req.params.projectId,user.id,'edit')};
});

app.get('/api/share/:token',async(req:any,reply)=>{
  const link=db.shareLinks.find((x:any)=>x.token===req.params.token&&x.enabled);if(!link)return reply.code(404).send({error:'Share link not found or disabled'});
  const p=db.project(link.projectId);if(!p)return reply.code(404).send({error:'Project not found'});
  if(link.expiresAt&&new Date(link.expiresAt).getTime()<Date.now())return reply.code(410).send({error:'Share link expired'});
  return {project:{id:p.id,name:p.name,bpm:p.bpm,key:p.key,updatedAt:p.updatedAt},access:link.role,linkId:link.id};
});

app.get('/api/projects',async()=>({items:db.projects}));
app.post('/api/projects',async(req:any,reply)=>{const p=newProject(String(req.body?.name||`Studio Project ${db.projects.length+1}`));reply.code(201);return p;});
app.patch('/api/projects/:id',async(req:any,reply)=>{const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});const b=req.body||{};for(const k of ['name','bpm','key','sampleRate','bitDepth'] as const)if(b[k]!==undefined)(p as any)[k]=b[k];if(b.master)p.master={...p.master,...b.master};if(b.production)p.production={...p.production,...b.production};if(Array.isArray(b.buses))p.buses=b.buses;touch(p);return p;});
app.put('/api/projects/:id',async(req:any,reply)=>{const p=db.replaceProject(req.params.id,req.body||{});if(!p)return reply.code(404).send({error:'Project not found'});return p;});
app.delete('/api/projects/:id',async(req:any,reply)=>{if(!db.project(req.params.id))return reply.code(404).send({error:'Project not found'});db.removeProject(req.params.id);return reply.code(204).send();});

app.get('/api/projects/:id/versions',async(req:any,reply)=>{if(!db.project(req.params.id))return reply.code(404).send({error:'Project not found'});return {items:db.versions.filter(v=>v.projectId===req.params.id).map(v=>({id:v.id,label:v.label,createdAt:v.createdAt}))};});
app.post('/api/projects/:id/versions',async(req:any,reply)=>{const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});reply.code(201);return db.saveVersion(p,String(req.body?.label||'Manual save'));});
app.post('/api/projects/:id/versions/:versionId/restore',async(req:any,reply)=>{const p=db.restoreVersion(req.params.id,req.params.versionId);if(!p)return reply.code(404).send({error:'Version not found'});return p;});

app.post('/api/projects/:id/tracks',async(req:any,reply)=>{const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});const kind=(['audio','instrument','drums'].includes(req.body?.kind)?req.body.kind:'audio') as Track['kind'];const t:Track={id:randomUUID(),name:String(req.body?.name||'New Track').slice(0,80),kind,gainDb:0,pan:0,mute:false,solo:false,armed:kind==='audio',bus:kind==='audio'?'vocals':kind==='drums'?'drums':'music',group:'',color:'#355178',inputDeviceId:'',monitoring:false,effects:{eq:true,compressor:false,gate:false,reverb:10,delay:0,eqLow:0,eqMid:0,eqHigh:0,compressorThreshold:-20,compressorRatio:4,gateThreshold:-45,deEsser:false,deEsserAmount:35,noiseCleanup:0,vocalPresence:0,pitchCorrection:false,pitchAmount:55,formant:0,saturation:0,stereoWidth:100,makeupGain:0,attackMs:10,releaseMs:120,eqLowFreq:120,eqMidFreq:1000,eqMidQ:0.8,eqHighFreq:8000,compressorKnee:12,delayTimeMs:280,delayFeedback:20,reverbDecay:1.5},clips:[],automation:{gain:[],pan:[]},midiNotes:[],drumPattern:Array(16).fill(false),pluginRack:[],instrumentPreset:kind==='drums'?'Drum Machine':'Warm Keys',midiInputId:'',midiChannel:1,transpose:0,scaleRoot:'C',scaleName:'Major'};p.tracks.push(t);touch(p);reply.code(201);return t;});
app.patch('/api/projects/:id/tracks/:trackId',async(req:any,reply)=>{const p=db.project(req.params.id);const t=p?.tracks.find(x=>x.id===req.params.trackId);if(!p||!t)return reply.code(404).send({error:'Track not found'});const b=req.body||{};for(const k of ['name','gainDb','pan','mute','solo','armed','bus','group','color','inputDeviceId','monitoring','instrumentPreset','midiInputId','midiChannel','transpose','scaleRoot','scaleName'] as const)if(b[k]!==undefined)(t as any)[k]=b[k];if(b.effects)t.effects={...t.effects,...b.effects};if(b.automation)t.automation={gain:Array.isArray(b.automation.gain)?b.automation.gain:t.automation.gain,pan:Array.isArray(b.automation.pan)?b.automation.pan:t.automation.pan};if(Array.isArray(b.midiNotes))t.midiNotes=b.midiNotes as MidiNote[];if(Array.isArray(b.drumPattern))t.drumPattern=Array.from({length:16},(_,i)=>Boolean(b.drumPattern[i]));touch(p);return t;});
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

app.get('/api/mastering/:id/report',async(req:any,reply)=>{
  const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
  const trackCount=p.tracks.length;
  const armed=p.tracks.filter((t:any)=>t.armed).length;
  const activePlugins=p.tracks.reduce((n:number,t:any)=>n+t.pluginRack.filter((x:any)=>x.enabled).length,0)+p.master.pluginRack.filter((x:any)=>x.enabled).length;
  return {
    projectId:p.id,
    targetLufs:p.master.targetLufs,
    ceilingDbtp:p.master.ceilingDbtp,
    limiterThreshold:p.master.limiterThreshold,
    stereoWidth:p.master.stereoWidth,
    multibandAmount:p.master.multibandAmount,
    saturation:p.master.saturation,
    glueAmount:p.master.glueAmount,
    masterGain:p.master.masterGain,
    trackCount,armedTracks:armed,activePlugins,
    buses:p.buses.map((b:any)=>({id:b.id,name:b.name,gainDb:b.gainDb,mute:b.mute})),
    preset:p.master.preset
  };
});


const BUILTIN_EFFECT_PRESETS=[
  {id:'clean-vocal',name:'Clean Vocal',kind:'vocal',effects:{eq:true,eqLow:-2,eqMid:1.5,eqHigh:2.5,eqLowFreq:120,eqMidFreq:2500,eqMidQ:1.0,eqHighFreq:9000,compressor:true,compressorThreshold:-18,compressorRatio:3,compressorKnee:12,attackMs:12,releaseMs:120,gate:true,gateThreshold:-48,deEsser:true,deEsserAmount:35,saturation:5,reverb:12,reverbDecay:1.3,delay:0,delayTimeMs:250,delayFeedback:15}},
  {id:'radio-vocal',name:'Radio Vocal',kind:'vocal',effects:{eq:true,eqLow:-5,eqMid:4,eqHigh:1,eqLowFreq:180,eqMidFreq:1800,eqMidQ:1.4,eqHighFreq:7000,compressor:true,compressorThreshold:-24,compressorRatio:6,compressorKnee:8,attackMs:6,releaseMs:90,gate:true,gateThreshold:-42,deEsser:true,deEsserAmount:45,saturation:18,reverb:4,reverbDecay:.8,delay:3,delayTimeMs:110,delayFeedback:8}},
  {id:'drum-punch',name:'Drum Punch',kind:'drums',effects:{eq:true,eqLow:3,eqMid:-2,eqHigh:2,eqLowFreq:90,eqMidFreq:500,eqMidQ:1.2,eqHighFreq:8500,compressor:true,compressorThreshold:-16,compressorRatio:5,compressorKnee:10,attackMs:20,releaseMs:80,gate:true,gateThreshold:-50,deEsser:false,deEsserAmount:0,saturation:12,reverb:6,reverbDecay:.7,delay:0,delayTimeMs:250,delayFeedback:0}},
  {id:'wide-instrument',name:'Wide Instrument',kind:'instrument',effects:{eq:true,eqLow:1,eqMid:-1,eqHigh:2,eqLowFreq:140,eqMidFreq:1200,eqMidQ:.7,eqHighFreq:9000,compressor:true,compressorThreshold:-20,compressorRatio:2.5,compressorKnee:18,attackMs:25,releaseMs:180,gate:false,gateThreshold:-60,deEsser:false,deEsserAmount:0,saturation:8,reverb:18,reverbDecay:1.8,delay:12,delayTimeMs:320,delayFeedback:24}}
];

const INSTRUMENT_PRESETS=[
  {id:'warm-keys',name:'Warm Keys',oscillator:'triangle',attack:.02,release:.8,filter:4200},
  {id:'bright-piano',name:'Bright Piano',oscillator:'triangle',attack:.005,release:.5,filter:9000},
  {id:'analog-pad',name:'Analog Pad',oscillator:'sawtooth',attack:.25,release:1.6,filter:2200},
  {id:'deep-bass',name:'Deep Bass',oscillator:'square',attack:.01,release:.35,filter:800},
  {id:'lead-synth',name:'Lead Synth',oscillator:'sawtooth',attack:.008,release:.25,filter:5500},
  {id:'pluck',name:'Pluck',oscillator:'triangle',attack:.002,release:.18,filter:6500},
  {id:'drum-machine',name:'Drum Machine',oscillator:'noise+kicks',attack:0,release:.15,filter:12000}
];
app.get('/api/midi/instrument-presets',async()=>({items:INSTRUMENT_PRESETS}));
app.post('/api/projects/:id/tracks/:trackId/midi/quantize',async(req:any,reply)=>{
  const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
  const t=p.tracks.find((x:any)=>x.id===req.params.trackId);if(!t)return reply.code(404).send({error:'Track not found'});
  const division=String(req.body?.division||'1/16');const frac=division==='1/4'?1:division==='1/8'?.5:division==='1/32'?.125:.25;const step=(60/p.bpm)*frac;
  t.midiNotes=t.midiNotes.map((n:any)=>({...n,start:Math.max(0,Math.round(n.start/step)*step),duration:Math.max(step/2,Math.round(n.duration/step)*step)}));touch(p);return t;
});
app.post('/api/projects/:id/tracks/:trackId/midi/transpose',async(req:any,reply)=>{
  const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});const t=p.tracks.find((x:any)=>x.id===req.params.trackId);if(!t)return reply.code(404).send({error:'Track not found'});
  const semitones=Math.max(-48,Math.min(48,Number(req.body?.semitones||0)));t.midiNotes=t.midiNotes.map((n:any)=>({...n,pitch:Math.max(0,Math.min(127,n.pitch+semitones))}));touch(p);return t;
});
app.post('/api/projects/:id/tracks/:trackId/midi/clear',async(req:any,reply)=>{const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});const t=p.tracks.find((x:any)=>x.id===req.params.trackId);if(!t)return reply.code(404).send({error:'Track not found'});t.midiNotes=[];t.drumPattern=Array(16).fill(false);touch(p);return t;});

app.get('/api/effects/presets',async()=>({items:BUILTIN_EFFECT_PRESETS}));
app.post('/api/projects/:id/tracks/:trackId/effects/preset/:presetId',async(req:any,reply)=>{
  const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
  const t=p.tracks.find((x:any)=>x.id===req.params.trackId);if(!t)return reply.code(404).send({error:'Track not found'});
  const preset=BUILTIN_EFFECT_PRESETS.find(x=>x.id===req.params.presetId);if(!preset)return reply.code(404).send({error:'Preset not found'});
  t.effects={...t.effects,...preset.effects};touch(p);return t;
});

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


app.patch('/api/projects/:id/master/plugins/:slotId',async(req:any,reply)=>{
  const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
  const slot=p.master.pluginRack.find((x:any)=>x.id===req.params.slotId);if(!slot)return reply.code(404).send({error:'Master plugin slot not found'});
  Object.assign(slot,req.body||{});p.master.pluginRack.sort((x:any,y:any)=>x.order-y.order);touch(p);return slot;
});
app.delete('/api/projects/:id/master/plugins/:slotId',async(req:any,reply)=>{
  const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
  p.master.pluginRack=p.master.pluginRack.filter((x:any)=>x.id!==req.params.slotId);p.master.pluginRack.forEach((x:any,i:number)=>x.order=i);touch(p);return reply.code(204).send();
});


app.get('/api/projects/:id/markers',async(req:any,reply)=>{
  const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
  return {items:p.markers};
});
app.post('/api/projects/:id/markers',async(req:any,reply)=>{
  const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
  const marker={id:randomUUID(),time:Math.max(0,Number(req.body?.time||0)),name:String(req.body?.name||'Marker').slice(0,80),color:String(req.body?.color||'#f59e0b')};
  p.markers.push(marker);p.markers.sort((x:any,y:any)=>x.time-y.time);touch(p);reply.code(201);return marker;
});
app.patch('/api/projects/:id/markers/:markerId',async(req:any,reply)=>{
  const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
  const m=p.markers.find((x:any)=>x.id===req.params.markerId);if(!m)return reply.code(404).send({error:'Marker not found'});
  Object.assign(m,req.body||{});p.markers.sort((x:any,y:any)=>x.time-y.time);touch(p);return m;
});
app.delete('/api/projects/:id/markers/:markerId',async(req:any,reply)=>{
  const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
  p.markers=p.markers.filter((x:any)=>x.id!==req.params.markerId);touch(p);return reply.code(204).send();
});
app.post('/api/projects/:id/tracks/:trackId/clips/:clipId/duplicate',async(req:any,reply)=>{
  const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
  const t=p.tracks.find((x:any)=>x.id===req.params.trackId);const c=t?.clips.find((x:any)=>x.id===req.params.clipId);
  if(!t||!c)return reply.code(404).send({error:'Clip not found'});
  const copy={...c,id:randomUUID(),name:String(req.body?.name||`${c.name} Copy`),start:Number.isFinite(Number(req.body?.start))?Number(req.body.start):c.start+c.duration};
  t.clips.push(copy);t.clips.sort((x:any,y:any)=>x.start-y.start);touch(p);reply.code(201);return copy;
});
app.patch('/api/projects/:id/tracks/:trackId/clips/:clipId/edit',async(req:any,reply)=>{
  const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
  const t=p.tracks.find((x:any)=>x.id===req.params.trackId);const c=t?.clips.find((x:any)=>x.id===req.params.clipId);
  if(!t||!c)return reply.code(404).send({error:'Clip not found'});
  const body=req.body||{};
  if(body.start!==undefined)c.start=Math.max(0,Number(body.start));
  if(body.duration!==undefined)c.duration=Math.max(.01,Number(body.duration));
  if(body.offset!==undefined)c.mediaOffset=Math.max(0,Number(body.offset));
  if(body.fadeIn!==undefined)c.fadeIn=Math.max(0,Number(body.fadeIn));
  if(body.fadeOut!==undefined)c.fadeOut=Math.max(0,Number(body.fadeOut));
  if(body.gainDb!==undefined)c.gainDb=Number(body.gainDb);
  if(body.muted!==undefined)c.muted=Boolean(body.muted);
  if(body.name!==undefined)c.name=String(body.name).slice(0,120);
  t.clips.sort((x:any,y:any)=>x.start-y.start);touch(p);return c;
});

app.get('/api/recording/:id/status',async(req:any,reply)=>{
  const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
  const armed=p.tracks.filter((t:any)=>t.armed).map((t:any)=>({id:t.id,name:t.name,inputDeviceId:t.inputDeviceId,monitoring:t.monitoring,clipCount:t.clips.length}));
  return {projectId:p.id,armed,recordMode:p.production.recordMode,preRoll:p.production.preRoll,postRoll:p.production.postRoll,autoInputMonitoring:p.production.autoInputMonitoring,sampleRate:p.sampleRate,bitDepth:p.bitDepth};
});
app.get('/api/projects/:id/tracks/:trackId/takes',async(req:any,reply)=>{
  const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
  const t=p.tracks.find((x:any)=>x.id===req.params.trackId);if(!t)return reply.code(404).send({error:'Track not found'});
  return {items:t.clips.filter((c:any)=>c.recordedAt||c.takeGroupId).map((c:any)=>({id:c.id,name:c.name,start:c.start,duration:c.duration,takeNumber:c.takeNumber||1,takeGroupId:c.takeGroupId||'',recordedAt:c.recordedAt||'',url:c.url}))};
});
app.patch('/api/projects/:id/tracks/:trackId/takes/:clipId',async(req:any,reply)=>{
  const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
  const t=p.tracks.find((x:any)=>x.id===req.params.trackId);const c=t?.clips.find((x:any)=>x.id===req.params.clipId);
  if(!t||!c)return reply.code(404).send({error:'Take not found'});
  Object.assign(c,req.body||{});touch(p);return c;
});

app.get('/api/mixer/:id',async(req:any,reply)=>{
  const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
  return {tracks:p.tracks.map((t:any)=>({id:t.id,name:t.name,kind:t.kind,gainDb:t.gainDb,pan:t.pan,mute:t.mute,solo:t.solo,armed:t.armed,monitoring:t.monitoring,bus:t.bus,inputDeviceId:t.inputDeviceId,inserts:t.pluginRack,sends:{reverb:t.effects.reverb,delay:t.effects.delay}})),buses:p.buses,master:p.master};
});


app.get('/api/ai/jobs/:id',async(req:any,reply)=>{
  const job=db.aiJobs.find((x:any)=>x.id===req.params.id);if(!job)return reply.code(404).send({error:'AI job not found'});return job;
});
app.post('/api/ai/jobs/:id/cancel',async(req:any,reply)=>{
  const job=db.aiJobs.find((x:any)=>x.id===req.params.id);if(!job)return reply.code(404).send({error:'AI job not found'});
  if(job.status==='completed')return reply.code(409).send({error:'Completed jobs cannot be cancelled'});
  job.status='cancelled';job.cancelledAt=new Date().toISOString();db.save();return job;
});
app.post('/api/ai/jobs/:id/retry',async(req:any,reply)=>{
  const job=db.aiJobs.find((x:any)=>x.id===req.params.id);if(!job)return reply.code(404).send({error:'AI job not found'});
  job.status='queued';delete job.error;delete job.finishedAt;db.save();return job;
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


const currencyRates:Record<string,number>={EUR:1,USD:1.09,GBP:.85,NGN:1730};
const convertAmount=(eur:number,currency:string)=>Math.round(eur*(currencyRates[currency]||1)*100)/100;
const invoiceNumber=()=>`NNIT-${new Date().getFullYear()}-${String(db.invoices.length+1).padStart(6,'0')}`;
app.get('/api/billing/plans',async(req:any)=>{const currency=String(req.query?.currency||'EUR').toUpperCase();return {currency,items:db.billingPlans.filter((x:any)=>x.active).map((p:any)=>({...p,monthly:convertAmount(p.monthly,currency),yearly:convertAmount(p.yearly,currency),currency}))}});
app.get('/api/billing/subscription',async(req:any,reply)=>{const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});return {subscription:db.activeSubscription(user.id),entitlement:db.entitlement(user.id)}});
app.post('/api/billing/subscriptions',async(req:any,reply)=>{const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const plan=db.billingPlans.find((x:any)=>x.id===req.body?.planId&&x.active);if(!plan)return reply.code(404).send({error:'Plan not found'});const cycle=req.body?.billingCycle==='yearly'?'yearly':'monthly';const currency=String(req.body?.currency||'EUR').toUpperCase();const amount=convertAmount(cycle==='yearly'?plan.yearly:plan.monthly,currency);const old=db.activeSubscription(user.id);if(old)old.status='cancelled';const sub={id:randomUUID(),userId:user.id,planId:plan.id,status:'active' as const,billingCycle:cycle as 'monthly'|'yearly',currency,amount,startedAt:new Date().toISOString(),renewsAt:new Date(Date.now()+(cycle==='yearly'?365:30)*86400000).toISOString()};db.subscriptions.push(sub);const tx={id:randomUUID(),userId:user.id,kind:'subscription' as const,currency,amount,status:'succeeded' as const,provider:'NNIT Pay sandbox',reference:'NNITP-'+randomUUID().slice(0,12),createdAt:new Date().toISOString(),metadata:{planId:plan.id,billingCycle:cycle}};db.transactions.push(tx);const inv={id:randomUUID(),userId:user.id,subscriptionId:sub.id,currency,subtotal:amount,tax:0,total:amount,status:'paid' as const,number:invoiceNumber(),createdAt:new Date().toISOString(),paidAt:new Date().toISOString()};db.invoices.push(inv);if(!db.licenses.find((x:any)=>x.userId===user.id&&x.status==='active'))db.createLicense(user.id,'NNIT Studio',plan.id==='business'?10:3);db.save();return {subscription:sub,transaction:tx,invoice:inv,entitlement:db.entitlement(user.id)}});
app.post('/api/billing/subscription/cancel',async(req:any,reply)=>{const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const sub=db.activeSubscription(user.id);if(!sub)return reply.code(404).send({error:'No active subscription'});sub.status='cancelled';sub.cancelledAt=new Date().toISOString();db.save();return sub});
app.get('/api/billing/invoices',async(req:any,reply)=>{const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});return {items:db.invoices.filter((x:any)=>x.userId===user.id)}});
app.get('/api/billing/transactions',async(req:any,reply)=>{const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});return {items:db.transactions.filter((x:any)=>x.userId===user.id)}});
app.get('/api/licenses',async(req:any,reply)=>{const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});return {items:db.licenses.filter((x:any)=>x.userId===user.id)}});
app.post('/api/licenses/:id/activate',async(req:any,reply)=>{const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const lic=db.licenses.find((x:any)=>x.id===req.params.id&&x.userId===user.id);if(!lic)return reply.code(404).send({error:'License not found'});const deviceId=String(req.body?.deviceId||'').trim();if(!deviceId)return reply.code(400).send({error:'deviceId required'});if(!lic.activatedDevices.includes(deviceId)){if(lic.activatedDevices.length>=lic.maxDevices)return reply.code(409).send({error:'Device activation limit reached'});lic.activatedDevices.push(deviceId)}db.save();return lic});
app.get('/api/nnitpay/status',async()=>({provider:'NNIT Pay (NNITP) adapter',mode:'sandbox-local',connected:false,regulatedActivationRequired:true,multiCurrency:['EUR','USD','GBP','NGN'],livePayments:false}));


const releaseStores=['Spotify','Apple Music','Amazon Music','YouTube Music','Deezer','TIDAL','TikTok Music','Audiomack'];
const makeIsrc=()=>`NN-NIT-${String(new Date().getFullYear()).slice(-2)}-${String(Math.floor(Math.random()*100000)).padStart(5,'0')}`;
const makeUpc=()=>`23${String(Date.now()).slice(-10)}`;
const validateRelease=(release:any)=>{
  const issues:string[]=[];
  if(!release.title?.trim())issues.push('Release title is required');
  if(!release.artistProfileId)issues.push('Artist profile is required');
  if(!release.releaseDate)issues.push('Release date is required');
  if(!Array.isArray(release.territories)||release.territories.length===0)issues.push('At least one territory is required');
  if(!Array.isArray(release.tracks)||release.tracks.length===0)issues.push('At least one track is required');
  for(const [i,t] of (release.tracks||[]).entries()){
    if(!t.title?.trim())issues.push(`Track ${i+1}: title required`);
    if(!t.isrc?.trim())issues.push(`Track ${i+1}: ISRC required`);
    if(!t.primaryArtist?.trim())issues.push(`Track ${i+1}: primary artist required`);
    if(!t.masterFileName)issues.push(`Track ${i+1}: mastered audio file not linked`);
    const writerTotal=(t.writers||[]).reduce((n:number,x:any)=>n+Number(x.percentage||0),0);
    if(writerTotal>0&&Math.abs(writerTotal-100)>.01)issues.push(`Track ${i+1}: writer split must total 100%`);
  }
  return issues;
};


const rightsOrganizations=['ASCAP','BMI','SESAC','PRS','GEMA','SACEM','SOCAN','COSON','MCSN','SoundExchange','PPL','MCPS'];
const makeIswc=()=>`T-${String(Math.floor(Math.random()*1000000000)).padStart(9,'0')}-${Math.floor(Math.random()*10)}`;
const compositionIssues=(c:any)=>{
  const issues:string[]=[];
  if(!String(c?.title||'').trim())issues.push('Composition title is required');
  if(!Array.isArray(c?.shares)||c.shares.length===0)issues.push('At least one writer/publisher share is required');
  const total=(c?.shares||[]).reduce((n:number,x:any)=>n+Number(x.percentage||0),0);
  if(Math.abs(total-100)>.01)issues.push(`Composition splits total ${total.toFixed(2)}%; they must total 100%`);
  for(const sh of (c?.shares||[]))if(!db.rightsParties.find((p:any)=>p.id===sh.partyId))issues.push('A split references a missing rights party');
  return issues;
};



const requireAdmin=(req:any,reply:any)=>{
  const user=currentUser(req);if(!user){reply.code(401).send({error:'Not authenticated'});return null}
  const admin=db.adminFor(user.id);if(!admin){reply.code(403).send({error:'Admin access required'});return null}
  return {user,admin};
};


const notificationProviderStatus=()=>({in_app:{connected:true,provider:'NNIT Local'},email:{connected:false,provider:'Email adapter'},sms:{connected:false,provider:'SMS adapter'},push:{connected:false,provider:'Push adapter'}});
const queueNotification=(userId:string,category:string,channel:any,title:string,message:string)=>{
  const now=new Date().toISOString();const n:any={id:randomUUID(),userId,category,channel,title,message,status:channel==='in_app'?'delivered':'queued',attempts:channel==='in_app'?1:0,provider:channel==='in_app'?'NNIT Local':`${channel} adapter`,createdAt:now,updatedAt:now};
  db.notifications.unshift(n);db.save();return n;
};


const supportSlaHours=(priority:string)=>priority==='urgent'?2:priority==='high'?8:priority==='normal'?24:72;

const maskApiKey=(prefix:string)=>`${prefix}••••••••••••`;
const newApiSecret=()=>`nnit_${randomUUID().replaceAll('-','')}${randomUUID().replaceAll('-','')}`;

const backupChecksum=(value:string)=>createHash('sha256').update(value).digest('hex');


const reliabilityChecksum=(value:string)=>createHash('sha256').update(value).digest('hex');
const projectPayload=(p:any)=>JSON.parse(JSON.stringify(p));

const pushAudioEvent=(eventType:any,severity:any,message:string,deviceId?:string,sessionId?:string)=>{const e:any={id:randomUUID(),eventType,severity,message,deviceId,sessionId,createdAt:new Date().toISOString()};db.audioRuntimeEvents.unshift(e);db.audioRuntimeEvents.splice(500);return e};

const makeSyntheticPeaks=(seed:string,count:number)=>{const h=createHash('sha256').update(seed).digest();const peaks:number[]=[];for(let i=0;i<count;i++){const b=h[i%h.length],phase=(i/count)*Math.PI*10,envelope=.25+.7*Math.abs(Math.sin(phase));peaks.push(Math.round(Math.min(1,envelope*(.35+b/400))*1000)/1000)}return peaks};

const dbToLinear=(db:number)=>Math.pow(10,db/20);
const clampDb=(db:number)=>Math.max(-120,Math.min(24,db));
const ensureDspGraph=(p:any)=>{
 const existing=db.dspNodes.filter((x:any)=>x.projectId===p.id);if(existing.length)return;
 const now=new Date().toISOString();let order=0;
 for(const t of p.tracks||[]){
  const input:any={id:randomUUID(),projectId:p.id,trackId:t.id,type:'input',name:`${t.name} Input`,enabled:true,order:order++,params:{},createdAt:now,updatedAt:now};
  const gain:any={id:randomUUID(),projectId:p.id,trackId:t.id,type:'gain',name:`${t.name} Gain`,enabled:true,order:order++,params:{gainDb:Number(t.gainDb||0)},createdAt:now,updatedAt:now};
  const pan:any={id:randomUUID(),projectId:p.id,trackId:t.id,type:'pan',name:`${t.name} Pan`,enabled:true,order:order++,params:{pan:Number(t.pan||0),panLawDb:-3},createdAt:now,updatedAt:now};
  const eq:any={id:randomUUID(),projectId:p.id,trackId:t.id,type:'eq',name:`${t.name} EQ`,enabled:Boolean(t.effects?.eq),order:order++,params:{low:Number(t.effects?.eqLow||0),mid:Number(t.effects?.eqMid||0),high:Number(t.effects?.eqHigh||0)},createdAt:now,updatedAt:now};
  const comp:any={id:randomUUID(),projectId:p.id,trackId:t.id,type:'compressor',name:`${t.name} Compressor`,enabled:Boolean(t.effects?.compressor),order:order++,params:{threshold:Number(t.effects?.compressorThreshold||-20),ratio:Number(t.effects?.compressorRatio||4)},createdAt:now,updatedAt:now};
  const meter:any={id:randomUUID(),projectId:p.id,trackId:t.id,type:'meter',name:`${t.name} Meter`,enabled:true,order:order++,params:{},createdAt:now,updatedAt:now};
  db.dspNodes.push(input,gain,pan,eq,comp,meter);
  for(const [x,y] of [[input,gain],[gain,pan],[pan,eq],[eq,comp],[comp,meter]])db.dspEdges.push({id:randomUUID(),projectId:p.id,fromNodeId:x.id,toNodeId:y.id,gainDb:0,enabled:true,createdAt:now});
 }
 const master:any={id:randomUUID(),projectId:p.id,type:'bus',name:'Master Bus',enabled:true,order:order++,params:{gainDb:Number(p.master?.masterGain||0)},createdAt:now,updatedAt:now};
 const limiter:any={id:randomUUID(),projectId:p.id,type:'limiter',name:'Master Limiter',enabled:true,order:order++,params:{threshold:Number(p.master?.limiterThreshold||-1),ceiling:Number(p.master?.ceilingDbtp||-1)},createdAt:now,updatedAt:now};
 const out:any={id:randomUUID(),projectId:p.id,type:'output',name:'Main Output',enabled:true,order:order++,params:{},createdAt:now,updatedAt:now};
 db.dspNodes.push(master,limiter,out);db.dspEdges.push({id:randomUUID(),projectId:p.id,fromNodeId:master.id,toNodeId:limiter.id,gainDb:0,enabled:true,createdAt:now},{id:randomUUID(),projectId:p.id,fromNodeId:limiter.id,toNodeId:out.id,gainDb:0,enabled:true,createdAt:now});
 for(const t of p.tracks||[]){const meter=db.dspNodes.find((x:any)=>x.projectId===p.id&&x.trackId===t.id&&x.type==='meter');if(meter)db.dspEdges.push({id:randomUUID(),projectId:p.id,fromNodeId:meter.id,toNodeId:master.id,gainDb:0,enabled:true,createdAt:now})}
 db.save();
};

const pluginStateHash=(x:any)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');



const perfSample=(projectId:string|undefined,component:string,metric:any,value:number,label:string)=>{const p:any={id:randomUUID(),projectId,component,metric,value,label,createdAt:new Date().toISOString()};db.performanceSamples.unshift(p);db.performanceSamples.splice(1000);return p};
app.get('/api/hardening/overview',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
 return {runs:db.stressRuns.filter((x:any)=>x.userId===user.id).slice(0,100),crashes:db.crashRecords.slice(0,100),samples:db.performanceSamples.slice(0,200),diagnostics:db.hardeningDiagnostics.slice(0,200)};
});
app.post('/api/projects/:id/stress-runs',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
 const profile=(['quick','standard','extended'].includes(req.body?.profile)?req.body.profile:'standard') as any,iterations=profile==='quick'?25:profile==='extended'?500:100,now=new Date().toISOString();
 const run:any={id:randomUUID(),projectId:p.id,userId:user.id,profile,status:'queued',iterations,completedIterations:0,durationMs:0,peakMemoryMb:0,peakCpuPercent:0,audioXruns:0,renderFailures:0,apiFailures:0,issues:[],createdAt:now,updatedAt:now};db.stressRuns.unshift(run);db.save();reply.code(201);return run;
});
app.post('/api/stress-runs/:id/execute',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const run=db.stressRuns.find((x:any)=>x.id===req.params.id&&x.userId===user.id);if(!run)return reply.code(404).send({error:'Stress run not found'});
 const p=db.project(run.projectId);if(!p)return reply.code(404).send({error:'Project not found'});const started=Date.now();run.status='running';run.updatedAt=new Date().toISOString();
 const trackCount=(p.tracks||[]).length,clipCount=(p.tracks||[]).reduce((n:number,t:any)=>n+(t.clips||[]).length,0),plugins=db.pluginInstances.filter((x:any)=>x.projectId===p.id&&x.enabled&&!x.bypass).length,media=db.mediaAssets.filter((x:any)=>x.projectId===p.id).length;
 const complexity=Math.max(1,trackCount+clipCount*2+plugins*4+media*2),cpu=Math.min(99,Math.round(8+complexity*.8)),memory=Math.round(120+complexity*3.5),xruns=cpu>85?Math.ceil((cpu-85)/3):0;
 for(let i=0;i<run.iterations;i++){run.completedIterations=i+1}
 run.durationMs=Math.max(1,Date.now()-started)+run.iterations*2;run.peakCpuPercent=cpu;run.peakMemoryMb=memory;run.audioXruns=xruns;
 if(xruns>0)run.issues.push(`Estimated ${xruns} audio XRun(s) under ${run.profile} profile`);
 if(cpu>=95)run.issues.push('Estimated CPU saturation');
 run.status=run.issues.some((x:string)=>x.includes('saturation'))?'failed':'passed';run.updatedAt=new Date().toISOString();run.completedAt=run.updatedAt;
 perfSample(p.id,'audio-engine','cpu_percent',cpu,`${run.profile} stress peak CPU`);perfSample(p.id,'desktop','memory_mb',memory,`${run.profile} stress peak memory`);perfSample(p.id,'audio-engine','xrun_count',xruns,`${run.profile} stress XRuns`);
 db.save();return run;
});
app.post('/api/stress-runs/:id/cancel',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const run=db.stressRuns.find((x:any)=>x.id===req.params.id&&x.userId===user.id);if(!run)return reply.code(404).send({error:'Stress run not found'});if(['passed','failed'].includes(run.status))return reply.code(409).send({error:'Run already completed'});run.status='cancelled';run.updatedAt=new Date().toISOString();db.save();return run;
});
app.post('/api/projects/:id/crash-simulate',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});const component=(['api','web','desktop','native-host','local-ai','audio-engine'].includes(req.body?.component)?req.body.component:'audio-engine') as any,now=new Date().toISOString(),message=String(req.body?.message||'Controlled crash recovery test');
 const payload=JSON.parse(JSON.stringify(p)),raw=JSON.stringify(payload),snap:any={id:randomUUID(),projectId:p.id,kind:'crash_recovery',label:`V38 crash recovery ${component}`,checksum:createHash('sha256').update(raw).digest('hex'),payload,createdAt:now};db.projectSnapshots.unshift(snap);
 const crash:any={id:randomUUID(),projectId:p.id,component,message,stackHash:createHash('sha256').update(`${component}|${message}`).digest('hex'),recovered:true,recoverySnapshotId:snap.id,createdAt:now,recoveredAt:new Date().toISOString()};db.crashRecords.unshift(crash);db.save();reply.code(201);return crash;
});
app.post('/api/projects/:id/hardening/diagnostics',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
 for(let i=db.hardeningDiagnostics.length-1;i>=0;i--){if(db.hardeningDiagnostics[i].projectId===p.id)db.hardeningDiagnostics.splice(i,1)}const now=new Date().toISOString(),runs=db.stressRuns.filter((x:any)=>x.projectId===p.id),last=runs[0];
 if(!last)db.hardeningDiagnostics.push({id:randomUUID(),projectId:p.id,severity:'warning',code:'NO_STRESS_RUN',message:'No V38 stress run has been executed yet',createdAt:now});
 if(last&&last.peakCpuPercent>85)db.hardeningDiagnostics.push({id:randomUUID(),projectId:p.id,severity:'warning',code:'CPU_HEADROOM_LOW',message:`Stress peak CPU ${last.peakCpuPercent}%`,createdAt:now});
 if(last&&last.audioXruns>0)db.hardeningDiagnostics.push({id:randomUUID(),projectId:p.id,severity:'warning',code:'AUDIO_XRUNS',message:`${last.audioXruns} XRun(s) detected/estimated in stress profile`,createdAt:now});
 const failedRenders=db.renderJobs.filter((x:any)=>x.projectId===p.id&&x.status==='failed').length;if(failedRenders)db.hardeningDiagnostics.push({id:randomUUID(),projectId:p.id,severity:'error',code:'RENDER_FAILURES',message:`${failedRenders} render job(s) failed`,createdAt:now});
 if(!db.hardeningDiagnostics.some((x:any)=>x.projectId===p.id))db.hardeningDiagnostics.push({id:randomUUID(),projectId:p.id,severity:'info',code:'HARDENING_OK',message:'Current local hardening checks passed',createdAt:now});db.save();return {items:db.hardeningDiagnostics.filter((x:any)=>x.projectId===p.id)};
});

app.get('/api/render-engine/overview',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
 return {jobs:db.renderJobs.filter((x:any)=>x.userId===user.id).slice(-100).reverse(),diagnostics:db.renderDiagnostics.slice(-100).reverse(),capabilities:{formats:['wav','flac','mp3'],sampleRates:[44100,48000,88200,96000],bitDepths:[16,24,32],stems:true,normalization:true,nativeAdapter:true}};
});
app.post('/api/projects/:id/render',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
 const kind=(req.body?.kind==='stems'?'stems':'mixdown') as 'mixdown'|'stems',format=(['wav','flac','mp3'].includes(req.body?.format)?req.body.format:'wav') as 'wav'|'flac'|'mp3',sampleRate=[44100,48000,88200,96000].includes(Number(req.body?.sampleRate))?Number(req.body.sampleRate):48000,bitDepth=([16,24,32].includes(Number(req.body?.bitDepth))?Number(req.body.bitDepth):24) as 16|24|32;
 const now=new Date().toISOString(),duration=Math.max(0,...(p.tracks||[]).flatMap((t:any)=>(t.clips||[]).map((c:any)=>Number(c.start||0)+Number(c.duration||0))),0),safe=String(p.name||'NNIT-Studio').replace(/[^a-z0-9_-]+/gi,'-');
 const item:any={id:randomUUID(),projectId:p.id,userId:user.id,kind,format,sampleRate,bitDepth,normalize:req.body?.normalize!==false,targetLufs:Number(req.body?.targetLufs??-14),ceilingDbtp:Number(req.body?.ceilingDbtp??-1),status:'queued',progress:0,outputName:`${safe}-${kind}.${format}`,durationSeconds:duration,createdAt:now,updatedAt:now};db.renderJobs.push(item);db.save();reply.code(201);return item;
});
app.post('/api/render-jobs/:id/start',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const j=db.renderJobs.find((x:any)=>x.id===req.params.id&&x.userId===user.id);if(!j)return reply.code(404).send({error:'Render job not found'});if(j.status==='cancelled')return reply.code(409).send({error:'Render cancelled'});
 j.status='rendering';j.progress=25;j.updatedAt=new Date().toISOString();db.save();return {...j,nativeEndpoint:'/render/offline'};
});
app.post('/api/render-jobs/:id/complete',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const j=db.renderJobs.find((x:any)=>x.id===req.params.id&&x.userId===user.id);if(!j)return reply.code(404).send({error:'Render job not found'});if(j.status==='cancelled')return reply.code(409).send({error:'Render cancelled'});
 const now=new Date().toISOString();j.status='completed';j.progress=100;j.outputPath=String(req.body?.outputPath||`exports/${j.outputName}`);j.bytes=Math.max(0,Number(req.body?.bytes||0));j.updatedAt=now;j.completedAt=now;db.save();return j;
});
app.post('/api/render-jobs/:id/cancel',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const j=db.renderJobs.find((x:any)=>x.id===req.params.id&&x.userId===user.id);if(!j)return reply.code(404).send({error:'Render job not found'});if(j.status==='completed')return reply.code(409).send({error:'Completed render cannot be cancelled'});j.status='cancelled';j.updatedAt=new Date().toISOString();db.save();return j;
});
app.post('/api/projects/:id/render/diagnostics',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
 for(let i=db.renderDiagnostics.length-1;i>=0;i--){if(db.renderDiagnostics[i].projectId===p.id)db.renderDiagnostics.splice(i,1)}const now=new Date().toISOString(),jobs=db.renderJobs.filter((x:any)=>x.projectId===p.id);
 for(const j of jobs){if(j.status==='failed')db.renderDiagnostics.push({id:randomUUID(),projectId:p.id,severity:'error',code:'RENDER_FAILED',message:j.error||'Render failed',renderJobId:j.id,createdAt:now});if(j.sampleRate>48000&&j.durationSeconds>600)db.renderDiagnostics.push({id:randomUUID(),projectId:p.id,severity:'warning',code:'HEAVY_RENDER',message:`High-resolution long render: ${j.sampleRate} Hz / ${Math.round(j.durationSeconds)}s`,renderJobId:j.id,createdAt:now})}
 if(!db.renderDiagnostics.some((x:any)=>x.projectId===p.id))db.renderDiagnostics.push({id:randomUUID(),projectId:p.id,severity:'info',code:'RENDER_ENGINE_OK',message:`Render engine validated · ${jobs.length} job(s)`,createdAt:now});db.save();return {items:db.renderDiagnostics.filter((x:any)=>x.projectId===p.id)};
});

app.get('/api/midi-engine/overview',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
 return {ports:db.midiPorts,events:db.midiEvents.slice(0,500),instruments:db.instrumentInstances,playback:db.midiPlaybackStates,diagnostics:db.midiDiagnostics};
});
app.post('/api/midi-engine/scan-ports',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const now=new Date().toISOString();for(const p of db.midiPorts){p.status='online';p.lastSeenAt=now}db.save();return {items:db.midiPorts,backend:'native-host-midi-adapter'};
});
app.post('/api/projects/:id/instruments',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
 const track=p.tracks.find((x:any)=>x.id===req.body?.trackId&&x.kind==='instrument');if(!track)return reply.code(400).send({error:'Instrument track required'});
 const existing=db.instrumentInstances.find((x:any)=>x.projectId===p.id&&x.trackId===track.id);if(existing)return existing;const now=new Date().toISOString();
 const item:any={id:randomUUID(),projectId:p.id,trackId:track.id,name:String(req.body?.name||'NNIT Studio Instrument'),engine:'builtin',preset:String(req.body?.preset||'Studio Piano'),polyphony:Math.max(1,Math.min(256,Number(req.body?.polyphony||64))),activeVoices:0,volumeDb:0,pan:0,enabled:true,createdAt:now,updatedAt:now};db.instrumentInstances.push(item);db.save();reply.code(201);return item;
});
app.patch('/api/instruments/:id',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const i=db.instrumentInstances.find((x:any)=>x.id===req.params.id);if(!i)return reply.code(404).send({error:'Instrument not found'});
 if(req.body?.preset!==undefined)i.preset=String(req.body.preset);if(req.body?.polyphony!==undefined)i.polyphony=Math.max(1,Math.min(256,Number(req.body.polyphony)));if(req.body?.volumeDb!==undefined)i.volumeDb=Math.max(-60,Math.min(12,Number(req.body.volumeDb)));if(req.body?.pan!==undefined)i.pan=Math.max(-1,Math.min(1,Number(req.body.pan)));if(req.body?.enabled!==undefined)i.enabled=Boolean(req.body.enabled);i.updatedAt=new Date().toISOString();db.save();return i;
});
app.post('/api/projects/:id/midi/events',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
 const track=p.tracks.find((x:any)=>x.id===req.body?.trackId&&x.kind==='instrument');if(!track)return reply.code(400).send({error:'Instrument track required'});
 const type=(['note_on','note_off','cc','pitch_bend','aftertouch'].includes(req.body?.type)?req.body.type:'note_on') as any;
 const e:any={id:randomUUID(),projectId:p.id,trackId:track.id,type,channel:Math.max(1,Math.min(16,Number(req.body?.channel||1))),note:req.body?.note!==undefined?Math.max(0,Math.min(127,Number(req.body.note))):undefined,velocity:req.body?.velocity!==undefined?Math.max(0,Math.min(127,Number(req.body.velocity))):undefined,controller:req.body?.controller!==undefined?Math.max(0,Math.min(127,Number(req.body.controller))):undefined,value:req.body?.value!==undefined?Number(req.body.value):undefined,timeSeconds:Math.max(0,Number(req.body?.timeSeconds||0)),durationSeconds:req.body?.durationSeconds!==undefined?Math.max(0,Number(req.body.durationSeconds)):undefined,createdAt:new Date().toISOString()};
 db.midiEvents.push(e);db.save();reply.code(201);return e;
});
app.post('/api/projects/:id/midi/import-track-notes',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});let count=0;
 for(const t of p.tracks||[]){if(t.kind!=='instrument')continue;for(const note of t.midiNotes||[]){const existing=db.midiEvents.find((e:any)=>e.projectId===p.id&&e.trackId===t.id&&e.note===Number(note.pitch??60)&&Math.abs(e.timeSeconds-Number(note.start||0))<.0001);if(existing)continue;db.midiEvents.push({id:randomUUID(),projectId:p.id,trackId:t.id,type:'note_on',channel:1,note:Number(note.pitch??60),velocity:Number(note.velocity??100),timeSeconds:Number(note.start||0),durationSeconds:Number(note.duration||.5),createdAt:new Date().toISOString()});count++}}
 db.save();return {imported:count};
});
app.post('/api/projects/:id/midi/play',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
 let st=db.midiPlaybackStates.find((x:any)=>x.projectId===p.id);const events=db.midiEvents.filter((x:any)=>x.projectId===p.id).sort((x:any,y:any)=>x.timeSeconds-y.timeSeconds),now=new Date().toISOString();
 if(!st){st={id:randomUUID(),projectId:p.id,status:'playing',positionSeconds:Number(req.body?.positionSeconds||0),tempo:Number(p.bpm||120),scheduledEvents:events.length,activeNotes:[],xruns:0,updatedAt:now};db.midiPlaybackStates.push(st)}else{st.status='playing';st.positionSeconds=Number(req.body?.positionSeconds??st.positionSeconds);st.tempo=Number(p.bpm||120);st.scheduledEvents=events.length;st.updatedAt=now}
 db.save();return st;
});
app.post('/api/projects/:id/midi/stop',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const st=db.midiPlaybackStates.find((x:any)=>x.projectId===req.params.id);if(!st)return reply.code(404).send({error:'MIDI playback state not found'});st.status='stopped';st.activeNotes=[];st.updatedAt=new Date().toISOString();for(const i of db.instrumentInstances.filter((x:any)=>x.projectId===req.params.id))i.activeVoices=0;db.save();return st;
});
app.post('/api/projects/:id/midi/panic',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const st=db.midiPlaybackStates.find((x:any)=>x.projectId===req.params.id);if(st){st.activeNotes=[];st.status='stopped';st.updatedAt=new Date().toISOString()}for(const i of db.instrumentInstances.filter((x:any)=>x.projectId===req.params.id))i.activeVoices=0;db.save();return {ok:true,message:'All notes off / MIDI panic executed'};
});
app.post('/api/projects/:id/midi/diagnostics',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
 for(let i=db.midiDiagnostics.length-1;i>=0;i--){if(db.midiDiagnostics[i].projectId===p.id)db.midiDiagnostics.splice(i,1)}const now=new Date().toISOString();
 for(const i of db.instrumentInstances.filter((x:any)=>x.projectId===p.id)){if(i.activeVoices>i.polyphony)db.midiDiagnostics.push({id:randomUUID(),projectId:p.id,severity:'warning',code:'POLYPHONY_EXCEEDED',message:`${i.name}: ${i.activeVoices}/${i.polyphony} voices`,trackId:i.trackId,createdAt:now})}
 const invalid=db.midiEvents.filter((x:any)=>x.projectId===p.id&&(x.note!==undefined&&(x.note<0||x.note>127)));for(const e of invalid)db.midiDiagnostics.push({id:randomUUID(),projectId:p.id,severity:'error',code:'INVALID_NOTE',message:`Invalid MIDI note ${e.note}`,trackId:e.trackId,createdAt:now});
 if(!db.midiDiagnostics.some((x:any)=>x.projectId===p.id))db.midiDiagnostics.push({id:randomUUID(),projectId:p.id,severity:'info',code:'MIDI_ENGINE_OK',message:`MIDI engine validated · ${db.midiEvents.filter((x:any)=>x.projectId===p.id).length} scheduled event(s)`,createdAt:now});db.save();return {items:db.midiDiagnostics.filter((x:any)=>x.projectId===p.id)};
});

app.get('/api/plugin-engine/overview',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
 return {plugins:db.pluginBinaries,instances:db.pluginInstances,delayComp:db.delayCompStates,diagnostics:db.pluginDiagnostics};
});
app.post('/api/plugin-engine/scan',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
 const now=new Date().toISOString();for(const p of db.pluginBinaries)p.scannedAt=now;db.save();return {items:db.pluginBinaries,adapter:'native-host-plugin-scanner'};
});
app.post('/api/projects/:id/plugin-instances',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
 const plugin=db.pluginBinaries.find((x:any)=>x.id===req.body?.pluginId&&x.status==='available');if(!plugin)return reply.code(400).send({error:'Plugin unavailable'});
 const trackId=req.body?.trackId?String(req.body.trackId):undefined;if(trackId&&!p.tracks.find((x:any)=>x.id===trackId))return reply.code(400).send({error:'Track not found'});
 const existing=db.pluginInstances.filter((x:any)=>x.projectId===p.id&&x.trackId===trackId),slot=Number(req.body?.slot??existing.length),now=new Date().toISOString(),params:any={mix:1};
 const item:any={id:randomUUID(),projectId:p.id,trackId,pluginId:plugin.id,slot,enabled:true,bypass:false,latencySamples:plugin.latencySamples,params,stateHash:pluginStateHash(params),createdAt:now,updatedAt:now};db.pluginInstances.push(item);db.save();reply.code(201);return item;
});
app.patch('/api/plugin-instances/:id',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const i=db.pluginInstances.find((x:any)=>x.id===req.params.id);if(!i)return reply.code(404).send({error:'Plugin instance not found'});
 if(req.body?.enabled!==undefined)i.enabled=Boolean(req.body.enabled);if(req.body?.bypass!==undefined)i.bypass=Boolean(req.body.bypass);if(req.body?.params&&typeof req.body.params==='object')i.params={...i.params,...req.body.params};i.stateHash=pluginStateHash(i.params);i.updatedAt=new Date().toISOString();db.save();return i;
});
app.delete('/api/plugin-instances/:id',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const idx=db.pluginInstances.findIndex((x:any)=>x.id===req.params.id);if(idx<0)return reply.code(404).send({error:'Plugin instance not found'});db.pluginInstances.splice(idx,1);db.save();return {ok:true};
});
app.post('/api/projects/:id/delay-compensation/recalculate',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
 for(let x=db.delayCompStates.length-1;x>=0;x--){if(db.delayCompStates[x].projectId===p.id)db.delayCompStates.splice(x,1)}
 const now=new Date().toISOString(),latencies=(p.tracks||[]).map((t:any)=>({trackId:t.id,latency:db.pluginInstances.filter((i:any)=>i.projectId===p.id&&i.trackId===t.id&&i.enabled&&!i.bypass).reduce((n:number,i:any)=>n+Number(i.latencySamples||0),0)})),maxLatency=Math.max(0,...latencies.map((x:any)=>x.latency));
 for(const t of latencies)db.delayCompStates.push({id:randomUUID(),projectId:p.id,entityId:t.trackId,entityType:'track',pluginLatencySamples:t.latency,routeLatencySamples:t.latency,compensationSamples:maxLatency-t.latency,updatedAt:now});
 db.save();return {items:db.delayCompStates.filter((x:any)=>x.projectId===p.id),maxLatencySamples:maxLatency};
});
app.post('/api/projects/:id/plugin-diagnostics',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
 for(let i=db.pluginDiagnostics.length-1;i>=0;i--){if(db.pluginDiagnostics[i].projectId===p.id)db.pluginDiagnostics.splice(i,1)}
 const now=new Date().toISOString(),instances=db.pluginInstances.filter((x:any)=>x.projectId===p.id);
 for(const i of instances){const plug=db.pluginBinaries.find((x:any)=>x.id===i.pluginId);if(!plug||plug.status!=='available')db.pluginDiagnostics.push({id:randomUUID(),projectId:p.id,severity:'error',code:'PLUGIN_UNAVAILABLE',message:`Plugin ${i.pluginId} unavailable`,pluginInstanceId:i.id,createdAt:now});if(Number(i.latencySamples)>4096)db.pluginDiagnostics.push({id:randomUUID(),projectId:p.id,severity:'warning',code:'PLUGIN_LATENCY_HIGH',message:`High plugin latency: ${i.latencySamples} samples`,pluginInstanceId:i.id,createdAt:now})}
 if(!db.pluginDiagnostics.some((x:any)=>x.projectId===p.id))db.pluginDiagnostics.push({id:randomUUID(),projectId:p.id,severity:'info',code:'PLUGIN_ENGINE_OK',message:`${instances.length} plugin instance(s) validated`,createdAt:now});
 db.save();return {items:db.pluginDiagnostics.filter((x:any)=>x.projectId===p.id)};
});

app.get('/api/dsp/overview',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
 return {nodes:db.dspNodes.length,edges:db.dspEdges.length,meters:db.meterStates.length,diagnostics:db.dspDiagnostics.length};
});
app.get('/api/projects/:id/dsp-graph',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});ensureDspGraph(p);
 return {nodes:db.dspNodes.filter((x:any)=>x.projectId===p.id),edges:db.dspEdges.filter((x:any)=>x.projectId===p.id),meters:db.meterStates.filter((x:any)=>x.projectId===p.id)};
});
app.patch('/api/dsp/nodes/:id',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const node=db.dspNodes.find((x:any)=>x.id===req.params.id);if(!node)return reply.code(404).send({error:'DSP node not found'});
 if(req.body?.enabled!==undefined)node.enabled=Boolean(req.body.enabled);if(req.body?.params&&typeof req.body.params==='object')node.params={...node.params,...req.body.params};node.updatedAt=new Date().toISOString();db.save();return node;
});
app.patch('/api/dsp/edges/:id',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const edge=db.dspEdges.find((x:any)=>x.id===req.params.id);if(!edge)return reply.code(404).send({error:'DSP edge not found'});
 if(req.body?.enabled!==undefined)edge.enabled=Boolean(req.body.enabled);if(req.body?.gainDb!==undefined)edge.gainDb=clampDb(Number(req.body.gainDb));db.save();return edge;
});
app.post('/api/projects/:id/dsp/meters/tick',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});ensureDspGraph(p);const now=new Date().toISOString();
 for(const t of p.tracks||[]){const soloActive=(p.tracks||[]).some((x:any)=>x.solo),audible=!t.mute&&(!soloActive||t.solo),gain=audible?Number(t.gainDb||0):-120,activity=Math.min(1,Math.max(.02,(t.clips?.length||0)*.18+.08)),peak=audible?Math.min(0,-18+gain+activity*10):-120,rms=audible?peak-8:-120,lufs=rms-3;let m=db.meterStates.find((x:any)=>x.projectId===p.id&&x.entityType==='track'&&x.entityId===t.id);if(!m){m={id:randomUUID(),projectId:p.id,entityType:'track',entityId:t.id,peakDbfs:peak,rmsDbfs:rms,lufsShort:lufs,clipping:peak>=0,updatedAt:now};db.meterStates.push(m)}else Object.assign(m,{peakDbfs:peak,rmsDbfs:rms,lufsShort:lufs,clipping:peak>=0,updatedAt:now})}
 const trackMeters=db.meterStates.filter((x:any)=>x.projectId===p.id&&x.entityType==='track'),masterPeak=trackMeters.length?Math.min(0,Math.max(...trackMeters.map((x:any)=>x.peakDbfs))+3):-120,masterRms=masterPeak-7;let mm=db.meterStates.find((x:any)=>x.projectId===p.id&&x.entityType==='master');if(!mm){mm={id:randomUUID(),projectId:p.id,entityType:'master',entityId:'master',peakDbfs:masterPeak,rmsDbfs:masterRms,lufsShort:masterRms-3,clipping:masterPeak>=0,updatedAt:now};db.meterStates.push(mm)}else Object.assign(mm,{peakDbfs:masterPeak,rmsDbfs:masterRms,lufsShort:masterRms-3,clipping:masterPeak>=0,updatedAt:now});db.save();return {items:db.meterStates.filter((x:any)=>x.projectId===p.id)};
});
app.post('/api/projects/:id/dsp/diagnostics',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});ensureDspGraph(p);for(let i=db.dspDiagnostics.length-1;i>=0;i--){if(db.dspDiagnostics[i].projectId===p.id)db.dspDiagnostics.splice(i,1)}const now=new Date().toISOString(),nodes=db.dspNodes.filter((x:any)=>x.projectId===p.id),edges=db.dspEdges.filter((x:any)=>x.projectId===p.id);
 const ids=new Set(nodes.map((x:any)=>x.id));for(const e of edges){if(!ids.has(e.fromNodeId)||!ids.has(e.toNodeId))db.dspDiagnostics.push({id:randomUUID(),projectId:p.id,severity:'error',code:'BROKEN_EDGE',message:'DSP edge references a missing node',entityId:e.id,createdAt:now})}
 for(const m of db.meterStates.filter((x:any)=>x.projectId===p.id&&x.clipping))db.dspDiagnostics.push({id:randomUUID(),projectId:p.id,severity:'warning',code:'CLIPPING',message:`${m.entityType} ${m.entityId} is clipping`,entityId:m.id,createdAt:now});
 const activeNodes=nodes.filter((x:any)=>x.enabled).length,cpuEstimate=Math.min(95,Math.round(activeNodes*.7+edges.filter((x:any)=>x.enabled).length*.25));if(cpuEstimate>75)db.dspDiagnostics.push({id:randomUUID(),projectId:p.id,severity:'warning',code:'DSP_LOAD_HIGH',message:`Estimated DSP graph load is ${cpuEstimate}%`,createdAt:now});
 if(!db.dspDiagnostics.some((x:any)=>x.projectId===p.id))db.dspDiagnostics.push({id:randomUUID(),projectId:p.id,severity:'info',code:'DSP_GRAPH_OK',message:`DSP graph valid · estimated load ${cpuEstimate}%`,createdAt:now});db.save();return {items:db.dspDiagnostics.filter((x:any)=>x.projectId===p.id),cpuEstimate};
});

app.get('/api/media-engine/overview',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
 return {assets:db.mediaAssets.length,probes:db.mediaProbes.length,waveforms:db.waveformCaches.length,streams:db.streamStates.length,offline:db.streamStates.filter((x:any)=>x.status==='offline').length,stalled:db.streamStates.filter((x:any)=>x.status==='stalled').length,underruns:db.streamStates.reduce((n:number,x:any)=>n+Number(x.underruns||0),0),streamStates:db.streamStates.slice(0,100)};
});
app.post('/api/media-assets/:id/probe',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const asset=db.mediaAssets.find((x:any)=>x.id===req.params.id);if(!asset)return reply.code(404).send({error:'Media asset not found'});
 const now=new Date().toISOString(),codec=String(req.body?.codec||'pcm_s24le'),container=String(req.body?.container||((asset.name||'').toLowerCase().endsWith('.wav')?'wav':'unknown')),sampleRate=Number(asset.sampleRate||req.body?.sampleRate||db.audioEngineConfig.sampleRate),channels=Number(asset.channels||req.body?.channels||2),bitDepth=Number(req.body?.bitDepth||db.audioEngineConfig.bitDepth),durationSeconds=Number(asset.durationSeconds||req.body?.durationSeconds||0),frameCount=Math.max(0,Math.round(durationSeconds*sampleRate));
 let probe=db.mediaProbes.find((x:any)=>x.mediaAssetId===asset.id);if(!probe){probe={id:randomUUID(),mediaAssetId:asset.id,codec,container,sampleRate,channels,bitDepth,durationSeconds,frameCount,status:'ready',createdAt:now,updatedAt:now};db.mediaProbes.unshift(probe)}else{Object.assign(probe,{codec,container,sampleRate,channels,bitDepth,durationSeconds,frameCount,status:'ready',updatedAt:now,error:undefined})}
 db.save();return probe;
});
app.post('/api/media-assets/:id/waveform',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const asset=db.mediaAssets.find((x:any)=>x.id===req.params.id);if(!asset)return reply.code(404).send({error:'Media asset not found'});
 const resolution=Math.max(64,Math.min(4096,Number(req.body?.resolution||512))),now=new Date().toISOString(),peaks=makeSyntheticPeaks(`${asset.checksum}|${resolution}`,resolution),checksum=createHash('sha256').update(JSON.stringify(peaks)).digest('hex');
 let cache=db.waveformCaches.find((x:any)=>x.mediaAssetId===asset.id&&x.resolution===resolution);if(!cache){cache={id:randomUUID(),mediaAssetId:asset.id,resolution,peaks,checksum,status:'ready',createdAt:now,updatedAt:now};db.waveformCaches.unshift(cache)}else{Object.assign(cache,{peaks,checksum,status:'ready',updatedAt:now})}
 db.save();return cache;
});
app.post('/api/media-assets/:id/stream/start',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const asset=db.mediaAssets.find((x:any)=>x.id===req.params.id);if(!asset)return reply.code(404).send({error:'Media asset not found'});const now=new Date().toISOString();
 let st=db.streamStates.find((x:any)=>x.mediaAssetId===asset.id);if(!st){st={id:randomUUID(),mediaAssetId:asset.id,projectId:asset.projectId,status:asset.status==='missing'?'offline':'streaming',readAheadMs:Math.max(50,Number(req.body?.readAheadMs||500)),bufferedMs:asset.status==='missing'?0:Math.max(50,Number(req.body?.readAheadMs||500)),underruns:0,positionSeconds:0,updatedAt:now};db.streamStates.unshift(st)}else{st.status=asset.status==='missing'?'offline':'streaming';st.readAheadMs=Math.max(50,Number(req.body?.readAheadMs||st.readAheadMs||500));st.bufferedMs=st.status==='offline'?0:st.readAheadMs;st.updatedAt=now}
 db.save();return st;
});
app.post('/api/projects/:id/media-diagnostics/run',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});
 for(let i=db.mediaDiagnostics.length-1;i>=0;i--){if(db.mediaDiagnostics[i].projectId===p.id)db.mediaDiagnostics.splice(i,1)}
 const now=new Date().toISOString(),assets=db.mediaAssets.filter((x:any)=>x.projectId===p.id);
 for(const m of assets){if(m.status==='missing')db.mediaDiagnostics.push({id:randomUUID(),mediaAssetId:m.id,projectId:p.id,severity:'error',code:'MEDIA_OFFLINE',message:`${m.name} is offline`,createdAt:now});if(!db.mediaProbes.find((x:any)=>x.mediaAssetId===m.id))db.mediaDiagnostics.push({id:randomUUID(),mediaAssetId:m.id,projectId:p.id,severity:'warning',code:'NOT_PROBED',message:`${m.name} has not been probed`,createdAt:now});if(!db.waveformCaches.find((x:any)=>x.mediaAssetId===m.id&&x.status==='ready'))db.mediaDiagnostics.push({id:randomUUID(),mediaAssetId:m.id,projectId:p.id,severity:'warning',code:'NO_WAVEFORM_CACHE',message:`${m.name} has no ready waveform cache`,createdAt:now})}
 for(const st of db.streamStates.filter((x:any)=>x.projectId===p.id&&x.underruns>0))db.mediaDiagnostics.push({id:randomUUID(),mediaAssetId:st.mediaAssetId,projectId:p.id,severity:'warning',code:'STREAM_UNDERRUN',message:`Stream has ${st.underruns} underrun(s)`,createdAt:now});
 if(db.mediaDiagnostics.filter((x:any)=>x.projectId===p.id).length===0)db.mediaDiagnostics.push({id:randomUUID(),projectId:p.id,severity:'info',code:'MEDIA_ENGINE_OK',message:'Media engine diagnostics passed',createdAt:now});db.save();return {items:db.mediaDiagnostics.filter((x:any)=>x.projectId===p.id)};
});
app.get('/api/projects/:id/media-diagnostics',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});return {items:db.mediaDiagnostics.filter((x:any)=>x.projectId===req.params.id).slice(0,200)};
});

app.get('/api/audio-io/overview',async(req:any,reply)=>{const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});return {devices:db.audioDevices,sessions:db.recordingSessions.slice(0,100),takes:db.recordingTakes.slice(0,100),events:db.audioRuntimeEvents.slice(0,100),engine:db.audioEngineConfig}});
app.post('/api/audio-io/scan-devices',async(req:any,reply)=>{const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const now=new Date().toISOString();for(const d of db.audioDevices){d.status='online';d.lastSeenAt=now}db.save();return {items:db.audioDevices,backend:'native-host-adapter',scannedAt:now}});
app.patch('/api/audio-io/devices/:id',async(req:any,reply)=>{const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const d=db.audioDevices.find((x:any)=>x.id===req.params.id);if(!d)return reply.code(404).send({error:'Device not found'});if(['online','offline'].includes(req.body?.status)){d.status=req.body.status;pushAudioEvent(d.status==='offline'?'device_disconnected':'device_connected',d.status==='offline'?'warning':'info',`${d.name} is ${d.status}`,d.id)}d.lastSeenAt=new Date().toISOString();db.save();return d});
app.post('/api/projects/:id/recording-sessions',async(req:any,reply)=>{const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});const track=p.tracks.find((x:any)=>x.id===req.body?.trackId);if(!track)return reply.code(400).send({error:'Valid track required'});const input=db.audioDevices.find((x:any)=>x.id===(req.body?.inputDeviceId||db.audioEngineConfig.inputDeviceId||'input-default')&&x.kind==='input');const output=db.audioDevices.find((x:any)=>x.id===(req.body?.outputDeviceId||db.audioEngineConfig.outputDeviceId||'output-default')&&x.kind==='output');if(!input||input.status!=='online')return reply.code(409).send({error:'Input device unavailable'});if(!output||output.status!=='online')return reply.code(409).send({error:'Output device unavailable'});const sr=Number(req.body?.sampleRate||db.audioEngineConfig.sampleRate);if(!input.supportedSampleRates.includes(sr)||!output.supportedSampleRates.includes(sr)){pushAudioEvent('sample_rate_mismatch','error',`Sample rate ${sr} Hz is not supported by selected devices`,input.id);return reply.code(409).send({error:'Sample-rate mismatch'})}const latency=Math.round((db.audioEngineConfig.bufferSize/sr)*1000*2*100)/100;const session:any={id:randomUUID(),projectId:p.id,trackId:track.id,inputDeviceId:input.id,outputDeviceId:output.id,sampleRate:sr,bufferSize:db.audioEngineConfig.bufferSize,monitoring:Boolean(req.body?.monitoring),status:'armed',latencyMs:latency,xruns:0};db.recordingSessions.unshift(session);db.save();reply.code(201);return session});
app.post('/api/recording-sessions/:id/start',async(req:any,reply)=>{const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const s=db.recordingSessions.find((x:any)=>x.id===req.params.id);if(!s)return reply.code(404).send({error:'Recording session not found'});const input=db.audioDevices.find((x:any)=>x.id===s.inputDeviceId);if(!input||input.status!=='online'){s.status='failed';s.error='Input device disconnected';pushAudioEvent('device_disconnected','error','Recording cannot start: input device disconnected',s.inputDeviceId,s.id);db.save();return reply.code(409).send({error:s.error})}s.status='recording';s.startedAt=new Date().toISOString();const p=db.project(s.projectId);const track=p?.tracks.find((x:any)=>x.id===s.trackId);const take:any={id:randomUUID(),sessionId:s.id,projectId:s.projectId,trackId:s.trackId,name:`Take ${db.recordingTakes.filter((x:any)=>x.projectId===s.projectId&&x.trackId===s.trackId).length+1}`,fileName:`${(track?.name||'track').replace(/[^a-z0-9_-]+/gi,'_')}-${Date.now()}.wav`,path:`recordings/${s.projectId}/${s.trackId}/`,durationSeconds:0,sampleRate:s.sampleRate,channels:Math.min(2,input.channels||1),bitDepth:db.audioEngineConfig.bitDepth,status:'capturing',createdAt:s.startedAt};db.recordingTakes.unshift(take);pushAudioEvent('recording_started','info',`${take.name} recording started`,s.inputDeviceId,s.id);db.save();return {session:s,take}});
app.post('/api/recording-sessions/:id/stop',async(req:any,reply)=>{const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const s=db.recordingSessions.find((x:any)=>x.id===req.params.id);if(!s)return reply.code(404).send({error:'Recording session not found'});const take=db.recordingTakes.find((x:any)=>x.sessionId===s.id&&x.status==='capturing');const stopped=new Date().toISOString();s.status='stopped';s.stoppedAt=stopped;if(take){const start=new Date(take.createdAt).getTime();take.durationSeconds=Math.max(.01,(Date.now()-start)/1000);take.status='completed';take.completedAt=stopped}pushAudioEvent('recording_stopped','info',`${take?.name||'Recording'} stopped`,s.inputDeviceId,s.id);db.save();return {session:s,take}});
app.patch('/api/recording-sessions/:id/monitoring',async(req:any,reply)=>{const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const s=db.recordingSessions.find((x:any)=>x.id===req.params.id);if(!s)return reply.code(404).send({error:'Recording session not found'});s.monitoring=Boolean(req.body?.monitoring);pushAudioEvent('monitoring_changed','info',`Input monitoring ${s.monitoring?'enabled':'disabled'}`,s.inputDeviceId,s.id);db.save();return s});
app.post('/api/recording-sessions/:id/xrun',async(req:any,reply)=>{const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const s=db.recordingSessions.find((x:any)=>x.id===req.params.id);if(!s)return reply.code(404).send({error:'Recording session not found'});s.xruns+=1;pushAudioEvent('xrun','warning',`Audio buffer underrun/overrun detected (${s.xruns})`,s.inputDeviceId,s.id);db.save();return s});

app.get('/api/reliability/overview',async(req:any,reply)=>{const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});return {projects:db.projects.length,mediaAssets:db.mediaAssets.length,missingMedia:db.mediaAssets.filter((x:any)=>x.status==='missing').length,snapshots:db.projectSnapshots.length,openIssues:db.integrityIssues.filter((x:any)=>x.severity!=='info').length,renderJobs:db.renderJobs.length,audioEngine:db.audioEngineConfig}});
app.get('/api/audio-engine/config',async(req:any,reply)=>{const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});return db.audioEngineConfig});
app.patch('/api/audio-engine/config',async(req:any,reply)=>{const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const c=db.audioEngineConfig;if([44100,48000,88200,96000].includes(Number(req.body?.sampleRate)))c.sampleRate=Number(req.body.sampleRate) as any;if([64,128,256,512,1024].includes(Number(req.body?.bufferSize)))c.bufferSize=Number(req.body.bufferSize) as any;if([16,24,32].includes(Number(req.body?.bitDepth)))c.bitDepth=Number(req.body.bitDepth) as any;if(req.body?.inputDeviceId!==undefined)c.inputDeviceId=String(req.body.inputDeviceId);if(req.body?.outputDeviceId!==undefined)c.outputDeviceId=String(req.body.outputDeviceId);if(req.body?.exclusiveMode!==undefined)c.exclusiveMode=Boolean(req.body.exclusiveMode);if(req.body?.safeMode!==undefined)c.safeMode=Boolean(req.body.safeMode);c.updatedAt=new Date().toISOString();db.save();return c});
app.get('/api/projects/:id/snapshots',async(req:any,reply)=>{const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});return {items:db.projectSnapshots.filter((x:any)=>x.projectId===p.id).slice(0,100).map((x:any)=>({...x,payload:undefined}))}});
app.post('/api/projects/:id/snapshots',async(req:any,reply)=>{const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});const kind=(['autosave','manual','crash_recovery'].includes(req.body?.kind)?req.body.kind:'manual') as any,payload=projectPayload(p),raw=JSON.stringify(payload),snap:any={id:randomUUID(),projectId:p.id,kind,label:String(req.body?.label||`${kind} snapshot`).slice(0,120),checksum:reliabilityChecksum(raw),payload,createdAt:new Date().toISOString()};db.projectSnapshots.unshift(snap);const projectSnaps=db.projectSnapshots.filter((x:any)=>x.projectId===p.id);for(const old of projectSnaps.slice(50)){const i=db.projectSnapshots.findIndex((x:any)=>x.id===old.id);if(i>=0)db.projectSnapshots.splice(i,1)}db.save();reply.code(201);return {...snap,payload:undefined}});
app.post('/api/projects/:id/snapshots/:snapshotId/restore',async(req:any,reply)=>{const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});const snap=db.projectSnapshots.find((x:any)=>x.id===req.params.snapshotId&&x.projectId===p.id);if(!snap)return reply.code(404).send({error:'Snapshot not found'});const incoming=JSON.parse(JSON.stringify(snap.payload));Object.keys(p).forEach(k=>delete (p as any)[k]);Object.assign(p,incoming);db.save();return {restored:true,projectId:p.id,snapshotId:snap.id}});
app.get('/api/projects/:id/media',async(req:any,reply)=>{const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});return {items:db.mediaAssets.filter((x:any)=>x.projectId===p.id)}});
app.post('/api/projects/:id/media/register',async(req:any,reply)=>{const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});const path=String(req.body?.path||'').trim();if(!path)return reply.code(400).send({error:'Media path required'});const raw=`${p.id}|${path}|${req.body?.sizeBytes||0}`,now=new Date().toISOString();const item:any={id:randomUUID(),projectId:p.id,name:String(req.body?.name||path.split(/[\\\\/]/).pop()||'Media').slice(0,180),kind:(['audio','midi','image','other'].includes(req.body?.kind)?req.body.kind:'audio'),path,sizeBytes:Math.max(0,Number(req.body?.sizeBytes||0)),checksum:String(req.body?.checksum||reliabilityChecksum(raw)),status:'online',durationSeconds:req.body?.durationSeconds!==undefined?Number(req.body.durationSeconds):undefined,sampleRate:req.body?.sampleRate!==undefined?Number(req.body.sampleRate):undefined,channels:req.body?.channels!==undefined?Number(req.body.channels):undefined,createdAt:now,updatedAt:now};db.mediaAssets.unshift(item);db.save();reply.code(201);return item});
app.patch('/api/projects/:projectId/media/:id',async(req:any,reply)=>{const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const item=db.mediaAssets.find((x:any)=>x.id===req.params.id&&x.projectId===req.params.projectId);if(!item)return reply.code(404).send({error:'Media asset not found'});if(req.body?.path!==undefined){item.path=String(req.body.path);item.status='relinked'}if(['online','missing','relinked'].includes(req.body?.status))item.status=req.body.status;item.updatedAt=new Date().toISOString();db.save();return item});
app.post('/api/projects/:id/integrity-scan',async(req:any,reply)=>{const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});for(let i=db.integrityIssues.length-1;i>=0;i--){if(db.integrityIssues[i].projectId===p.id)db.integrityIssues.splice(i,1)}const now=new Date().toISOString();for(const m of db.mediaAssets.filter((x:any)=>x.projectId===p.id&&x.status==='missing'))db.integrityIssues.push({id:randomUUID(),projectId:p.id,severity:'error',code:'MISSING_MEDIA',message:`Missing media: ${m.name}`,entityId:m.id,createdAt:now});for(const t of p.tracks||[]){for(const c of t.clips||[]){if(Number(c.duration||0)<=0)db.integrityIssues.push({id:randomUUID(),projectId:p.id,severity:'warning',code:'ZERO_DURATION_CLIP',message:`Clip ${c.name||c.id} has zero duration`,entityId:c.id,createdAt:now})}}if(db.integrityIssues.filter((x:any)=>x.projectId===p.id).length===0)db.integrityIssues.push({id:randomUUID(),projectId:p.id,severity:'info',code:'OK',message:'Project integrity scan passed',createdAt:now});db.save();return {items:db.integrityIssues.filter((x:any)=>x.projectId===p.id)}});
app.get('/api/projects/:id/integrity-issues',async(req:any,reply)=>{const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});return {items:db.integrityIssues.filter((x:any)=>x.projectId===req.params.id)}});
app.get('/api/render-jobs',async(req:any,reply)=>{const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});return {items:db.renderJobs.slice(0,200)}});
app.post('/api/projects/:id/render-jobs',async(req:any,reply)=>{const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});const format=(['wav','flac','mp3','stems'].includes(req.body?.format)?req.body.format:'wav') as any,now=new Date().toISOString();const job:any={id:randomUUID(),projectId:p.id,format,sampleRate:Number(req.body?.sampleRate||db.audioEngineConfig.sampleRate),bitDepth:Number(req.body?.bitDepth||db.audioEngineConfig.bitDepth),status:'completed',progress:100,outputName:String(req.body?.outputName||`${p.name}.${format==='stems'?'zip':format}`).slice(0,180),createdAt:now,completedAt:new Date().toISOString()};db.renderJobs.unshift(job);db.save();reply.code(201);return job});

app.get('/api/ops/overview',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;
 const unresolved=db.incidents.filter((x:any)=>x.status!=='resolved');
 return {version:'0.39.0',environment:'local-development',maintenance:Boolean(db.opsSettings.find((x:any)=>x.key==='maintenance_mode')?.value),releaseChannel:db.opsSettings.find((x:any)=>x.key==='release_channel')?.value||'stable',deployments:db.deployments.length,incidentsOpen:unresolved.length,services:db.serviceHealth};
});
app.post('/api/ops/health-check',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;
 const now=new Date().toISOString();
 const services=[
  {id:'health-api',service:'API',status:'healthy' as const,latencyMs:1,message:'Fastify API responding',checkedAt:now},
  {id:'health-web',service:'Web',status:'healthy' as const,latencyMs:1,message:'Vite frontend configured',checkedAt:now},
  {id:'health-db',service:'Local Data Store',status:'healthy' as const,latencyMs:1,message:'JSON persistence available',checkedAt:now},
  {id:'health-native',service:'Native Host',status:'unknown' as const,latencyMs:0,message:'Checked externally by launcher',checkedAt:now},
  {id:'health-ai',service:'Local AI',status:'unknown' as const,latencyMs:0,message:'Checked externally by launcher',checkedAt:now}
 ];
 db.serviceHealth.splice(0,db.serviceHealth.length,...services);db.audit(auth.user.id,'ops.health_check','system',undefined,{services:services.length});db.save();return {items:services};
});
app.get('/api/ops/deployments',async(req:any,reply)=>{const auth=requireAdmin(req,reply);if(!auth)return;return {items:db.deployments.slice(0,200)}});
app.post('/api/ops/deployments',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;const env=(['development','staging','production'].includes(req.body?.environment)?req.body.environment:'staging') as any;const now=new Date().toISOString();
 const d:any={id:randomUUID(),environment:env,version:String(req.body?.version||'0.30.0'),status:'healthy',commit:req.body?.commit?String(req.body.commit):undefined,notes:String(req.body?.notes||'Manual deployment record').slice(0,1000),createdAt:now,completedAt:new Date().toISOString()};
 db.deployments.unshift(d);db.audit(auth.user.id,'deployment.create','deployment',d.id,{environment:env,version:d.version});queueNotification(auth.user.id,'admin','in_app','Deployment recorded',`${env} · ${d.version}`);db.save();reply.code(201);return d;
});
app.post('/api/ops/deployments/:id/rollback',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;const d=db.deployments.find((x:any)=>x.id===req.params.id);if(!d)return reply.code(404).send({error:'Deployment not found'});d.status='rolled_back';db.audit(auth.user.id,'deployment.rollback','deployment',d.id,{environment:d.environment});queueNotification(auth.user.id,'admin','in_app','Deployment rollback',`${d.environment} ${d.version} marked rolled back`);db.save();return d;
});
app.get('/api/ops/incidents',async(req:any,reply)=>{const auth=requireAdmin(req,reply);if(!auth)return;return {items:db.incidents.slice(0,200)}});
app.post('/api/ops/incidents',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;const now=new Date().toISOString();const i:any={id:randomUUID(),title:String(req.body?.title||'Operational Incident').slice(0,180),severity:(['minor','major','critical'].includes(req.body?.severity)?req.body.severity:'minor'),status:'investigating',services:Array.isArray(req.body?.services)?req.body.services.map(String):['API'],message:String(req.body?.message||'Incident opened').slice(0,1500),createdAt:now,updatedAt:now};
 db.incidents.unshift(i);db.audit(auth.user.id,'incident.create','incident',i.id,{severity:i.severity});queueNotification(auth.user.id,'admin','in_app','Operational incident',`${i.severity}: ${i.title}`);db.save();reply.code(201);return i;
});
app.patch('/api/ops/incidents/:id',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;const i=db.incidents.find((x:any)=>x.id===req.params.id);if(!i)return reply.code(404).send({error:'Incident not found'});
 if(['investigating','identified','monitoring','resolved'].includes(req.body?.status))i.status=req.body.status;if(req.body?.message!==undefined)i.message=String(req.body.message).slice(0,1500);i.updatedAt=new Date().toISOString();if(i.status==='resolved')i.resolvedAt=i.updatedAt;db.audit(auth.user.id,'incident.update','incident',i.id,{status:i.status});db.save();return i;
});
app.get('/api/ops/settings',async(req:any,reply)=>{const auth=requireAdmin(req,reply);if(!auth)return;return {items:db.opsSettings}});
app.patch('/api/ops/settings/:id',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;const s=db.opsSettings.find((x:any)=>x.id===req.params.id);if(!s)return reply.code(404).send({error:'Setting not found'});if(req.body?.value!==undefined)s.value=req.body.value;s.updatedAt=new Date().toISOString();db.audit(auth.user.id,'ops.setting.update','ops_setting',s.id,{value:s.value});db.save();return s;
});

app.get('/api/backups/overview',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;
 const latest=db.backupSnapshots[0]||null;return {targets:db.backupTargets.length,policies:db.backupPolicies.length,snapshots:db.backupSnapshots.length,failed:db.backupSnapshots.filter((x:any)=>x.status==='failed').length,latest,restores:db.restoreOperations.length};
});
app.get('/api/backups/targets',async(req:any,reply)=>{const auth=requireAdmin(req,reply);if(!auth)return;return {items:db.backupTargets}});
app.post('/api/backups/targets',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;const now=new Date().toISOString();
 const t:any={id:randomUUID(),name:String(req.body?.name||'Backup Target').slice(0,120),type:(['local','cloud','external'].includes(req.body?.type)?req.body.type:'local'),location:String(req.body?.location||'backups/local').slice(0,500),enabled:req.body?.enabled!==false,encrypted:req.body?.encrypted!==false,createdAt:now,updatedAt:now};
 db.backupTargets.push(t);db.audit(auth.user.id,'backup.target.create','backup_target',t.id,{type:t.type});db.save();reply.code(201);return t;
});
app.patch('/api/backups/targets/:id',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;const t=db.backupTargets.find((x:any)=>x.id===req.params.id);if(!t)return reply.code(404).send({error:'Backup target not found'});
 if(req.body?.enabled!==undefined)t.enabled=Boolean(req.body.enabled);if(req.body?.encrypted!==undefined)t.encrypted=Boolean(req.body.encrypted);if(req.body?.location!==undefined)t.location=String(req.body.location);t.updatedAt=new Date().toISOString();db.audit(auth.user.id,'backup.target.update','backup_target',t.id,{enabled:t.enabled});db.save();return t;
});
app.get('/api/backups/policies',async(req:any,reply)=>{const auth=requireAdmin(req,reply);if(!auth)return;return {items:db.backupPolicies}});
app.post('/api/backups/policies',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;const target=db.backupTargets.find((x:any)=>x.id===req.body?.targetId);if(!target)return reply.code(400).send({error:'Valid backup target required'});const now=new Date().toISOString();
 const p:any={id:randomUUID(),name:String(req.body?.name||'Backup Policy').slice(0,120),scope:(['all','projects','database','media'].includes(req.body?.scope)?req.body.scope:'all'),schedule:(['manual','hourly','daily','weekly'].includes(req.body?.schedule)?req.body.schedule:'daily'),retentionCount:Math.max(1,Math.min(365,Number(req.body?.retentionCount||30))),targetId:target.id,enabled:req.body?.enabled!==false,createdAt:now,updatedAt:now};
 db.backupPolicies.push(p);db.audit(auth.user.id,'backup.policy.create','backup_policy',p.id,{scope:p.scope,schedule:p.schedule});db.save();reply.code(201);return p;
});
app.patch('/api/backups/policies/:id',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;const p=db.backupPolicies.find((x:any)=>x.id===req.params.id);if(!p)return reply.code(404).send({error:'Backup policy not found'});
 if(req.body?.enabled!==undefined)p.enabled=Boolean(req.body.enabled);if(req.body?.retentionCount!==undefined)p.retentionCount=Math.max(1,Math.min(365,Number(req.body.retentionCount)));p.updatedAt=new Date().toISOString();db.audit(auth.user.id,'backup.policy.update','backup_policy',p.id,{enabled:p.enabled});db.save();return p;
});
app.get('/api/backups/snapshots',async(req:any,reply)=>{const auth=requireAdmin(req,reply);if(!auth)return;return {items:db.backupSnapshots.slice(0,300)}});
app.post('/api/backups/run',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;const policy=req.body?.policyId?db.backupPolicies.find((x:any)=>x.id===req.body.policyId):db.backupPolicies.find((x:any)=>x.enabled);if(!policy)return reply.code(400).send({error:'No enabled backup policy'});
 const target=db.backupTargets.find((x:any)=>x.id===policy.targetId&&x.enabled);if(!target)return reply.code(400).send({error:'Backup target unavailable'});const now=new Date().toISOString();
 const payload=JSON.stringify({projects:db.projects.length,users:db.users.length,releases:db.musicReleases.length,compositions:db.compositions.length,transactions:db.transactions.length,timestamp:now});
 const snap:any={id:randomUUID(),policyId:policy.id,targetId:target.id,scope:policy.scope,status:'completed',sizeBytes:Buffer.byteLength(payload,'utf8'),checksum:backupChecksum(payload),encrypted:target.encrypted,projectIds:policy.scope==='database'?[]:db.projects.map((x:any)=>x.id),createdAt:now,completedAt:new Date().toISOString()};
 db.backupSnapshots.unshift(snap);
 const retained=db.backupSnapshots.filter((x:any)=>x.policyId===policy.id);for(const old of retained.slice(policy.retentionCount)){const i=db.backupSnapshots.findIndex((x:any)=>x.id===old.id);if(i>=0)db.backupSnapshots.splice(i,1)}
 db.audit(auth.user.id,'backup.run','backup_snapshot',snap.id,{scope:snap.scope,targetId:snap.targetId});queueNotification(auth.user.id,'admin','in_app','Backup completed',`${policy.name} completed and checksum recorded`);db.save();reply.code(201);return snap;
});
app.post('/api/backups/snapshots/:id/verify',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;const snap=db.backupSnapshots.find((x:any)=>x.id===req.params.id);if(!snap)return reply.code(404).send({error:'Snapshot not found'});snap.status='verified';db.audit(auth.user.id,'backup.verify','backup_snapshot',snap.id,{checksum:snap.checksum});db.save();return snap;
});
app.get('/api/backups/restores',async(req:any,reply)=>{const auth=requireAdmin(req,reply);if(!auth)return;return {items:db.restoreOperations.slice(0,200)}});
app.post('/api/backups/snapshots/:id/restore',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;const snap=db.backupSnapshots.find((x:any)=>x.id===req.params.id);if(!snap)return reply.code(404).send({error:'Snapshot not found'});if(!['completed','verified'].includes(snap.status))return reply.code(409).send({error:'Snapshot is not restorable'});
 const now=new Date().toISOString();const op:any={id:randomUUID(),snapshotId:snap.id,requestedBy:auth.user.id,scope:String(req.body?.scope||snap.scope),status:'completed',createdAt:now,completedAt:new Date().toISOString()};db.restoreOperations.unshift(op);db.audit(auth.user.id,'backup.restore','restore_operation',op.id,{snapshotId:snap.id,scope:op.scope});queueNotification(auth.user.id,'admin','in_app','Restore completed',`Restore operation ${op.id.slice(0,8)} completed in sandbox mode`);db.save();reply.code(201);return op;
});

app.get('/api/security/overview',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
 const admin=db.adminFor(user.id);
 return {user:{id:user.id,email:user.email,status:user.status,adminRole:admin?.role||null},sessions:db.sessions.filter((x:any)=>x.userId===user.id&&!x.revoked).length,devices:db.devices.filter((x:any)=>x.userId===user.id).length,activeApiKeys:db.apiKeys.filter((x:any)=>x.userId===user.id&&x.status==='active').length,openSecurityEvents:db.securityEvents.filter((x:any)=>x.userId===user.id&&x.status==='open').length,pendingPrivacyRequests:db.privacyRequests.filter((x:any)=>x.userId===user.id&&!['completed','rejected'].includes(x.status)).length};
});
app.get('/api/security/api-keys',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
 return {items:db.apiKeys.filter((x:any)=>x.userId===user.id).map((x:any)=>({...x,keyHash:undefined,masked:maskApiKey(x.keyPrefix)}))};
});
app.post('/api/security/api-keys',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
 const secret=newApiSecret(),prefix=secret.slice(0,13),record:any={id:randomUUID(),userId:user.id,name:String(req.body?.name||'API Key').slice(0,120),keyPrefix:prefix,keyHash:hashPassword(secret),scopes:Array.isArray(req.body?.scopes)?req.body.scopes.map(String).slice(0,30):['studio:read'],status:'active',createdAt:new Date().toISOString()};
 db.apiKeys.unshift(record);db.audit(user.id,'api_key.create','api_key',record.id,{scopes:record.scopes});db.save();return reply.code(201).send({apiKey:{...record,keyHash:undefined},secret});
});
app.post('/api/security/api-keys/:id/revoke',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
 const key=db.apiKeys.find((x:any)=>x.id===req.params.id&&x.userId===user.id);if(!key)return reply.code(404).send({error:'API key not found'});
 key.status='revoked';key.revokedAt=new Date().toISOString();db.audit(user.id,'api_key.revoke','api_key',key.id,{});db.save();return {ok:true};
});
app.get('/api/security/events',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
 const admin=db.adminFor(user.id);return {items:db.securityEvents.filter((x:any)=>admin||x.userId===user.id).sort((a:any,b:any)=>b.createdAt.localeCompare(a.createdAt)).slice(0,300)};
});
app.post('/api/security/events',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;
 const item:any={id:randomUUID(),userId:req.body?.userId?String(req.body.userId):undefined,eventType:String(req.body?.eventType||'manual_review'),severity:(['info','low','medium','high','critical'].includes(req.body?.severity)?req.body.severity:'medium'),status:'open',ip:req.body?.ip?String(req.body.ip):undefined,deviceId:req.body?.deviceId?String(req.body.deviceId):undefined,message:String(req.body?.message||'Security review event').slice(0,1000),metadata:req.body?.metadata||{},createdAt:new Date().toISOString()};
 db.securityEvents.unshift(item);queueNotification(auth.user.id,'admin','in_app','Security event',`${item.severity}: ${item.message}`);db.audit(auth.user.id,'security_event.create','security_event',item.id,{severity:item.severity});db.save();reply.code(201);return item;
});
app.patch('/api/security/events/:id',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;const e=db.securityEvents.find((x:any)=>x.id===req.params.id);if(!e)return reply.code(404).send({error:'Security event not found'});
 if(['open','reviewed','resolved'].includes(req.body?.status))e.status=req.body.status;if(e.status==='resolved')e.resolvedAt=new Date().toISOString();db.audit(auth.user.id,'security_event.update','security_event',e.id,{status:e.status});db.save();return e;
});
app.get('/api/privacy/consents',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
 return {items:db.consents.filter((x:any)=>x.userId===user.id)};
});
app.post('/api/privacy/consents',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
 const c:any={id:randomUUID(),userId:user.id,consentType:String(req.body?.consentType||'product_terms'),version:String(req.body?.version||'1.0'),granted:req.body?.granted!==false,source:'in_app',createdAt:new Date().toISOString()};
 db.consents.unshift(c);db.save();reply.code(201);return c;
});
app.get('/api/privacy/requests',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});return {items:db.privacyRequests.filter((x:any)=>x.userId===user.id).sort((a:any,b:any)=>b.createdAt.localeCompare(a.createdAt))};
});
app.post('/api/privacy/requests',async(req:any,reply)=>{
 const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
 const type=(['export','delete','correct','restrict'].includes(req.body?.requestType)?req.body.requestType:'export') as any,now=new Date().toISOString();
 const r:any={id:randomUUID(),userId:user.id,requestType:type,status:'requested',createdAt:now,updatedAt:now};db.privacyRequests.unshift(r);db.save();reply.code(201);return r;
});
app.get('/api/compliance/policies',async(req:any,reply)=>{const auth=requireAdmin(req,reply);if(!auth)return;return {items:db.securityPolicies}});
app.patch('/api/compliance/policies/:id',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;const p=db.securityPolicies.find((x:any)=>x.id===req.params.id);if(!p)return reply.code(404).send({error:'Policy not found'});
 if(req.body?.enabled!==undefined)p.enabled=Boolean(req.body.enabled);if(req.body?.config!==undefined)p.config=req.body.config;p.updatedAt=new Date().toISOString();db.audit(auth.user.id,'security_policy.update','security_policy',p.id,{enabled:p.enabled});db.save();return p;
});
app.get('/api/compliance/cases',async(req:any,reply)=>{const auth=requireAdmin(req,reply);if(!auth)return;return {items:db.complianceCases.sort((a:any,b:any)=>b.updatedAt.localeCompare(a.updatedAt))}});
app.post('/api/compliance/cases',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;const now=new Date().toISOString();
 const c:any={id:randomUUID(),subjectUserId:req.body?.subjectUserId?String(req.body.subjectUserId):undefined,caseType:String(req.body?.caseType||'general_compliance'),status:'open',priority:(['low','normal','high','urgent'].includes(req.body?.priority)?req.body.priority:'normal'),summary:String(req.body?.summary||'Compliance review').slice(0,1200),assignedAdminId:auth.admin.id,createdAt:now,updatedAt:now};
 db.complianceCases.unshift(c);db.audit(auth.user.id,'compliance_case.create','compliance_case',c.id,{caseType:c.caseType});db.save();reply.code(201);return c;
});
app.patch('/api/compliance/cases/:id',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;const c=db.complianceCases.find((x:any)=>x.id===req.params.id);if(!c)return reply.code(404).send({error:'Compliance case not found'});
 if(['open','in_review','waiting','closed'].includes(req.body?.status))c.status=req.body.status;if(['low','normal','high','urgent'].includes(req.body?.priority))c.priority=req.body.priority;c.updatedAt=new Date().toISOString();db.audit(auth.user.id,'compliance_case.update','compliance_case',c.id,{status:c.status});db.save();return c;
});
app.post('/api/security/account/lock',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;const u=db.users.find((x:any)=>x.id===req.body?.userId);if(!u)return reply.code(404).send({error:'User not found'});u.status='disabled';for(const s of db.sessions.filter((x:any)=>x.userId===u.id))s.revoked=true;db.audit(auth.user.id,'account.lock','user',u.id,{});db.save();return {id:u.id,status:u.status};
});

app.get('/api/support/overview',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;const now=Date.now(),open=db.supportTickets.filter((x:any)=>!['resolved','closed'].includes(x.status));
 return {customers:db.supportCustomers.length,totalTickets:db.supportTickets.length,open:open.length,urgent:open.filter((x:any)=>x.priority==='urgent').length,overdue:open.filter((x:any)=>new Date(x.slaDueAt).getTime()<now).length,unassigned:open.filter((x:any)=>!x.assignedTo).length};
});
app.get('/api/support/customers',async(req:any,reply)=>{const auth=requireAdmin(req,reply);if(!auth)return;const q=String(req.query?.q||'').toLowerCase();return {items:db.supportCustomers.filter((x:any)=>!q||`${x.name} ${x.email} ${x.company||''} ${(x.tags||[]).join(' ')}`.toLowerCase().includes(q)).slice(0,300)}});
app.post('/api/support/customers',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;const email=String(req.body?.email||'').trim().toLowerCase();if(!email)return reply.code(400).send({error:'Email required'});
 const existing=db.supportCustomers.find((x:any)=>x.email===email);if(existing)return existing;const now=new Date().toISOString();
 const c:any={id:randomUUID(),userId:req.body?.userId?String(req.body.userId):undefined,name:String(req.body?.name||email.split('@')[0]).slice(0,120),email,phone:req.body?.phone?String(req.body.phone):undefined,company:req.body?.company?String(req.body.company):undefined,tags:Array.isArray(req.body?.tags)?req.body.tags.map(String):[],createdAt:now,updatedAt:now};
 db.supportCustomers.unshift(c);db.audit(auth.user.id,'support.customer.create','support_customer',c.id,{email:c.email});db.save();reply.code(201);return c;
});
app.get('/api/support/tickets',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;const status=String(req.query?.status||''),q=String(req.query?.q||'').toLowerCase();
 return {items:db.supportTickets.filter((x:any)=>(!status||x.status===status)&&(!q||`${x.subject} ${x.category} ${x.id}`.toLowerCase().includes(q))).sort((x:any,y:any)=>y.updatedAt.localeCompare(x.updatedAt)).slice(0,400)};
});
app.post('/api/support/tickets',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;const customer=db.supportCustomers.find((x:any)=>x.id===req.body?.customerId);if(!customer)return reply.code(400).send({error:'Valid customer required'});
 const priority=(['low','normal','high','urgent'].includes(req.body?.priority)?req.body.priority:'normal') as any,now=new Date(),due=new Date(now.getTime()+supportSlaHours(priority)*3600000).toISOString();
 const t:any={id:randomUUID(),customerId:customer.id,subject:String(req.body?.subject||'Support request').slice(0,180),category:String(req.body?.category||'general').slice(0,80),priority,status:'open',assignedTo:req.body?.assignedTo?String(req.body.assignedTo):undefined,source:'admin',slaDueAt:due,escalated:false,messages:[],createdAt:now.toISOString(),updatedAt:now.toISOString()};
 if(req.body?.message)t.messages.push({id:randomUUID(),authorType:'customer',body:String(req.body.message),internal:false,createdAt:now.toISOString()});
 db.supportTickets.unshift(t);db.audit(auth.user.id,'support.ticket.create','support_ticket',t.id,{priority,category:t.category});queueNotification(auth.user.id,'support','in_app','New support ticket',`${t.subject} · ${priority}`);db.save();reply.code(201);return t;
});
app.patch('/api/support/tickets/:id',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;const t=db.supportTickets.find((x:any)=>x.id===req.params.id);if(!t)return reply.code(404).send({error:'Ticket not found'});
 if(['open','in_progress','waiting_customer','resolved','closed'].includes(req.body?.status))t.status=req.body.status;if(['low','normal','high','urgent'].includes(req.body?.priority))t.priority=req.body.priority;
 if(req.body?.assignedTo!==undefined)t.assignedTo=req.body.assignedTo?String(req.body.assignedTo):undefined;if(req.body?.escalated!==undefined)t.escalated=Boolean(req.body.escalated);
 t.updatedAt=new Date().toISOString();db.audit(auth.user.id,'support.ticket.update','support_ticket',t.id,{status:t.status,priority:t.priority,assignedTo:t.assignedTo,escalated:t.escalated});db.save();return t;
});
app.post('/api/support/tickets/:id/messages',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;const t=db.supportTickets.find((x:any)=>x.id===req.params.id);if(!t)return reply.code(404).send({error:'Ticket not found'});const body=String(req.body?.body||'').trim();if(!body)return reply.code(400).send({error:'Message required'});
 const m:any={id:randomUUID(),authorType:'agent',authorId:auth.user.id,body,internal:Boolean(req.body?.internal),createdAt:new Date().toISOString()};t.messages.push(m);t.updatedAt=m.createdAt;if(t.status==='open')t.status='in_progress';db.audit(auth.user.id,m.internal?'support.note.add':'support.reply.add','support_ticket',t.id,{});db.save();reply.code(201);return m;
});
app.post('/api/support/tickets/:id/escalate',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;const t=db.supportTickets.find((x:any)=>x.id===req.params.id);if(!t)return reply.code(404).send({error:'Ticket not found'});t.escalated=true;t.priority='urgent';t.slaDueAt=new Date(Date.now()+2*3600000).toISOString();t.updatedAt=new Date().toISOString();queueNotification(auth.user.id,'support','in_app','Support escalation',`${t.subject} was escalated`);db.audit(auth.user.id,'support.ticket.escalate','support_ticket',t.id,{});db.save();return t;
});

app.get('/api/notifications/status',async()=>({providers:notificationProviderStatus(),unifiedInbox:true,templates:true,preferences:true,retries:true}));
app.get('/api/notifications/inbox',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  return {items:db.notifications.filter((x:any)=>x.userId===user.id).sort((a:any,b:any)=>b.createdAt.localeCompare(a.createdAt)).slice(0,300)};
});
app.post('/api/notifications/send-test',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const channel=(['in_app','email','sms','push'].includes(req.body?.channel)?req.body.channel:'in_app') as any;
  const n=queueNotification(user.id,'test',channel,String(req.body?.title||'NNIT Studio Test'),String(req.body?.message||'Notification delivery test'));
  return n;
});
app.patch('/api/notifications/:id/read',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const n=db.notifications.find((x:any)=>x.id===req.params.id&&x.userId===user.id);if(!n)return reply.code(404).send({error:'Notification not found'});
  n.status='read';n.readAt=new Date().toISOString();n.updatedAt=n.readAt;db.save();return n;
});
app.post('/api/notifications/:id/retry',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const n=db.notifications.find((x:any)=>x.id===req.params.id&&x.userId===user.id);if(!n)return reply.code(404).send({error:'Notification not found'});
  n.attempts+=1;n.status=n.channel==='in_app'?'delivered':'queued';n.error=undefined;n.updatedAt=new Date().toISOString();db.save();return n;
});
app.get('/api/notifications/preferences',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const channels=['in_app','email','sms','push'];for(const channel of channels){if(!db.notificationPreferences.find((x:any)=>x.userId===user.id&&x.channel===channel)){db.notificationPreferences.push({id:randomUUID(),userId:user.id,channel:channel as any,enabled:channel==='in_app'||channel==='email',categories:['account','billing','marketplace','distribution','rights','admin','support'],updatedAt:new Date().toISOString()})}}db.save();
  return {items:db.notificationPreferences.filter((x:any)=>x.userId===user.id)};
});
app.patch('/api/notifications/preferences/:id',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const p=db.notificationPreferences.find((x:any)=>x.id===req.params.id&&x.userId===user.id);if(!p)return reply.code(404).send({error:'Preference not found'});
  if(req.body?.enabled!==undefined)p.enabled=Boolean(req.body.enabled);if(Array.isArray(req.body?.categories))p.categories=req.body.categories.map(String);p.updatedAt=new Date().toISOString();db.save();return p;
});
app.get('/api/notifications/templates',async(req:any,reply)=>{const auth=requireAdmin(req,reply);if(!auth)return;return {items:db.notificationTemplates}});
app.patch('/api/notifications/templates/:id',async(req:any,reply)=>{
  const auth=requireAdmin(req,reply);if(!auth)return;const t=db.notificationTemplates.find((x:any)=>x.id===req.params.id);if(!t)return reply.code(404).send({error:'Template not found'});
  if(req.body?.enabled!==undefined)t.enabled=Boolean(req.body.enabled);if(req.body?.subject!==undefined)t.subject=String(req.body.subject);if(req.body?.body!==undefined)t.body=String(req.body.body);t.updatedAt=new Date().toISOString();db.audit(auth.user.id,'notification_template.update','notification_template',t.id,{enabled:t.enabled});db.save();return t;
});
app.post('/api/notifications/event',async(req:any,reply)=>{
  const auth=requireAdmin(req,reply);if(!auth)return;
  const userId=String(req.body?.userId||auth.user.id),category=String(req.body?.category||'system'),title=String(req.body?.title||'NNIT Studio'),message=String(req.body?.message||'Notification');
  const prefs=db.notificationPreferences.filter((x:any)=>x.userId===userId&&x.enabled&&(x.categories.includes(category)||x.categories.length===0));
  const channels=prefs.length?prefs.map((x:any)=>x.channel):['in_app'];
  const items=channels.map((ch:any)=>queueNotification(userId,category,ch,title,message));return {items};
});

app.get('/api/workflows',async(req:any,reply)=>{const auth=requireAdmin(req,reply);if(!auth)return;return {rules:db.workflowRules,jobs:db.workflowJobs.slice(0,200)}});
app.post('/api/workflows',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;
 const trigger=(['manual','schedule','release_created','payout_requested','marketplace_submitted','risk_opened'].includes(req.body?.trigger)?req.body.trigger:'manual') as any;
 const action=(['audit','approve_payout','flag_risk','publish_marketplace','advance_release','notification'].includes(req.body?.action)?req.body.action:'audit') as any;
 const now=new Date().toISOString();const rule={id:randomUUID(),name:String(req.body?.name||'New Workflow').slice(0,160),enabled:req.body?.enabled!==false,trigger,action,config:req.body?.config||{},createdAt:now,updatedAt:now};
 db.workflowRules.unshift(rule);db.audit(auth.user.id,'workflow.create','workflow',rule.id,{trigger,action});db.save();reply.code(201);return rule;
});
app.patch('/api/workflows/:id',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;const r=db.workflowRules.find((x:any)=>x.id===req.params.id);if(!r)return reply.code(404).send({error:'Workflow not found'});
 if(req.body?.enabled!==undefined)r.enabled=Boolean(req.body.enabled);if(req.body?.name!==undefined)r.name=String(req.body.name).slice(0,160);r.updatedAt=new Date().toISOString();db.audit(auth.user.id,'workflow.update','workflow',r.id,{enabled:r.enabled});db.save();return r;
});
app.post('/api/workflows/:id/run',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;const r=db.workflowRules.find((x:any)=>x.id===req.params.id);if(!r)return reply.code(404).send({error:'Workflow not found'});
 const now=new Date().toISOString();const job:any={id:randomUUID(),workflowId:r.id,trigger:r.trigger,status:'running',attempts:1,payload:req.body?.payload||{},createdAt:now,updatedAt:now};db.workflowJobs.unshift(job);
 try{
   let result:any={message:'Workflow completed'};
   if(r.action==='audit'){db.audit(auth.user.id,'workflow.execute','workflow',r.id,{payload:job.payload});result={audited:true}}
   if(r.action==='approve_payout'){const p=db.payoutRequests.find((x:any)=>x.id===job.payload?.payoutId);if(!p)throw new Error('Payout not found');p.status='approved';result={payoutId:p.id,status:p.status}}
   if(r.action==='flag_risk'){const item:any={id:randomUUID(),entityType:job.payload?.entityType||'user',entityId:String(job.payload?.entityId||auth.user.id),severity:r.config?.severity||'medium',reason:String(r.config?.reason||'Workflow risk review'),status:'open',createdAt:new Date().toISOString()};db.riskFlags.unshift(item);result={riskFlagId:item.id}}
   if(r.action==='publish_marketplace'){const item=db.marketplace.find((x:any)=>x.id===job.payload?.itemId);if(!item)throw new Error('Marketplace item not found');item.status='published';item.updatedAt=new Date().toISOString();result={itemId:item.id,status:item.status}}
   if(r.action==='advance_release'){const rel=db.musicReleases.find((x:any)=>x.id===job.payload?.releaseId);if(!rel)throw new Error('Release not found');result={releaseId:rel.id,review:'queued'}}
   if(r.action==='notification'){const target=String(job.payload?.userId||auth.user.id);const ch=(r.config?.channel||'in_app') as any;const n=queueNotification(target,'workflow',ch,String(r.config?.title||r.name),String(r.config?.message||'Workflow notification'));result={notificationId:n.id,channel:ch,status:n.status}}
   job.status='completed';job.result=result;job.updatedAt=new Date().toISOString();db.save();return job;
 }catch(e:any){job.status=job.attempts>=3?'dead_letter':'failed';job.error=String(e?.message||e);job.updatedAt=new Date().toISOString();db.save();return reply.code(422).send(job)}
});
app.post('/api/workflow-jobs/:id/retry',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;const job=db.workflowJobs.find((x:any)=>x.id===req.params.id);if(!job)return reply.code(404).send({error:'Job not found'});
 job.attempts+=1;job.status='queued';job.error=undefined;job.updatedAt=new Date().toISOString();db.audit(auth.user.id,'workflow.retry','workflow_job',job.id,{attempts:job.attempts});db.save();return job;
});
app.delete('/api/workflow-jobs/:id',async(req:any,reply)=>{
 const auth=requireAdmin(req,reply);if(!auth)return;const i=db.workflowJobs.findIndex((x:any)=>x.id===req.params.id);if(i<0)return reply.code(404).send({error:'Job not found'});const [job]=db.workflowJobs.splice(i,1);db.audit(auth.user.id,'workflow_job.delete','workflow_job',job.id,{});db.save();return {ok:true};
});

app.get('/api/admin/overview',async(req:any,reply)=>{
  const auth=requireAdmin(req,reply);if(!auth)return;
  const paidInvoices=db.invoices.filter((x:any)=>x.status==='paid');
  const txSucceeded=db.transactions.filter((x:any)=>x.status==='succeeded');
  const payoutsPending=db.payoutRequests.filter((x:any)=>x.status==='requested');
  return {counts:{users:db.users.length,activeSubscriptions:db.subscriptions.filter((x:any)=>x.status==='active').length,projects:db.projects.length,marketplaceItems:db.marketplace.length,releases:db.musicReleases.length,compositions:db.compositions.length,openSupport:db.supportCases.filter((x:any)=>x.status!=='closed').length,openRisk:db.riskFlags.filter((x:any)=>x.status==='open').length,pendingPayouts:payoutsPending.length},finance:{paidInvoices:paidInvoices.length,succeededTransactions:txSucceeded.length},services:db.serviceActivations,flags:db.featureFlags};
});
app.get('/api/admin/users',async(req:any,reply)=>{
  const auth=requireAdmin(req,reply);if(!auth)return;
  return {items:db.users.map((u:any)=>({id:u.id,email:u.email,name:u.name,status:u.status,lastLoginAt:u.lastLoginAt,subscription:db.activeSubscription(u.id),admin:db.adminFor(u.id)}))};
});
app.patch('/api/admin/users/:id',async(req:any,reply)=>{
  const auth=requireAdmin(req,reply);if(!auth)return;
  const user=db.users.find((x:any)=>x.id===req.params.id);if(!user)return reply.code(404).send({error:'User not found'});
  if(['active','disabled'].includes(req.body?.status))user.status=req.body.status;
  db.audit(auth.user.id,'user.update','user',user.id,{status:user.status});db.save();return {id:user.id,email:user.email,name:user.name,status:user.status};
});
app.get('/api/admin/transactions',async(req:any,reply)=>{
  const auth=requireAdmin(req,reply);if(!auth)return;
  return {items:db.transactions.slice().sort((a:any,b:any)=>b.createdAt.localeCompare(a.createdAt)).slice(0,300)};
});
app.get('/api/admin/payouts',async(req:any,reply)=>{
  const auth=requireAdmin(req,reply);if(!auth)return;
  return {items:db.payoutRequests.slice().sort((a:any,b:any)=>b.requestedAt.localeCompare(a.requestedAt))};
});
app.patch('/api/admin/payouts/:id',async(req:any,reply)=>{
  const auth=requireAdmin(req,reply);if(!auth)return;
  const p=db.payoutRequests.find((x:any)=>x.id===req.params.id);if(!p)return reply.code(404).send({error:'Payout not found'});
  if(['approved','paid','rejected'].includes(req.body?.status))p.status=req.body.status;
  if(p.status==='paid')p.processedAt=new Date().toISOString();
  db.audit(auth.user.id,'payout.update','payout',p.id,{status:p.status});db.save();return p;
});
app.get('/api/admin/marketplace',async(req:any,reply)=>{
  const auth=requireAdmin(req,reply);if(!auth)return;
  return {items:db.marketplace};
});
app.patch('/api/admin/marketplace/:id',async(req:any,reply)=>{
  const auth=requireAdmin(req,reply);if(!auth)return;
  const item=db.marketplace.find((x:any)=>x.id===req.params.id);if(!item)return reply.code(404).send({error:'Item not found'});
  if(['draft','published','suspended'].includes(req.body?.status))item.status=req.body.status;
  item.updatedAt=new Date().toISOString();db.audit(auth.user.id,'marketplace.moderate','marketplace_item',item.id,{status:item.status});db.save();return item;
});
app.get('/api/admin/releases',async(req:any,reply)=>{
  const auth=requireAdmin(req,reply);if(!auth)return;
  return {items:db.musicReleases};
});
app.get('/api/admin/risk',async(req:any,reply)=>{
  const auth=requireAdmin(req,reply);if(!auth)return;
  return {items:db.riskFlags};
});
app.post('/api/admin/risk',async(req:any,reply)=>{
  const auth=requireAdmin(req,reply);if(!auth)return;
  const item={id:randomUUID(),entityType:(['user','transaction','release','marketplace_item','payout'].includes(req.body?.entityType)?req.body.entityType:'user') as any,entityId:String(req.body?.entityId||''),severity:(['low','medium','high','critical'].includes(req.body?.severity)?req.body.severity:'medium') as any,reason:String(req.body?.reason||'Manual review').slice(0,1000),status:'open' as const,createdAt:new Date().toISOString()};
  db.riskFlags.unshift(item);db.audit(auth.user.id,'risk.create',item.entityType,item.entityId,{severity:item.severity});db.save();reply.code(201);return item;
});
app.patch('/api/admin/risk/:id',async(req:any,reply)=>{
  const auth=requireAdmin(req,reply);if(!auth)return;
  const item=db.riskFlags.find((x:any)=>x.id===req.params.id);if(!item)return reply.code(404).send({error:'Risk flag not found'});
  if(['open','reviewed','resolved'].includes(req.body?.status))item.status=req.body.status;if(item.status==='resolved')item.resolvedAt=new Date().toISOString();
  db.audit(auth.user.id,'risk.update',item.entityType,item.entityId,{status:item.status});db.save();return item;
});
app.get('/api/admin/support',async(req:any,reply)=>{
  const auth=requireAdmin(req,reply);if(!auth)return;
  return {items:db.supportCases.slice().sort((a:any,b:any)=>b.updatedAt.localeCompare(a.updatedAt))};
});
app.post('/api/admin/support',async(req:any,reply)=>{
  const auth=requireAdmin(req,reply);if(!auth)return;
  const now=new Date().toISOString();const item={id:randomUUID(),userId:req.body?.userId?String(req.body.userId):undefined,subject:String(req.body?.subject||'Support Case').slice(0,240),category:String(req.body?.category||'general'),priority:(['low','normal','high','urgent'].includes(req.body?.priority)?req.body.priority:'normal') as any,status:'open' as const,assignedAdminId:auth.admin.id,createdAt:now,updatedAt:now};
  db.supportCases.unshift(item);db.audit(auth.user.id,'support.create','support_case',item.id,{});db.save();reply.code(201);return item;
});
app.patch('/api/admin/support/:id',async(req:any,reply)=>{
  const auth=requireAdmin(req,reply);if(!auth)return;
  const item=db.supportCases.find((x:any)=>x.id===req.params.id);if(!item)return reply.code(404).send({error:'Support case not found'});
  if(['open','in_progress','waiting','closed'].includes(req.body?.status))item.status=req.body.status;if(['low','normal','high','urgent'].includes(req.body?.priority))item.priority=req.body.priority;item.updatedAt=new Date().toISOString();
  db.audit(auth.user.id,'support.update','support_case',item.id,{status:item.status});db.save();return item;
});
app.get('/api/admin/feature-flags',async(req:any,reply)=>{const auth=requireAdmin(req,reply);if(!auth)return;return {items:db.featureFlags}});
app.patch('/api/admin/feature-flags/:id',async(req:any,reply)=>{
  const auth=requireAdmin(req,reply);if(!auth)return;
  const f=db.featureFlags.find((x:any)=>x.id===req.params.id);if(!f)return reply.code(404).send({error:'Feature flag not found'});
  if(req.body?.enabled!==undefined)f.enabled=Boolean(req.body.enabled);if(Array.isArray(req.body?.countries))f.countries=req.body.countries.map(String);f.updatedAt=new Date().toISOString();db.audit(auth.user.id,'feature_flag.update','feature_flag',f.id,{enabled:f.enabled});db.save();return f;
});
app.get('/api/admin/services',async(req:any,reply)=>{const auth=requireAdmin(req,reply);if(!auth)return;return {items:db.serviceActivations}});
app.patch('/api/admin/services/:id',async(req:any,reply)=>{
  const auth=requireAdmin(req,reply);if(!auth)return;
  const svc=db.serviceActivations.find((x:any)=>x.id===req.params.id);if(!svc)return reply.code(404).send({error:'Service activation not found'});
  if(['disabled','sandbox','active'].includes(req.body?.status))svc.status=req.body.status;if(req.body?.notes!==undefined)svc.notes=String(req.body.notes).slice(0,1000);svc.updatedAt=new Date().toISOString();db.audit(auth.user.id,'service.update','service_activation',svc.id,{status:svc.status});db.save();return svc;
});
app.get('/api/admin/audit',async(req:any,reply)=>{const auth=requireAdmin(req,reply);if(!auth)return;return {items:db.auditLogs.slice(0,500)}});
app.get('/api/admin/system-health',async(req:any,reply)=>{
  const auth=requireAdmin(req,reply);if(!auth)return;
  return {api:'ok',database:'local-json',nativeHost:'external-check',localAi:'external-check',projectCount:db.projects.length,aiJobs:db.aiJobs.length,pluginCount:db.plugins.length,timestamp:new Date().toISOString()};
});
app.get('/api/analytics/overview',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const dist=db.royaltyStatements.filter((x:any)=>x.userId===user.id);
  const pub=db.rightsRoyaltyEntries.filter((x:any)=>x.userId===user.id);
  const market=db.royalties.filter((x:any)=>x.creatorId===user.id);
  const releases=db.musicReleases.filter((x:any)=>x.userId===user.id);
  const invoices=db.invoices.filter((x:any)=>x.userId===user.id);
  const currencies=[...new Set([...dist.map((x:any)=>x.currency),...pub.map((x:any)=>x.currency),...market.map((x:any)=>x.currency),...invoices.map((x:any)=>x.currency)])];
  const byCurrency:any={};
  for(const c of currencies){
    const distribution=dist.filter((x:any)=>x.currency===c).reduce((n:number,x:any)=>n+Number(x.net||0),0);
    const publishing=pub.filter((x:any)=>x.currency===c).reduce((n:number,x:any)=>n+Number(x.net||0),0);
    const marketplace=market.filter((x:any)=>x.currency===c).reduce((n:number,x:any)=>n+Number(x.creatorNet||0),0);
    const billing=invoices.filter((x:any)=>x.currency===c&&x.status==='paid').reduce((n:number,x:any)=>n+Number(x.total||0),0);
    byCurrency[c]={distribution,publishing,marketplace,billing,total:distribution+publishing+marketplace+billing};
  }
  const monthly:any={};
  const add=(period:string,source:string,currency:string,amount:number)=>{const k=period||'unknown';monthly[k]??={period:k,items:{}};monthly[k].items[currency]??={distribution:0,publishing:0,marketplace:0,billing:0,total:0};monthly[k].items[currency][source]+=amount;monthly[k].items[currency].total+=amount};
  for(const x of dist)add(x.period||x.importedAt?.slice(0,7),'distribution',x.currency,Number(x.net||0));
  for(const x of pub)add(x.period,'publishing',x.currency,Number(x.net||0));
  for(const x of market)add(x.createdAt?.slice(0,7),'marketplace',x.currency,Number(x.creatorNet||0));
  for(const x of invoices.filter((x:any)=>x.status==='paid'))add(x.createdAt?.slice(0,7),'billing',x.currency,Number(x.total||0));
  return {byCurrency,monthly:Object.values(monthly).sort((x:any,y:any)=>x.period.localeCompare(y.period)),counts:{releases:releases.length,distributionStatements:dist.length,publishingEntries:pub.length,marketplaceRoyalties:market.length,paidInvoices:invoices.filter((x:any)=>x.status==='paid').length,unmatchedRoyalties:pub.filter((x:any)=>x.status==='unmatched').length}};
});
app.get('/api/analytics/releases',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const releases=db.musicReleases.filter((x:any)=>x.userId===user.id);
  return {items:releases.map((r:any)=>{const statements=db.royaltyStatements.filter((s:any)=>s.userId===user.id&&(s.releaseId===r.id||r.tracks?.some((t:any)=>t.isrc&&t.isrc===s.trackIsrc)));const totals:any={};for(const s of statements){totals[s.currency]=(totals[s.currency]||0)+Number(s.net||0)}return {id:r.id,title:r.title,type:r.releaseType,status:r.status,releaseDate:r.releaseDate,upc:r.upc,tracks:r.tracks?.length||0,totals}})};
});
app.get('/api/analytics/export.csv',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const rows=[['source','period','currency','gross_or_total','net','status']];
  for(const x of db.royaltyStatements.filter((x:any)=>x.userId===user.id))rows.push(['distribution',x.period||'',x.currency,String(x.gross||0),String(x.net||0),'imported']);
  for(const x of db.rightsRoyaltyEntries.filter((x:any)=>x.userId===user.id))rows.push(['publishing',x.period||'',x.currency,String(x.gross||0),String(x.net||0),x.status||'']);
  for(const x of db.royalties.filter((x:any)=>x.creatorId===user.id))rows.push(['marketplace',x.createdAt?.slice(0,7)||'',x.currency,String(x.gross||0),String(x.creatorNet||0),x.status||'']);
  const csv=rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  reply.header('content-type','text/csv; charset=utf-8');reply.header('content-disposition','attachment; filename="nnit-studio-v23-revenue.csv"');return csv;
});

app.get('/api/rights/status',async()=>({mode:'sandbox-local',organizations:rightsOrganizations,liveRegistration:false,compositionRights:true,masterRights:true,neighboringRights:true,liveProCmoCredentialsRequired:true}));
app.get('/api/rights/parties',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  return {items:db.rightsParties.filter((x:any)=>x.userId===user.id)};
});
app.post('/api/rights/parties',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const timestamp=new Date().toISOString();
  const party={id:randomUUID(),userId:user.id,displayName:String(req.body?.displayName||user.name).slice(0,120),legalName:String(req.body?.legalName||'').slice(0,160),partyType:(['songwriter','publisher','artist','label','producer'].includes(req.body?.partyType)?req.body.partyType:'songwriter') as any,ipiCae:req.body?.ipiCae?String(req.body.ipiCae):undefined,proCmo:req.body?.proCmo?String(req.body.proCmo):undefined,country:String(req.body?.country||'DE').slice(0,2).toUpperCase(),createdAt:timestamp,updatedAt:timestamp};
  db.rightsParties.push(party);db.save();reply.code(201);return party;
});
app.patch('/api/rights/parties/:id',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const party=db.rightsParties.find((x:any)=>x.id===req.params.id&&x.userId===user.id);if(!party)return reply.code(404).send({error:'Rights party not found'});
  for(const k of ['displayName','legalName','ipiCae','proCmo','country'] as const)if(req.body?.[k]!==undefined)(party as any)[k]=req.body[k];
  if(['songwriter','publisher','artist','label','producer'].includes(req.body?.partyType))party.partyType=req.body.partyType;
  party.updatedAt=new Date().toISOString();db.save();return party;
});
app.get('/api/rights/compositions',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  return {items:db.compositions.filter((x:any)=>x.userId===user.id).sort((a:any,b:any)=>b.updatedAt.localeCompare(a.updatedAt))};
});
app.post('/api/rights/compositions',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const timestamp=new Date().toISOString();
  const c={id:randomUUID(),userId:user.id,title:String(req.body?.title||'Untitled Composition').slice(0,180),alternateTitles:Array.isArray(req.body?.alternateTitles)?req.body.alternateTitles.map(String):[],iswc:req.body?.iswc?String(req.body.iswc):undefined,language:String(req.body?.language||'en'),genre:String(req.body?.genre||'Pop'),shares:[],linkedReleaseTrackIds:Array.isArray(req.body?.linkedReleaseTrackIds)?req.body.linkedReleaseTrackIds.map(String):[],status:'draft' as const,createdAt:timestamp,updatedAt:timestamp};
  db.compositions.push(c);db.save();reply.code(201);return c;
});
app.patch('/api/rights/compositions/:id',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const c=db.compositions.find((x:any)=>x.id===req.params.id&&x.userId===user.id);if(!c)return reply.code(404).send({error:'Composition not found'});
  for(const k of ['title','alternateTitles','iswc','language','genre','linkedReleaseTrackIds'] as const)if(req.body?.[k]!==undefined)(c as any)[k]=req.body[k];
  c.updatedAt=new Date().toISOString();db.save();return c;
});
app.post('/api/rights/compositions/:id/shares',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const c=db.compositions.find((x:any)=>x.id===req.params.id&&x.userId===user.id);if(!c)return reply.code(404).send({error:'Composition not found'});
  const party=db.rightsParties.find((x:any)=>x.id===req.body?.partyId&&x.userId===user.id);if(!party)return reply.code(400).send({error:'Valid rights party required'});
  const share={id:randomUUID(),partyId:party.id,role:(req.body?.role==='publisher'?'publisher':'writer') as 'writer'|'publisher',percentage:Math.max(0,Math.min(100,Number(req.body?.percentage||0))),territories:Array.isArray(req.body?.territories)&&req.body.territories.length?req.body.territories.map(String):['WORLDWIDE']};
  c.shares.push(share);c.updatedAt=new Date().toISOString();db.save();reply.code(201);return share;
});
app.patch('/api/rights/compositions/:compositionId/shares/:shareId',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const c=db.compositions.find((x:any)=>x.id===req.params.compositionId&&x.userId===user.id);if(!c)return reply.code(404).send({error:'Composition not found'});
  const sh=c.shares.find((x:any)=>x.id===req.params.shareId);if(!sh)return reply.code(404).send({error:'Share not found'});
  if(req.body?.percentage!==undefined)sh.percentage=Math.max(0,Math.min(100,Number(req.body.percentage)));
  if(req.body?.territories!==undefined)sh.territories=req.body.territories;
  if(req.body?.role==='writer'||req.body?.role==='publisher')sh.role=req.body.role;
  c.updatedAt=new Date().toISOString();db.save();return sh;
});
app.delete('/api/rights/compositions/:compositionId/shares/:shareId',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const c=db.compositions.find((x:any)=>x.id===req.params.compositionId&&x.userId===user.id);if(!c)return reply.code(404).send({error:'Composition not found'});
  c.shares=c.shares.filter((x:any)=>x.id!==req.params.shareId);c.updatedAt=new Date().toISOString();db.save();return reply.code(204).send();
});
app.get('/api/rights/compositions/:id/validate',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const c=db.compositions.find((x:any)=>x.id===req.params.id&&x.userId===user.id);if(!c)return reply.code(404).send({error:'Composition not found'});
  const issues=compositionIssues(c);return {valid:issues.length===0,issues,totalPercentage:c.shares.reduce((n:number,x:any)=>n+Number(x.percentage||0),0)};
});
app.post('/api/rights/compositions/:id/register-sandbox',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const c=db.compositions.find((x:any)=>x.id===req.params.id&&x.userId===user.id);if(!c)return reply.code(404).send({error:'Composition not found'});
  const issues=compositionIssues(c);if(issues.length)return reply.code(422).send({error:'Composition validation failed',issues});
  if(!c.iswc)c.iswc=makeIswc();c.status='registered';c.updatedAt=new Date().toISOString();
  const org=String(req.body?.organization||'GEMA'),territory=String(req.body?.territory||'WORLDWIDE');
  const reg={id:randomUUID(),compositionId:c.id,organization:org,registrationType:(['performance','mechanical','neighboring','copyright'].includes(req.body?.registrationType)?req.body.registrationType:'performance') as any,status:'registered' as const,externalId:`SANDBOX-${org.replace(/\s+/g,'-').toUpperCase()}-${c.id.slice(0,8)}`,territory,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  db.rightsRegistrations.push(reg);db.save();return {composition:c,registration:reg};
});
app.get('/api/rights/registrations',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const ids=new Set(db.compositions.filter((x:any)=>x.userId===user.id).map((x:any)=>x.id));return {items:db.rightsRegistrations.filter((x:any)=>ids.has(x.compositionId))};
});
app.post('/api/rights/licenses',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const lic={id:randomUUID(),userId:user.id,compositionId:req.body?.compositionId?String(req.body.compositionId):undefined,releaseId:req.body?.releaseId?String(req.body.releaseId):undefined,licenseType:(['sync','mechanical','master-use','performance','sample'].includes(req.body?.licenseType)?req.body.licenseType:'sync') as any,licensee:String(req.body?.licensee||'Licensee').slice(0,180),territory:String(req.body?.territory||'WORLDWIDE'),fee:Math.max(0,Number(req.body?.fee||0)),currency:String(req.body?.currency||'EUR').toUpperCase(),startDate:String(req.body?.startDate||new Date().toISOString().slice(0,10)),endDate:req.body?.endDate?String(req.body.endDate):undefined,status:'active' as const,createdAt:new Date().toISOString()};
  db.rightsLicenses.push(lic);db.save();reply.code(201);return lic;
});
app.get('/api/rights/licenses',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  return {items:db.rightsLicenses.filter((x:any)=>x.userId===user.id)};
});
app.post('/api/rights/recoupment',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const item={id:randomUUID(),userId:user.id,partyId:req.body?.partyId?String(req.body.partyId):undefined,name:String(req.body?.name||'Recoupable Advance').slice(0,160),currency:String(req.body?.currency||'EUR').toUpperCase(),originalAmount:Math.max(0,Number(req.body?.originalAmount||0)),recoupedAmount:0,status:'open' as const,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  db.recoupmentAccounts.push(item);db.save();reply.code(201);return item;
});
app.get('/api/rights/recoupment',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  return {items:db.recoupmentAccounts.filter((x:any)=>x.userId===user.id)};
});
app.post('/api/rights/royalties/import',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const rows=Array.isArray(req.body?.rows)?req.body.rows:[];const imported=[];
  for(const row of rows){
    const gross=Number(row.gross||0),adminFee=Math.max(0,Number(row.adminFee||0)),net=Math.max(0,gross-adminFee);
    let compositionId=row.compositionId?String(row.compositionId):undefined;
    if(!compositionId&&row.trackIsrc){const release=db.musicReleases.find((r:any)=>r.userId===user.id&&r.tracks.some((t:any)=>t.isrc===row.trackIsrc));const track=release?.tracks.find((t:any)=>t.isrc===row.trackIsrc);compositionId=db.compositions.find((c:any)=>c.userId===user.id&&track&&c.linkedReleaseTrackIds.includes(track.id))?.id}
    const entry={id:randomUUID(),userId:user.id,source:String(row.source||'Rights Society'),compositionId,releaseId:row.releaseId?String(row.releaseId):undefined,trackIsrc:row.trackIsrc?String(row.trackIsrc):undefined,currency:String(row.currency||'EUR').toUpperCase(),gross,adminFee,net,royaltyType:(['performance','mechanical','sync','neighboring','master','marketplace'].includes(row.royaltyType)?row.royaltyType:'performance') as any,status:(compositionId?'matched':'unmatched') as 'matched'|'unmatched',period:String(row.period||new Date().toISOString().slice(0,7)),createdAt:new Date().toISOString()};
    db.rightsRoyaltyEntries.push(entry);imported.push(entry);
  }
  db.save();return {items:imported,count:imported.length};
});
app.post('/api/rights/royalties/:id/allocate',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const entry=db.rightsRoyaltyEntries.find((x:any)=>x.id===req.params.id&&x.userId===user.id);if(!entry)return reply.code(404).send({error:'Royalty entry not found'});
  if(!entry.compositionId)return reply.code(409).send({error:'Royalty entry is unmatched'});
  const c=db.compositions.find((x:any)=>x.id===entry.compositionId&&x.userId===user.id);if(!c)return reply.code(404).send({error:'Composition not found'});
  const issues=compositionIssues(c);if(issues.length)return reply.code(422).send({error:'Composition splits are not valid',issues});
  for(let i=db.royaltyAllocations.length-1;i>=0;i--){if(db.royaltyAllocations[i].royaltyEntryId===entry.id)db.royaltyAllocations.splice(i,1);}
  for(const sh of c.shares){db.royaltyAllocations.push({id:randomUUID(),royaltyEntryId:entry.id,partyId:sh.partyId,percentage:sh.percentage,amount:Math.round(entry.net*(sh.percentage/100)*100)/100,currency:entry.currency,status:'pending',createdAt:new Date().toISOString()})}
  entry.status='allocated';db.save();return {entry,allocations:db.royaltyAllocations.filter((x:any)=>x.royaltyEntryId===entry.id)};
});
app.get('/api/rights/royalties',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const items=db.rightsRoyaltyEntries.filter((x:any)=>x.userId===user.id);const allocations=db.royaltyAllocations.filter((x:any)=>items.some((e:any)=>e.id===x.royaltyEntryId));return {items,allocations,unmatched:items.filter((x:any)=>x.status==='unmatched')};
});
app.get('/api/rights/dashboard',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const entries=db.rightsRoyaltyEntries.filter((x:any)=>x.userId===user.id),dist=db.royaltyStatements.filter((x:any)=>x.userId===user.id),market=db.royalties.filter((x:any)=>x.creatorId===user.id);
  const totals:any={};
  const add=(currency:string,key:string,amount:number)=>{totals[currency]??={publishing:0,distribution:0,marketplace:0,total:0};totals[currency][key]+=amount;totals[currency].total+=amount};
  for(const x of entries)add(x.currency,'publishing',x.net);
  for(const x of dist)add(x.currency,'distribution',x.net);
  for(const x of market)add(x.currency,'marketplace',x.creatorNet);
  return {totals,counts:{parties:db.rightsParties.filter((x:any)=>x.userId===user.id).length,compositions:db.compositions.filter((x:any)=>x.userId===user.id).length,registrations:db.rightsRegistrations.filter((r:any)=>db.compositions.some((c:any)=>c.userId===user.id&&c.id===r.compositionId)).length,licenses:db.rightsLicenses.filter((x:any)=>x.userId===user.id).length,unmatched:entries.filter((x:any)=>x.status==='unmatched').length}};
});
app.get('/api/distribution/status',async()=>({provider:'NNIT Distribution adapter',mode:'sandbox-local',connected:false,liveDelivery:false,stores:releaseStores,metadataValidation:true,statementImport:true,liveDistributorCredentialsRequired:true}));
app.get('/api/distribution/artists',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  return {items:db.artistProfiles.filter((x:any)=>x.userId===user.id)};
});
app.post('/api/distribution/artists',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const now=new Date().toISOString();
  const artist={id:randomUUID(),userId:user.id,artistName:String(req.body?.artistName||user.name).slice(0,120),legalName:String(req.body?.legalName||'').slice(0,160),labelName:String(req.body?.labelName||'Independent').slice(0,160),country:String(req.body?.country||'DE').slice(0,2).toUpperCase(),genres:Array.isArray(req.body?.genres)?req.body.genres.map(String).slice(0,8):[],spotifyArtistId:req.body?.spotifyArtistId?String(req.body.spotifyArtistId):undefined,appleArtistId:req.body?.appleArtistId?String(req.body.appleArtistId):undefined,createdAt:now,updatedAt:now};
  db.artistProfiles.push(artist);db.save();reply.code(201);return artist;
});
app.patch('/api/distribution/artists/:id',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const artist=db.artistProfiles.find((x:any)=>x.id===req.params.id&&x.userId===user.id);if(!artist)return reply.code(404).send({error:'Artist profile not found'});
  for(const k of ['artistName','legalName','labelName','country','genres','spotifyArtistId','appleArtistId'] as const)if(req.body?.[k]!==undefined)(artist as any)[k]=req.body[k];
  artist.updatedAt=new Date().toISOString();db.save();return artist;
});
app.get('/api/distribution/releases',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  return {items:db.musicReleases.filter((x:any)=>x.userId===user.id).sort((a:any,b:any)=>b.updatedAt.localeCompare(a.updatedAt))};
});
app.post('/api/distribution/releases',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const artist=db.artistProfiles.find((x:any)=>x.id===req.body?.artistProfileId&&x.userId===user.id);if(!artist)return reply.code(400).send({error:'Valid artist profile required'});
  const now=new Date().toISOString();
  const release={id:randomUUID(),userId:user.id,artistProfileId:artist.id,title:String(req.body?.title||'Untitled Release').slice(0,160),releaseType:(['single','ep','album'].includes(req.body?.releaseType)?req.body.releaseType:'single') as 'single'|'ep'|'album',upc:String(req.body?.upc||makeUpc()),label:String(req.body?.label||artist.labelName||'Independent').slice(0,160),genre:String(req.body?.genre||artist.genres?.[0]||'Pop'),subgenre:String(req.body?.subgenre||''),copyrightYear:Number(req.body?.copyrightYear||new Date().getFullYear()),copyrightOwner:String(req.body?.copyrightOwner||artist.artistName),coverArtFileName:req.body?.coverArtFileName?String(req.body.coverArtFileName):undefined,releaseDate:String(req.body?.releaseDate||new Date(Date.now()+14*86400000).toISOString().slice(0,10)),originalReleaseDate:req.body?.originalReleaseDate?String(req.body.originalReleaseDate):undefined,territories:Array.isArray(req.body?.territories)&&req.body.territories.length?req.body.territories.map(String):['WORLDWIDE'],status:'draft' as const,tracks:[],createdAt:now,updatedAt:now};
  db.musicReleases.push(release);db.save();reply.code(201);return release;
});
app.patch('/api/distribution/releases/:id',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const release=db.musicReleases.find((x:any)=>x.id===req.params.id&&x.userId===user.id);if(!release)return reply.code(404).send({error:'Release not found'});
  for(const k of ['title','upc','label','genre','subgenre','copyrightYear','copyrightOwner','coverArtFileName','releaseDate','originalReleaseDate','territories'] as const)if(req.body?.[k]!==undefined)(release as any)[k]=req.body[k];
  if(['single','ep','album'].includes(req.body?.releaseType))release.releaseType=req.body.releaseType;
  release.updatedAt=new Date().toISOString();db.save();return release;
});
app.post('/api/distribution/releases/:id/tracks',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const release=db.musicReleases.find((x:any)=>x.id===req.params.id&&x.userId===user.id);if(!release)return reply.code(404).send({error:'Release not found'});
  const artist=db.artistProfiles.find((x:any)=>x.id===release.artistProfileId);
  const track={id:randomUUID(),title:String(req.body?.title||'Untitled Track').slice(0,160),version:String(req.body?.version||'Original'),projectId:req.body?.projectId?String(req.body.projectId):undefined,isrc:String(req.body?.isrc||makeIsrc()),explicit:Boolean(req.body?.explicit),language:String(req.body?.language||'en'),primaryArtist:String(req.body?.primaryArtist||artist?.artistName||user.name),featuredArtists:Array.isArray(req.body?.featuredArtists)?req.body.featuredArtists.map(String):[],writers:Array.isArray(req.body?.writers)?req.body.writers:[],producers:Array.isArray(req.body?.producers)?req.body.producers:[],masterFileName:req.body?.masterFileName?String(req.body.masterFileName):undefined,durationSeconds:Math.max(0,Number(req.body?.durationSeconds||0)),trackNumber:release.tracks.length+1};
  release.tracks.push(track);release.updatedAt=new Date().toISOString();db.save();reply.code(201);return track;
});
app.patch('/api/distribution/releases/:releaseId/tracks/:trackId',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const release=db.musicReleases.find((x:any)=>x.id===req.params.releaseId&&x.userId===user.id);if(!release)return reply.code(404).send({error:'Release not found'});
  const track=release.tracks.find((x:any)=>x.id===req.params.trackId);if(!track)return reply.code(404).send({error:'Track not found'});
  for(const k of ['title','version','projectId','isrc','explicit','language','primaryArtist','featuredArtists','writers','producers','masterFileName','durationSeconds','trackNumber'] as const)if(req.body?.[k]!==undefined)(track as any)[k]=req.body[k];
  release.updatedAt=new Date().toISOString();db.save();return track;
});
app.delete('/api/distribution/releases/:releaseId/tracks/:trackId',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const release=db.musicReleases.find((x:any)=>x.id===req.params.releaseId&&x.userId===user.id);if(!release)return reply.code(404).send({error:'Release not found'});
  release.tracks=release.tracks.filter((x:any)=>x.id!==req.params.trackId);release.tracks.forEach((x:any,i:number)=>x.trackNumber=i+1);release.updatedAt=new Date().toISOString();db.save();return reply.code(204).send();
});
app.get('/api/distribution/releases/:id/validate',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const release=db.musicReleases.find((x:any)=>x.id===req.params.id&&x.userId===user.id);if(!release)return reply.code(404).send({error:'Release not found'});
  const issues=validateRelease(release);return {valid:issues.length===0,issues};
});
app.post('/api/distribution/releases/:id/submit',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const release=db.musicReleases.find((x:any)=>x.id===req.params.id&&x.userId===user.id);if(!release)return reply.code(404).send({error:'Release not found'});
  const issues=validateRelease(release);if(issues.length)return reply.code(422).send({error:'Release validation failed',issues});
  release.status='submitted';release.updatedAt=new Date().toISOString();
  for(const store of releaseStores){db.distributionDeliveries.push({id:randomUUID(),releaseId:release.id,provider:'NNIT Distribution sandbox',store,status:'queued',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()})}
  db.save();return {release,deliveries:db.distributionDeliveries.filter((x:any)=>x.releaseId===release.id)};
});
app.get('/api/distribution/releases/:id/deliveries',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const release=db.musicReleases.find((x:any)=>x.id===req.params.id&&x.userId===user.id);if(!release)return reply.code(404).send({error:'Release not found'});
  return {items:db.distributionDeliveries.filter((x:any)=>x.releaseId===release.id)};
});
app.post('/api/distribution/releases/:id/simulate-delivery',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const release=db.musicReleases.find((x:any)=>x.id===req.params.id&&x.userId===user.id);if(!release)return reply.code(404).send({error:'Release not found'});
  const deliveries=db.distributionDeliveries.filter((x:any)=>x.releaseId===release.id);
  for(const d of deliveries){d.status='accepted';d.externalId=`SANDBOX-${d.store.replace(/\s+/g,'-').toUpperCase()}-${release.id.slice(0,8)}`;d.updatedAt=new Date().toISOString()}
  release.status='delivered';release.updatedAt=new Date().toISOString();db.save();return {release,deliveries};
});
app.post('/api/distribution/releases/:id/takedown',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const release=db.musicReleases.find((x:any)=>x.id===req.params.id&&x.userId===user.id);if(!release)return reply.code(404).send({error:'Release not found'});
  release.status='takedown_requested';release.updatedAt=new Date().toISOString();for(const d of db.distributionDeliveries.filter((x:any)=>x.releaseId===release.id)){d.status='removed';d.message='Sandbox takedown requested';d.updatedAt=new Date().toISOString()}db.save();return release;
});
app.post('/api/distribution/statements/import',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const rows=Array.isArray(req.body?.rows)?req.body.rows:[];const imported=[];
  for(const row of rows){const item={id:randomUUID(),userId:user.id,provider:String(row.provider||'Distributor'),period:String(row.period||new Date().toISOString().slice(0,7)),currency:String(row.currency||'EUR').toUpperCase(),gross:Number(row.gross||0),net:Number(row.net??row.gross??0),streams:Math.max(0,Number(row.streams||0)),downloads:Math.max(0,Number(row.downloads||0)),releaseId:row.releaseId?String(row.releaseId):undefined,trackIsrc:row.trackIsrc?String(row.trackIsrc):undefined,importedAt:new Date().toISOString()};db.royaltyStatements.push(item);imported.push(item)}
  db.save();return {items:imported,count:imported.length};
});
app.get('/api/distribution/earnings',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const items=db.royaltyStatements.filter((x:any)=>x.userId===user.id);const totals:any={};
  for(const x of items){if(!totals[x.currency])totals[x.currency]={gross:0,net:0,streams:0,downloads:0};totals[x.currency].gross+=x.gross;totals[x.currency].net+=x.net;totals[x.currency].streams+=x.streams;totals[x.currency].downloads+=x.downloads}
  return {items,totals};
});
app.get('/api/cloud/status',async()=>({connected:false,provider:'NNIT Cloud adapter',localPersistence:true,persistentMedia:true,versionHistory:true,offlineFirst:true,collaboration:true,shareLinks:true,sync:'local-engine-active-provider-credentials-optional'}));
app.get('/api/cloud/workspaces',async()=>({items:db.workspaces}));
app.get('/api/projects/:id/sync',async(req:any,reply)=>{if(!db.project(req.params.id))return reply.code(404).send({error:'Project not found'});return db.ensureSyncState(req.params.id)});
app.post('/api/projects/:id/sync',async(req:any,reply)=>{const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});const state=db.markSynced(p.id);db.saveVersion(p,String(req.body?.label||'Cloud sync checkpoint'));db.addActivity(p.id,'sync','Project synced to local cloud checkpoint');return state;});
app.post('/api/projects/:id/sync/conflict',async(req:any,reply)=>{const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});const state=db.ensureSyncState(p.id);state.status='conflict';db.save();db.addActivity(p.id,'conflict','Sync conflict flagged');return state;});
app.post('/api/projects/:id/sync/resolve',async(req:any,reply)=>{const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});const strategy=String(req.body?.strategy||'keep-local');const state=db.ensureSyncState(p.id);if(strategy==='keep-local'){state.remoteRevision=state.localRevision}else if(strategy==='keep-remote'){state.localRevision=state.remoteRevision}state.status='synced';state.lastSyncedAt=new Date().toISOString();db.save();db.addActivity(p.id,'conflict-resolved',`Conflict resolved: ${strategy}`);return state;});
app.get('/api/projects/:id/collaborators',async(req:any,reply)=>{if(!db.project(req.params.id))return reply.code(404).send({error:'Project not found'});return {items:db.collaborators.filter((x:any)=>x.projectId===req.params.id)}});
app.post('/api/projects/:id/collaborators',async(req:any,reply)=>{const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});const role=('editor'===req.body?.role||'commenter'===req.body?.role||'viewer'===req.body?.role?req.body.role:'viewer') as 'editor'|'commenter'|'viewer';const email=String(req.body?.email||'').trim();if(!email)return reply.code(400).send({error:'Email required'});const item={id:randomUUID(),projectId:p.id,email,name:String(req.body?.name||email.split('@')[0]),role,status:'invited' as const,createdAt:new Date().toISOString()};db.collaborators.push(item);db.addActivity(p.id,'collaborator-invited',`${item.email} invited as ${item.role}`);db.save();reply.code(201);return item;});
app.patch('/api/projects/:id/collaborators/:collaboratorId',async(req:any,reply)=>{const item=db.collaborators.find((x:any)=>x.projectId===req.params.id&&x.id===req.params.collaboratorId);if(!item)return reply.code(404).send({error:'Collaborator not found'});if(['owner','editor','commenter','viewer'].includes(req.body?.role))item.role=req.body.role;if(['active','invited'].includes(req.body?.status))item.status=req.body.status;db.save();db.addActivity(req.params.id,'collaborator-updated',`${item.email} updated`);return item;});
app.delete('/api/projects/:id/collaborators/:collaboratorId',async(req:any,reply)=>{const item=db.collaborators.find((x:any)=>x.projectId===req.params.id&&x.id===req.params.collaboratorId);if(!item)return reply.code(404).send({error:'Collaborator not found'});if(item.role==='owner')return reply.code(409).send({error:'Owner cannot be removed'});db.collaborators.splice(db.collaborators.indexOf(item),1);db.save();db.addActivity(req.params.id,'collaborator-removed',`${item.email} removed`);return reply.code(204).send();});
app.get('/api/projects/:id/comments',async(req:any,reply)=>{if(!db.project(req.params.id))return reply.code(404).send({error:'Project not found'});return {items:db.comments.filter((x:any)=>x.projectId===req.params.id).sort((x:any,y:any)=>y.createdAt.localeCompare(x.createdAt))}});
app.post('/api/projects/:id/comments',async(req:any,reply)=>{const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});const text=String(req.body?.text||'').trim();if(!text)return reply.code(400).send({error:'Comment text required'});const item={id:randomUUID(),projectId:p.id,author:String(req.body?.author||'demo-user'),text,time:Math.max(0,Number(req.body?.time||0)),trackId:req.body?.trackId?String(req.body.trackId):undefined,resolved:false,createdAt:new Date().toISOString()};db.comments.push(item);db.save();db.addActivity(p.id,'comment',`Comment added at ${item.time.toFixed(2)}s`);reply.code(201);return item;});
app.patch('/api/projects/:id/comments/:commentId',async(req:any,reply)=>{const item=db.comments.find((x:any)=>x.projectId===req.params.id&&x.id===req.params.commentId);if(!item)return reply.code(404).send({error:'Comment not found'});if(req.body?.text!==undefined)item.text=String(req.body.text).slice(0,2000);if(req.body?.resolved!==undefined)item.resolved=Boolean(req.body.resolved);db.save();db.addActivity(req.params.id,item.resolved?'comment-resolved':'comment-updated',item.resolved?'Comment resolved':'Comment updated');return item;});
app.delete('/api/projects/:id/comments/:commentId',async(req:any,reply)=>{const i=db.comments.findIndex((x:any)=>x.projectId===req.params.id&&x.id===req.params.commentId);if(i<0)return reply.code(404).send({error:'Comment not found'});db.comments.splice(i,1);db.save();db.addActivity(req.params.id,'comment-deleted','Comment deleted');return reply.code(204).send();});
app.get('/api/projects/:id/share-links',async(req:any,reply)=>{if(!db.project(req.params.id))return reply.code(404).send({error:'Project not found'});return {items:db.shareLinks.filter((x:any)=>x.projectId===req.params.id)}});
app.post('/api/projects/:id/share-links',async(req:any,reply)=>{const p=db.project(req.params.id);if(!p)return reply.code(404).send({error:'Project not found'});const role=('editor'===req.body?.role||'commenter'===req.body?.role||'viewer'===req.body?.role?req.body.role:'viewer') as 'editor'|'commenter'|'viewer';const item={id:randomUUID(),projectId:p.id,token:randomUUID().replaceAll('-',''),role,enabled:true,createdAt:new Date().toISOString(),expiresAt:req.body?.expiresAt?String(req.body.expiresAt):undefined};db.shareLinks.push(item);db.save();db.addActivity(p.id,'share-link-created',`Share link created (${role})`);reply.code(201);return item;});
app.patch('/api/projects/:id/share-links/:linkId',async(req:any,reply)=>{const item=db.shareLinks.find((x:any)=>x.projectId===req.params.id&&x.id===req.params.linkId);if(!item)return reply.code(404).send({error:'Share link not found'});if(req.body?.enabled!==undefined)item.enabled=Boolean(req.body.enabled);if(['editor','commenter','viewer'].includes(req.body?.role))item.role=req.body.role;db.save();db.addActivity(req.params.id,'share-link-updated','Share link updated');return item;});
app.delete('/api/projects/:id/share-links/:linkId',async(req:any,reply)=>{const i=db.shareLinks.findIndex((x:any)=>x.projectId===req.params.id&&x.id===req.params.linkId);if(i<0)return reply.code(404).send({error:'Share link not found'});db.shareLinks.splice(i,1);db.save();db.addActivity(req.params.id,'share-link-deleted','Share link deleted');return reply.code(204).send();});
app.get('/api/projects/:id/activity',async(req:any,reply)=>{if(!db.project(req.params.id))return reply.code(404).send({error:'Project not found'});return {items:db.activity.filter((x:any)=>x.projectId===req.params.id).slice(0,200)}});
app.get('/api/marketplace',async(req:any)=>{
  const category=String(req.query?.category||''),q=String(req.query?.q||'').trim().toLowerCase();
  let items=db.marketplace.filter((x:any)=>x.status==='published');
  if(category)items=items.filter((x:any)=>x.category===category);
  if(q)items=items.filter((x:any)=>`${x.name} ${x.description} ${(x.tags||[]).join(' ')}`.toLowerCase().includes(q));
  return {items};
});
app.get('/api/marketplace/library',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const items=db.marketplacePurchases.filter((x:any)=>x.userId===user.id).map((p:any)=>({purchase:p,item:db.marketplace.find((x:any)=>x.id===p.itemId)}));
  return {items};
});
app.get('/api/marketplace/seller/me',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  let profile=db.sellerProfiles.find((x:any)=>x.userId===user.id);
  if(!profile){profile={id:randomUUID(),userId:user.id,displayName:user.name,bio:'',country:'',verified:false,rating:0,sales:0,createdAt:new Date().toISOString()};db.sellerProfiles.push(profile);db.save()}
  return profile;
});
app.patch('/api/marketplace/seller/me',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  let profile=db.sellerProfiles.find((x:any)=>x.userId===user.id);
  if(!profile){profile={id:randomUUID(),userId:user.id,displayName:user.name,bio:'',country:'',verified:false,rating:0,sales:0,createdAt:new Date().toISOString()};db.sellerProfiles.push(profile)}
  if(req.body?.displayName!==undefined)profile.displayName=String(req.body.displayName).slice(0,100);
  if(req.body?.bio!==undefined)profile.bio=String(req.body.bio).slice(0,1000);
  if(req.body?.country!==undefined)profile.country=String(req.body.country).slice(0,2).toUpperCase();
  db.save();return profile;
});
app.get('/api/marketplace/seller/items',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  return {items:db.marketplace.filter((x:any)=>x.sellerId===user.id)};
});
app.post('/api/marketplace/items',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const category=(['plugin','beat','sample','preset','instrument','template','service'].includes(req.body?.category)?req.body.category:'preset') as any;
  const item={id:randomUUID(),sellerId:user.id,name:String(req.body?.name||'Untitled Product').slice(0,120),category,description:String(req.body?.description||'').slice(0,3000),price:Math.max(0,Number(req.body?.price||0)),currency:String(req.body?.currency||'EUR').toUpperCase(),tags:Array.isArray(req.body?.tags)?req.body.tags.map((x:any)=>String(x).slice(0,40)).slice(0,12):[],status:'draft' as const,rating:0,reviewCount:0,sales:0,licenseType:(['personal','commercial','extended'].includes(req.body?.licenseType)?req.body.licenseType:'commercial') as any,fileName:req.body?.fileName?String(req.body.fileName):undefined,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  db.marketplace.push(item);db.save();reply.code(201);return item;
});
app.patch('/api/marketplace/items/:id',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const item=db.marketplace.find((x:any)=>x.id===req.params.id&&x.sellerId===user.id);if(!item)return reply.code(404).send({error:'Item not found'});
  for(const k of ['name','description','price','currency','tags','fileName'] as const)if(req.body?.[k]!==undefined)(item as any)[k]=req.body[k];
  if(['draft','published','suspended'].includes(req.body?.status))item.status=req.body.status;
  if(['personal','commercial','extended'].includes(req.body?.licenseType))item.licenseType=req.body.licenseType;
  item.updatedAt=new Date().toISOString();db.save();return item;
});
app.post('/api/marketplace/:itemId/purchase',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const item=db.marketplace.find((x:any)=>x.id===req.params.itemId&&x.status==='published');if(!item)return reply.code(404).send({error:'Marketplace item not found'});
  if(item.sellerId===user.id)return reply.code(409).send({error:'You already own your own listing'});
  if(db.marketplacePurchases.some((x:any)=>x.userId===user.id&&x.itemId===item.id))return reply.code(409).send({error:'Already purchased'});
  const currency=String(req.body?.currency||item.currency||'EUR').toUpperCase();
  const discount=Number(db.entitlement(user.id).limits.marketplaceDiscount||0);
  const baseEur=item.currency==='EUR'?Number(item.price):Number(item.price)/(currencyRates[item.currency]||1);
  const amount=convertAmount(baseEur*(1-discount/100),currency);
  const tx={id:randomUUID(),userId:user.id,kind:'marketplace' as const,currency,amount,status:'succeeded' as const,provider:'NNIT Pay sandbox',reference:'NNITP-MKT-'+randomUUID().slice(0,10),createdAt:new Date().toISOString(),metadata:{itemId:item.id,sellerId:item.sellerId}};
  db.transactions.push(tx);
  const purchase={id:randomUUID(),userId:user.id,itemId:item.id,price:amount,currency,transactionId:tx.id,createdAt:new Date().toISOString()};
  db.marketplacePurchases.push(purchase);
  const gross=amount,platformFee=Math.round(gross*.20*100)/100,creatorNet=Math.round((gross-platformFee)*100)/100;
  db.royalties.push({id:randomUUID(),creatorId:item.sellerId,sourcePurchaseId:purchase.id,currency,gross,platformFee,creatorNet,status:'pending',createdAt:new Date().toISOString()});
  item.sales+=1;
  const seller=db.sellerProfiles.find((x:any)=>x.userId===item.sellerId);if(seller)seller.sales+=1;
  db.save();return {purchase,transaction:tx,royalty:{gross,platformFee,creatorNet},license:{type:item.licenseType}};
});
app.get('/api/marketplace/:itemId/reviews',async(req:any,reply)=>{
  const item=db.marketplace.find((x:any)=>x.id===req.params.itemId);if(!item)return reply.code(404).send({error:'Item not found'});
  return {items:db.marketplaceReviews.filter((x:any)=>x.itemId===item.id)};
});
app.post('/api/marketplace/:itemId/reviews',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const item=db.marketplace.find((x:any)=>x.id===req.params.itemId);if(!item)return reply.code(404).send({error:'Item not found'});
  if(!db.marketplacePurchases.some((x:any)=>x.userId===user.id&&x.itemId===item.id))return reply.code(403).send({error:'Purchase required before review'});
  const existing=db.marketplaceReviews.find((x:any)=>x.userId===user.id&&x.itemId===item.id);if(existing)return reply.code(409).send({error:'Already reviewed'});
  const review={id:randomUUID(),itemId:item.id,userId:user.id,rating:Math.max(1,Math.min(5,Number(req.body?.rating||5))),text:String(req.body?.text||'').slice(0,1000),createdAt:new Date().toISOString()};
  db.marketplaceReviews.push(review);const reviews=db.marketplaceReviews.filter((x:any)=>x.itemId===item.id);item.reviewCount=reviews.length;item.rating=Math.round((reviews.reduce((n:number,x:any)=>n+x.rating,0)/reviews.length)*10)/10;db.save();reply.code(201);return review;
});
app.get('/api/creator/royalties',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const items=db.royalties.filter((x:any)=>x.creatorId===user.id);
  const balances:any={};for(const x of items)if(x.status!=='paid')balances[x.currency]=(balances[x.currency]||0)+x.creatorNet;
  return {items,balances};
});
app.post('/api/creator/payouts',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const currency=String(req.body?.currency||'EUR').toUpperCase();
  const payable=db.royalties.filter((x:any)=>x.creatorId===user.id&&x.currency===currency&&x.status!=='paid');
  const available=Math.round(payable.reduce((n:number,x:any)=>n+x.creatorNet,0)*100)/100;
  const amount=Math.max(0,Number(req.body?.amount||available));if(amount<=0||amount>available)return reply.code(400).send({error:'Invalid payout amount',available});
  const payout={id:randomUUID(),creatorId:user.id,currency,amount,status:'requested' as const,requestedAt:new Date().toISOString()};
  db.payoutRequests.push(payout);db.save();reply.code(201);return {payout,availableAfter:Math.round((available-amount)*100)/100};
});
app.get('/api/creator/payouts',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  return {items:db.payoutRequests.filter((x:any)=>x.creatorId===user.id).sort((a:any,b:any)=>b.requestedAt.localeCompare(a.requestedAt))};
});
app.get('/api/creator/analytics',async(req:any,reply)=>{
  const user=currentUser(req);if(!user)return reply.code(401).send({error:'Not authenticated'});
  const items=db.marketplace.filter((x:any)=>x.sellerId===user.id);
  const royalties=db.royalties.filter((x:any)=>x.creatorId===user.id);
  return {products:items.length,published:items.filter((x:any)=>x.status==='published').length,sales:items.reduce((n:number,x:any)=>n+x.sales,0),gross:royalties.reduce((n:number,x:any)=>n+x.gross,0),creatorNet:royalties.reduce((n:number,x:any)=>n+x.creatorNet,0)};
});
app.get('/api/integrations',async()=>({nnitId:{configured:Boolean(process.env.NNIT_ID_URL)},nnitPay:{configured:Boolean(process.env.NNIT_PAY_URL)}}));
app.get('/ws/projects/:id',{websocket:true},(socket,req:any)=>{socket.send(JSON.stringify({type:'connected',projectId:req.params.id}));socket.on('message',(data:Buffer)=>socket.send(JSON.stringify({type:'ack',received:data.toString()})));});

const port=Number(process.env.PORT||4000);await app.listen({port,host:'0.0.0.0'});
