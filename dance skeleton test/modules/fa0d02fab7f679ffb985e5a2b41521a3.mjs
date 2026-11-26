import {chunkIndexForFrame} from './1d82423eb2d3ad9df70711487557912a.mjs';
import {fetchBytes,decodeChunk,need} from './e455870ebb113ec863443bc5a044b02a.mjs';
const aborted=()=>Object.assign(new Error('Superseded chunk request'),{name:'AbortError'});
export class ChunkCache{
 constructor(sequence,{capacity=4,fetcher=fetch,timeoutMs=10000,onChange=()=>{},decode=decodeChunk,decoderStats=()=>({mode:'direct Node validation'}),decoderRecords=()=>[],disposeDecoder=()=>{}}={}){
  need(capacity===4,'Frozen four-chunk capacity');Object.assign(this,{sequence,capacity,fetcher,timeoutMs,onChange,decode,decoderStats,decoderRecords,disposeDecoder});this.cache=new Map();this.errors=new Map();this.waiters=new Map();this.wanted=[];this.target=-1;this.disposed=false;this.running=null;this.controller=null;this.inflightBytes=0;this.scratchBytes=0;this.auditScratch=0;this.peakBytes=sequence.topologyBuffer.byteLength;this.requests=0;this.evictions=0;this.maxCached=0;this.maxInflight=0;this.requestLog=[];
 }
 stats(){const cachedBytes=[...this.cache.values()].reduce((s,c)=>s+c.buffer.byteLength,0),ownedBytes=(this.sequence?.topologyBuffer.byteLength??0)+cachedBytes+this.inflightBytes;return {cachedChunks:this.cache.size,cacheIndices:[...this.cache.keys()],cachedBytes,inflightBytes:this.inflightBytes,hashOrNetworkScratchEstimate:this.scratchBytes+this.auditScratch,ownedBytes,conservativeBytes:ownedBytes+this.scratchBytes+this.auditScratch,peakConservativeBytes:this.peakBytes,maxCached:this.maxCached,maxInflight:this.maxInflight,requests:this.requests,evictions:this.evictions,disposed:this.disposed,errors:[...this.errors].map(([index,e])=>({index,message:e.message,code:e.code}))};}
 changed(){const s=this.stats();this.peakBytes=Math.max(this.peakBytes,s.conservativeBytes);this.onChange(this.stats());}
 setTarget(frame){
  need(!this.disposed,'Cache disposed');need(Number.isInteger(frame)&&frame>=0&&frame<this.sequence.manifest.frame_count,'Frame range');
  const ci=chunkIndexForFrame(this.sequence,frame);if(ci===this.target)return;this.target=ci;const n=this.sequence.manifest.chunks.length;this.wanted=[ci,ci+1,ci+2,ci-1].filter(x=>x>=0&&x<n);
  if(this.running&&!this.wanted.includes(this.running.index))this.controller?.abort();
  for(const k of this.cache.keys())if(!this.wanted.includes(k)){this.cache.delete(k);this.evictions++;}
  for(const [k,ws] of this.waiters)if(!this.wanted.includes(k)){for(const w of ws)w.reject(aborted());this.waiters.delete(k);}
  this.changed();this.pump();
 }
 frame(i){if(this.disposed)return null;return this.cache.get(chunkIndexForFrame(this.sequence,i))?.frame(i)??null;}
 ensure(frame){this.setTarget(frame);const ci=chunkIndexForFrame(this.sequence,frame);if(this.cache.has(ci))return Promise.resolve();if(this.errors.has(ci))return Promise.reject(this.errors.get(ci));return new Promise((resolve,reject)=>{const ws=this.waiters.get(ci)??[];ws.push({resolve,reject});this.waiters.set(ci,ws);this.pump();});}
 pump(){
  if(this.disposed||this.running)return;
  const index=this.wanted.find(k=>!this.cache.has(k)&&!this.errors.has(k));if(index===undefined)return;
  const controller=new AbortController();this.controller=controller;const token={index,task:null};this.running=token;this.maxInflight=1;this.requests++;this.requestLog.push({index,at:performance.now()});if(this.requestLog.length>1000)this.requestLog.shift();
  token.task=(async()=>{try{
   const asset=this.sequence.entry.assets[this.sequence.manifest.chunks[index].file];
   const b=await fetchBytes(asset,{fetcher:this.fetcher,signal:controller.signal,timeoutMs:this.timeoutMs,onBytes:n=>{this.inflightBytes=n;this.changed();},onScratch:n=>{this.scratchBytes=n;this.changed();}});
   this.inflightBytes=b.byteLength;this.changed();
   const c=await this.decode(this.sequence,index,b,{cancelled:()=>this.disposed||controller.signal.aborted,onScratch:n=>{this.scratchBytes=n;this.changed();}});
   if(!this.disposed&&!controller.signal.aborted&&this.wanted.includes(index)){
    need(this.cache.size<this.capacity,'Cache capacity');this.cache.set(index,c);this.maxCached=Math.max(this.maxCached,this.cache.size);
    for(const w of this.waiters.get(index)??[])w.resolve();this.waiters.delete(index);
   }
  }catch(e){if(!this.disposed&&!controller.signal.aborted){this.errors.set(index,e);for(const w of this.waiters.get(index)??[])w.reject(e);this.waiters.delete(index);}}
  finally{this.inflightBytes=0;this.scratchBytes=0;this.running=null;this.controller=null;this.changed();this.pump();}})();token.task.catch(()=>{});
 }
 retry(){this.errors.clear();this.pump();}
 async settled(){while(this.running)await this.running.task;}
 async verify(){const sequence=this.sequence;for(const [index,c] of this.cache){const {sha}=await import('./e455870ebb113ec863443bc5a044b02a.mjs');this.auditScratch+=c.buffer.byteLength;this.changed();try{need(await sha(c.buffer)===sequence.manifest.chunks[index].sha256,'Cached source mutated');}finally{this.auditScratch-=c.buffer.byteLength;this.changed();}}return true;}
 async dispose(){if(this.disposed){await this.running?.task;return;}this.disposed=true;this.controller?.abort();this.disposeDecoder();this.wanted=[];this.cache.clear();for(const ws of this.waiters.values())for(const w of ws)w.reject(aborted());this.waiters.clear();await this.running?.task;this.sequence=null;this.errors.clear();this.changed();}
}
