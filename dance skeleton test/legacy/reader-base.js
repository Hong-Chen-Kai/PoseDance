export const need=(x,m)=>{if(!x)throw new Error(m);};
export const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export async function sha(b){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(x=>x.toString(16).padStart(2,'0')).join('');}
const parentsExpected=[-1,0,0,0,1,2,3,4,5,6,7,8,9,9,9,12,13,14,16,17,18,19,20,21];
export async function fetchBytes(asset,{fetcher=fetch,signal,timeoutMs=45000,onBytes=()=>{},onScratch=()=>{}}={}){
 need(asset&&Number.isSafeInteger(asset.byte_length)&&asset.byte_length>0&&asset.byte_length<=6*1024*1024,'Asset size');
 const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 let timed=false,reader;const timer=setTimeout(()=>{timed=true;controller.abort();},timeoutMs);let b;
 try{const r=await fetcher(asset.url,{signal:controller.signal,cache:asset.encoding?'force-cache':'no-store',redirect:'error'});need(r.ok,'Asset HTTP '+r.status);if(r.headers.get('Content-Length')&&!r.headers.get('Content-Encoding'))need(Number(r.headers.get('Content-Length'))===(asset.encoding?asset.packed_byte_length:asset.byte_length),'HTTP size mismatch');
  b=new Uint8Array(asset.byte_length);onBytes(b.byteLength);reader=(asset.encoding?r.body.pipeThrough(new DecompressionStream('gzip')):r.body).getReader();let at=0;
  for(;;){const part=await reader.read();if(part.done)break;onScratch(part.value.byteLength);need(at+part.value.length<=b.length,'Oversized response');b.set(part.value,at);at+=part.value.length;onScratch(0);}
  need(at===b.length,'Truncated response');if(asset.encoding==='xor-frame-byteplane-gzip-v1'){onScratch(b.byteLength);const restored=new Uint8Array(b.length);restored.set(b.subarray(0,64));const words=(b.length-64)/4;need(Number.isInteger(words),'Codec words');for(let i=0;i<words;i++)for(let k=0;k<4;k++)restored[64+i*4+k]=b[64+k*words+i];const header=new DataView(restored.buffer),n=header.getUint32(16,true);need(n>0&&n<=60,'Codec frames');for(const pair of[[32,36],[40,44],[48,52]]){const off=header.getUint32(pair[0],true),len=header.getUint32(pair[1],true);need(off>=64&&off+len<=b.length&&len%(n*4)===0,'Codec range');const data=new Uint32Array(restored.buffer,off,len/4),stride=data.length/n;for(let row=1;row<n;row++)for(let k=0;k<stride;k++)data[row*stride+k]^=data[(row-1)*stride+k];}b=restored;onScratch(0);}need(!controller.signal.aborted,'Request aborted');onScratch(b.byteLength);const hash=await sha(b);onScratch(0);need(hash===asset.sha256,'Asset hash mismatch');return b.buffer;
 }catch(e){if(timed)throw Object.assign(new Error('Chunk timeout'),{code:'TIMEOUT'});throw e;}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(controller.signal.aborted)try{await reader?.cancel();}catch{}onScratch(0);onBytes(0);}
}
