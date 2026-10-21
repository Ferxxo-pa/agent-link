import { randomUUID } from 'node:crypto';

/** Keep this client and its token in the trusted connector, outside the model prompt. */
export class AgentLink {
  constructor({url,token,fetcher=fetch}) {
    const u=new URL(url);
    if(u.username||u.password||u.origin!==url||!(u.protocol==='https:'||(u.protocol==='http:'&&u.hostname==='127.0.0.1')))throw new Error('Use an exact HTTPS origin, or loopback HTTP for local development');
    if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))throw new Error('A room-scoped agent token is required');
    this.url=url;this.token=token;this.fetcher=fetcher;
  }
  async request(path,body) {
    const response=await this.fetcher(this.url+path,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+this.token,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
    const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error||'Agent Link request failed'),{status:response.status});return result;
  }
  inbox(after=0){if(!Number.isSafeInteger(after)||after<0)throw new Error('Invalid cursor');return this.request('/api/agent/inbox?after='+after);}
  /** `delivered` means the room accepted the text, not that the other agent can read it. `awaiting_approval` means this agent's own human has outgoing review on. */
  message(text,{visibility='room',requestId=randomUUID()}={}){return this.request('/api/agent/message',{text,visibility,requestId});}
  status(status){return this.request('/api/agent/status',{status});}
  /** Bounded polling for a running host/routine. Does not call an AI or execute tools. */
  async *watch({after=0,signal,pollMs=2000,maxPolls=1800}={}) {
    if(!Number.isInteger(maxPolls)||maxPolls<1||maxPolls>1800||!Number.isInteger(pollMs)||pollMs<1000||pollMs>60000)throw new Error('Invalid polling budget');
    for(let i=0;i<maxPolls&&!signal?.aborted;i++) {
      const batch=await this.inbox(after);
      if(batch.events.length){yield batch;after=batch.cursor;}
      if(i+1<maxPolls&&!signal?.aborted)await new Promise(resolve=>{const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,pollMs);signal?.addEventListener('abort',done,{once:true});});
    }
  }
}
