export class NNITStudioClient {
 constructor(public baseUrl='http://localhost:4000'){}
 async request<T>(path:string,init?:RequestInit):Promise<T>{ const r=await fetch(this.baseUrl+path,{...init,headers:{'content-type':'application/json',...(init?.headers||{})}}); if(!r.ok) throw new Error(await r.text()); return r.json() as Promise<T>; }
 projects(){return this.request('/api/projects');}
 createProject(name:string){return this.request('/api/projects',{method:'POST',body:JSON.stringify({name})});}
 submitAI(type:string,input:Record<string,unknown>){return this.request('/api/ai/jobs',{method:'POST',body:JSON.stringify({type,input})});}
}
