export interface AudioDeviceConfig { inputId?:string; outputId?:string; sampleRate:number; bufferSize:64|128|256|512|1024; channels:number; }
export interface MeterFrame { peakDb:number; rmsDb:number; truePeakDbtp?:number; }
export interface ProcessorDescriptor { id:string; name:string; category:string; parameters: Array<{key:string; min:number; max:number; default:number; unit?:string}>; }
export const processors: ProcessorDescriptor[] = [
 {id:'eq8',name:'Studio EQ 8',category:'EQ',parameters:[{key:'output',min:-24,max:24,default:0,unit:'dB'}]},
 {id:'compressor',name:'Studio Compressor',category:'Dynamics',parameters:[{key:'threshold',min:-60,max:0,default:-18,unit:'dB'},{key:'ratio',min:1,max:20,default:4}]},
 {id:'gate',name:'Noise Gate',category:'Dynamics',parameters:[{key:'threshold',min:-80,max:0,default:-45,unit:'dB'}]},
 {id:'deesser',name:'De-Esser',category:'Vocal',parameters:[{key:'frequency',min:2000,max:12000,default:6500,unit:'Hz'}]},
 {id:'reverb',name:'Studio Reverb',category:'Spatial',parameters:[{key:'mix',min:0,max:1,default:.2}]},
 {id:'delay',name:'Tempo Delay',category:'Spatial',parameters:[{key:'feedback',min:0,max:.95,default:.35}]},
 {id:'saturation',name:'Tape Saturation',category:'Color',parameters:[{key:'drive',min:0,max:24,default:3,unit:'dB'}]},
 {id:'stereo',name:'Stereo Imager',category:'Mastering',parameters:[{key:'width',min:0,max:2,default:1}]},
 {id:'limiter',name:'True Peak Limiter',category:'Mastering',parameters:[{key:'ceiling',min:-6,max:0,default:-1,unit:'dB'}]},
 {id:'pitch',name:'Vocal Pitch',category:'Vocal',parameters:[{key:'speed',min:0,max:1,default:.5}]}
];
export function dbToGain(db:number){ return Math.pow(10, db/20); }
export function gainToDb(gain:number){ return 20*Math.log10(Math.max(gain,1e-12)); }
export class Transport { playing=false; recording=false; position=0; bpm=120; play(){this.playing=true;} stop(){this.playing=false;this.recording=false;} record(){this.playing=true;this.recording=true;} seek(seconds:number){this.position=Math.max(0,seconds);} }
