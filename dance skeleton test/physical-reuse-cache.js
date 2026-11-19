// 僅為既有ChunkCache在循環回返時重綁相同SHA的已驗證buffer；容量/解碼/gates不變。
import {ChunkCache} from './legacy/chunk-cache.js';
import {chunkIndexForFrame,viewChunk} from './legacy/stream-reader.js';
const key=c=>[c.sha256,c.byte_length,c.physical_start,c.physical_count].join(':');
export class PhysicalReuseCache extends ChunkCache{
 constructor(...a){super(...a);this.physicalReuses=0;}
 setTarget(frame){
  if(this.disposed)return super.setTarget(frame);
  const ci=chunkIndexForFrame(this.sequence,frame);if(ci===this.target)return super.setTarget(frame);
  const chunks=this.sequence.manifest.chunks,wanted=[ci,ci+1,ci+2,ci-1].filter(i=>i>=0&&i<chunks.length),movable=[...this.cache].filter(([i])=>!wanted.includes(i));
  for(const i of wanted){
   if(this.cache.has(i))continue;const at=movable.findIndex(([j])=>key(chunks[j])===key(chunks[i]));if(at<0)continue;
   const [[old,c]]=movable.splice(at,1);this.cache.delete(old);this.cache.set(i,viewChunk(this.sequence,i,c.buffer));this.physicalReuses++;
  }
  return super.setTarget(frame);
 }
 stats(){return {...super.stats(),physicalReuses:this.physicalReuses??0};}
}
