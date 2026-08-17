import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type Clip={
  id:string; name:string; start:number; duration:number; kind:'recording'|'import'; createdAt:string;
  mediaId?:string; mimeType?:string; mediaOffset?:number; fadeIn:number; fadeOut:number;
};
export type AutomationPoint={id:string;time:number;value:number};
export type MidiNote={id:string;pitch:number;start:number;duration:number;velocity:number};
export type TrackEffects={
  eq:boolean; compressor:boolean; gate:boolean; reverb:number; delay:number;
  eqLow:number; eqMid:number; eqHigh:number; compressorThreshold:number; compressorRatio:number; gateThreshold:number; deEsser:boolean; deEsserAmount:number; noiseCleanup:number; vocalPresence:number; pitchCorrection:boolean; pitchAmount:number; formant:number;
};
export type PluginSlot={id:string;pluginId:string;name:string;enabled:boolean;preset:string;order:number};
export type Track={
  id:string; name:string; kind:'audio'|'instrument'|'drums'; gainDb:number; pan:number; mute:boolean; solo:boolean; armed:boolean;
  bus:string; group:string; color:string; inputDeviceId:string; monitoring:boolean; effects:TrackEffects; clips:Clip[]; automation:{gain:AutomationPoint[];pan:AutomationPoint[]};
  midiNotes:MidiNote[]; drumPattern:boolean[]; pluginRack:PluginSlot[];
};
export type Bus={id:string;name:string;gainDb:number;mute:boolean};
export type Project={
  id:string; ownerId:string; name:string; bpm:number; key:string; sampleRate:number; bitDepth:number;
  master:{targetLufs:number;ceilingDbtp:number;limiterThreshold:number;limiterRelease:number;stereoWidth:number;masterEqLow:number;masterEqHigh:number;multibandAmount:number;preset:string;pluginRack:PluginSlot[]}; production:{metronome:boolean;countInBars:number;snap:string;loopEnabled:boolean;loopStart:number;loopEnd:number}; buses:Bus[]; tracks:Track[]; createdAt:string; updatedAt:string;
};
export type ProjectVersion={id:string;projectId:string;label:string;createdAt:string;snapshot:Project};
export type PluginEntry={id:string;name:string;path:string;format:'VST3';vendor:string;enabled:boolean;lastSeen:string;status:'available'|'missing'|'quarantined'};
export type NativeSettings={driverMode:string;inputDeviceId:string;outputDeviceId:string;sampleRate:number;bufferSize:number;exclusiveMode:boolean;midiInputId:string;pluginFolders:string[];localAiUrl:string;nativeHostUrl:string};
type Data={projects:Project[];versions:ProjectVersion[];aiJobs:any[];marketplace:any[];plugins:PluginEntry[];nativeSettings:NativeSettings};

const dataFile=path.resolve(process.cwd(),'database','studio-data.json');
export const mediaDir=path.resolve(process.cwd(),'database','media');
const now=()=>new Date().toISOString();
const clone=<T>(x:T):T=>JSON.parse(JSON.stringify(x));

function defaultEffects():TrackEffects{return {eq:true,compressor:false,gate:false,reverb:15,delay:0,eqLow:0,eqMid:0,eqHigh:0,compressorThreshold:-20,compressorRatio:4,gateThreshold:-45,deEsser:false,deEsserAmount:35,noiseCleanup:0,vocalPresence:0,pitchCorrection:false,pitchAmount:55,formant:0};}
function defaultBuses():Bus[]{return [{id:'master',name:'Master',gainDb:0,mute:false},{id:'vocals',name:'Vocals',gainDb:0,mute:false},{id:'music',name:'Music',gainDb:0,mute:false},{id:'drums',name:'Drums',gainDb:0,mute:false}];}
function defaultTracks():Track[]{return [
  ['Lead Vocal','audio',true,'vocals'],['Backing Vocal','audio',false,'vocals'],['Drums','drums',true,'drums'],['Bass','instrument',false,'music'],['Keys','instrument',true,'music'],['Guitar','instrument',false,'music']
].map(([name,kind,armed,bus])=>({id:randomUUID(),name:name as string,kind:kind as Track['kind'],gainDb:0,pan:0,mute:false,solo:false,armed:Boolean(armed),bus:String(bus),group:'',color:'#355178',inputDeviceId:'',monitoring:false,effects:defaultEffects(),clips:[],automation:{gain:[],pan:[]},midiNotes:[],drumPattern:Array(16).fill(false),pluginRack:[]}));}
function seed():Data{return {projects:[],versions:[],aiJobs:[],plugins:[],nativeSettings:{driverMode:'WASAPI Shared',inputDeviceId:'',outputDeviceId:'',sampleRate:48000,bufferSize:256,exclusiveMode:false,midiInputId:'',pluginFolders:['C:/Program Files/Common Files/VST3','C:/Program Files/VSTPlugins'],localAiUrl:'http://127.0.0.1:8765',nativeHostUrl:'http://127.0.0.1:8766'},marketplace:[
  {id:'mix-review',name:'Professional Mix Review',category:'service',price:49,currency:'EUR'},
  {id:'master-pack',name:'Mastering Preset Pack',category:'preset',price:19,currency:'EUR'},
  {id:'vocal-chain',name:'Vocal Chain Pro',category:'preset',price:29,currency:'EUR'}
]};}
function normalizeClip(c:any):Clip{return {id:String(c?.id||randomUUID()),name:String(c?.name||'Audio clip'),start:Number.isFinite(Number(c?.start))?Number(c.start):0,duration:Number.isFinite(Number(c?.duration))?Number(c.duration):0,kind:c?.kind==='import'?'import':'recording',createdAt:String(c?.createdAt||now()),mediaId:c?.mediaId?String(c.mediaId):undefined,mimeType:c?.mimeType?String(c.mimeType):undefined,mediaOffset:Number.isFinite(Number(c?.mediaOffset))?Number(c.mediaOffset):0,fadeIn:Number.isFinite(Number(c?.fadeIn))?Number(c.fadeIn):0,fadeOut:Number.isFinite(Number(c?.fadeOut))?Number(c.fadeOut):0};}
function normalizePoints(a:any):AutomationPoint[]{return Array.isArray(a)?a.map((p:any)=>({id:String(p?.id||randomUUID()),time:Number(p?.time||0),value:Number(p?.value||0)})).sort((x,y)=>x.time-y.time):[];}
function normalizeNotes(a:any):MidiNote[]{return Array.isArray(a)?a.map((n:any)=>({id:String(n?.id||randomUUID()),pitch:Number(n?.pitch||60),start:Number(n?.start||0),duration:Math.max(.05,Number(n?.duration||.5)),velocity:Math.max(0,Math.min(1,Number(n?.velocity??.8)))})):[];}
function normalizeTrack(t:any):Track{return {id:String(t?.id||randomUUID()),name:String(t?.name||'Track'),kind:['audio','instrument','drums'].includes(t?.kind)?t.kind:'audio',gainDb:Number.isFinite(Number(t?.gainDb))?Number(t.gainDb):0,pan:Number.isFinite(Number(t?.pan))?Number(t.pan):0,mute:Boolean(t?.mute),solo:Boolean(t?.solo),armed:Boolean(t?.armed),bus:String(t?.bus||((t?.kind==='audio')?'vocals':t?.kind==='drums'?'drums':'music')),group:String(t?.group||''),color:String(t?.color||'#355178'),inputDeviceId:String(t?.inputDeviceId||''),monitoring:Boolean(t?.monitoring),effects:{...defaultEffects(),...(t?.effects||{})},clips:Array.isArray(t?.clips)?t.clips.map(normalizeClip):[],automation:{gain:normalizePoints(t?.automation?.gain),pan:normalizePoints(t?.automation?.pan)},midiNotes:normalizeNotes(t?.midiNotes),drumPattern:Array.isArray(t?.drumPattern)?Array.from({length:16},(_,i)=>Boolean(t.drumPattern[i])):Array(16).fill(false),pluginRack:Array.isArray(t?.pluginRack)?t.pluginRack.map((x:any,i:number)=>({id:String(x?.id||randomUUID()),pluginId:String(x?.pluginId||''),name:String(x?.name||'Plugin'),enabled:x?.enabled!==false,preset:String(x?.preset||'Default'),order:Number.isFinite(Number(x?.order))?Number(x.order):i})).sort((a:any,b:any)=>a.order-b.order):[]};}
function normalizeProject(p:any):Project{return {id:String(p?.id||randomUUID()),ownerId:String(p?.ownerId||'demo-user'),name:String(p?.name||'NNIT Studio Project'),bpm:Number.isFinite(Number(p?.bpm))?Number(p.bpm):120,key:String(p?.key||'C Major'),sampleRate:Number.isFinite(Number(p?.sampleRate))?Number(p.sampleRate):48000,bitDepth:Number.isFinite(Number(p?.bitDepth))?Number(p.bitDepth):24,master:{targetLufs:Number.isFinite(Number(p?.master?.targetLufs))?Number(p.master.targetLufs):-14,ceilingDbtp:Number.isFinite(Number(p?.master?.ceilingDbtp))?Number(p.master.ceilingDbtp):-1,limiterThreshold:Number.isFinite(Number(p?.master?.limiterThreshold))?Number(p.master.limiterThreshold):-1,limiterRelease:Number.isFinite(Number(p?.master?.limiterRelease))?Number(p.master.limiterRelease):120,stereoWidth:Number.isFinite(Number(p?.master?.stereoWidth))?Number(p.master.stereoWidth):100,masterEqLow:Number.isFinite(Number(p?.master?.masterEqLow))?Number(p.master.masterEqLow):0,masterEqHigh:Number.isFinite(Number(p?.master?.masterEqHigh))?Number(p.master.masterEqHigh):0,multibandAmount:Number.isFinite(Number(p?.master?.multibandAmount))?Number(p.master.multibandAmount):25,preset:String(p?.master?.preset||'Streaming Balanced'),pluginRack:Array.isArray(p?.master?.pluginRack)?p.master.pluginRack.map((x:any,i:number)=>({id:String(x?.id||randomUUID()),pluginId:String(x?.pluginId||''),name:String(x?.name||'Plugin'),enabled:x?.enabled!==false,preset:String(x?.preset||'Default'),order:Number.isFinite(Number(x?.order))?Number(x.order):i})).sort((a:any,b:any)=>a.order-b.order):[]},production:{metronome:Boolean(p?.production?.metronome),countInBars:Number.isFinite(Number(p?.production?.countInBars))?Number(p.production.countInBars):1,snap:String(p?.production?.snap||'1/16'),loopEnabled:Boolean(p?.production?.loopEnabled),loopStart:Number.isFinite(Number(p?.production?.loopStart))?Number(p.production.loopStart):0,loopEnd:Number.isFinite(Number(p?.production?.loopEnd))?Number(p.production.loopEnd):8},buses:Array.isArray(p?.buses)?p.buses.map((b:any)=>({id:String(b?.id||randomUUID()),name:String(b?.name||'Bus'),gainDb:Number(b?.gainDb||0),mute:Boolean(b?.mute)})):defaultBuses(),tracks:Array.isArray(p?.tracks)?p.tracks.map(normalizeTrack):defaultTracks(),createdAt:String(p?.createdAt||now()),updatedAt:String(p?.updatedAt||now())};}
function load():Data{try{if(fs.existsSync(dataFile)){const parsed=JSON.parse(fs.readFileSync(dataFile,'utf8'));return {...seed(),...parsed,projects:Array.isArray(parsed.projects)?parsed.projects.map(normalizeProject):[],versions:Array.isArray(parsed.versions)?parsed.versions:[]};}}catch{}return seed();}
let data=load();

export const db={
  get projects(){return data.projects},get versions(){return data.versions},get aiJobs(){return data.aiJobs},get marketplace(){return data.marketplace},get plugins(){return data.plugins},get nativeSettings(){return data.nativeSettings},
  save(){fs.mkdirSync(path.dirname(dataFile),{recursive:true});fs.writeFileSync(dataFile,JSON.stringify(data,null,2),'utf8');},
  setPlugins(items:PluginEntry[]){data.plugins=items;this.save();return data.plugins;},
  setNativeSettings(next:Partial<NativeSettings>){data.nativeSettings={...data.nativeSettings,...next};this.save();return data.nativeSettings;},
  project(id:string){return data.projects.find(p=>p.id===id)},
  replaceProject(id:string,next:any){const i=data.projects.findIndex(p=>p.id===id);if(i<0)return undefined;const normalized=normalizeProject({...next,id,createdAt:data.projects[i].createdAt,updatedAt:now()});data.projects[i]=normalized;this.save();return normalized;},
  removeProject(id:string){data.projects=data.projects.filter(p=>p.id!==id);data.versions=data.versions.filter(v=>v.projectId!==id);this.save();},
  saveVersion(project:Project,label='Autosave'){const v:ProjectVersion={id:randomUUID(),projectId:project.id,label:String(label).slice(0,80),createdAt:now(),snapshot:clone(project)};data.versions.unshift(v);data.versions=data.versions.filter((x,i)=>x.projectId!==project.id||i<40);this.save();return v;},
  restoreVersion(projectId:string,versionId:string){const v=data.versions.find(x=>x.projectId===projectId&&x.id===versionId);if(!v)return undefined;return this.replaceProject(projectId,clone(v.snapshot));}
};
export function newProject(name:string,ownerId='demo-user'):Project{const t=now();const p:Project={id:randomUUID(),ownerId,name,bpm:120,key:'C Major',sampleRate:48000,bitDepth:24,master:{targetLufs:-14,ceilingDbtp:-1,limiterThreshold:-1,limiterRelease:120,stereoWidth:100,masterEqLow:0,masterEqHigh:0,multibandAmount:25,preset:'Streaming Balanced',pluginRack:[]},production:{metronome:false,countInBars:1,snap:'1/16',loopEnabled:false,loopStart:0,loopEnd:8},buses:defaultBuses(),tracks:defaultTracks(),createdAt:t,updatedAt:t};data.projects.push(p);db.saveVersion(p,'Project created');db.save();return p;}
export function touch(p:Project){p.updatedAt=now();db.save();return p;}
export function createMediaPath(id:string){fs.mkdirSync(mediaDir,{recursive:true});return path.join(mediaDir,id+'.bin');}
export function mediaPath(id:string){return path.join(mediaDir,id+'.bin');}
if(data.projects.length===0)newProject('NNIT Studio Demo');
