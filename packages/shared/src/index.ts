export type TrackKind = 'audio'|'midi'|'instrument'|'bus'|'master';
export type EffectType = 'eq'|'compressor'|'gate'|'deesser'|'reverb'|'delay'|'saturation'|'stereo'|'limiter'|'pitch'|'custom';
export interface EffectSlot { id:string; type:EffectType; enabled:boolean; params:Record<string,number|string|boolean>; }
export interface Clip { id:string; assetUrl?:string; start:number; duration:number; offset:number; gainDb:number; fadeIn:number; fadeOut:number; }
export interface AutomationPoint { time:number; value:number; curve?:'linear'|'hold'|'bezier'; }
export interface Track { id:string; name:string; kind:TrackKind; gainDb:number; pan:number; mute:boolean; solo:boolean; armed:boolean; effects:EffectSlot[]; clips:Clip[]; }
export interface StudioProject { id:string; ownerId:string; name:string; bpm:number; key?:string; sampleRate:44100|48000|88200|96000|192000; bitDepth:16|24|32; tracks:Track[]; createdAt:string; updatedAt:string; }
export interface MasteringTarget { platform:'streaming'|'broadcast'|'club'|'cd'|'custom'; integratedLufs:number; truePeakDbtp:number; }
export type AIJobType = 'stem-separation'|'denoise'|'vocal-isolation'|'bpm-detection'|'key-detection'|'mix-assist'|'master-assist'|'transcription'|'harmony';
export interface AIJob { id:string; type:AIJobType; status:'queued'|'running'|'done'|'failed'; progress:number; result?:unknown; error?:string; }
export const plans = {
  free: { projects: 3, cloudGb: 1, aiMinutes: 10 },
  creator: { projects: 50, cloudGb: 100, aiMinutes: 600 },
  pro: { projects: -1, cloudGb: 1000, aiMinutes: 3000 },
  enterprise: { projects: -1, cloudGb: -1, aiMinutes: -1 }
} as const;
