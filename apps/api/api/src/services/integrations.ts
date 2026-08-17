export class NNITIdentityService { async verifyBearer(token?:string){ return token ? {id:'nnit-user',email:'user@nnit.local'} : {id:'demo-user',email:'demo@nnit.local'}; } }
export class NNITPayService { async checkout(plan:string,currency='EUR'){ return {provider:'NNIT Pay',status:'integration-ready',plan,currency,checkoutUrl:null}; } }
export class StorageService { async signedUpload(filename:string){ return {filename,mode:'development',uploadUrl:`/api/assets/local/${encodeURIComponent(filename)}`}; } }
