export interface AIProvider { run(type:string,input:Record<string,unknown>):Promise<Record<string,unknown>>; }
export class LocalMockAI implements AIProvider {
 async run(type:string,input:Record<string,unknown>){
   if(type==='bpm-detection') return { bpm:120, confidence:.5, engine:'local-mock' };
   if(type==='key-detection') return { key:'C major', confidence:.5, engine:'local-mock' };
   return { accepted:true, type, input, note:'Connect a production DSP/ML provider in packages/ai-core.' };
 }
}
export const aiCapabilities = ['stem-separation','denoise','vocal-isolation','bpm-detection','key-detection','mix-assist','master-assist','transcription','harmony'];
