// 沿用正式解碼與逐幀SHA驗證；僅排除本頁不使用的私有Playlist API。
import{need,same,sha,fetchBytes}from'./reader-base.js';export{need,same,sha,fetchBytes};export{chunkIndexForFrame}from'./playlist-contract.js';
export async function decodeChunk(sequence,index,b,{cancelled=()=>false,onScratch=()=>{}}={}){
 const m=sequence.manifest,s=m.chunks[index];need(s&&b.byteLength===s.byte_length,'Chunk size');const count=s.physical_count,v=count*20670*4,j=count*72*4,r=count*3*4,d=new DataView(b);need(new TextDecoder().decode(new Uint8Array(b,0,8))==='AISTSG01','Segment magic');need(same(Array.from({length:14},(_,i)=>d.getUint32(8+i*4,true)),[5,s.physical_start,count,6890,24,60,64,v,64+v,j,64+v+j,r,b.byteLength,0]),'Segment header');
 const vv=new Float32Array(b,64,v/4),jj=new Float32Array(b,64+v,j/4),rr=new Float32Array(b,64+v+j,r/4);need(vv.every(Number.isFinite)&&jj.every(Number.isFinite)&&rr.every(Number.isFinite),'Finite data');
 for(let row=0;row<count;row++){
  need(!cancelled(),'Decode cancelled');const f=s.physical_frames[row];for(const [off,len,k] of [[64+row*82680,82680,'vertices_f32'],[64+v+row*288,288,'joints_f32'],[64+v+j+row*12,12,'rest_root_f32']]){onScratch(len);need(await sha(new Uint8Array(b,off,len))===f[k],'Frame hash '+k);onScratch(0);}
  for(let i=row*20670;i<(row+1)*20670;i++){const c=i%3,tol=2**-24*Math.max(Math.abs(m.bounds.min[c]),Math.abs(m.bounds.max[c]))+2**-150;need(vv[i]>=m.bounds.min[c]-tol&&vv[i]<=m.bounds.max[c]+tol,'Union bounds');}
 }return viewChunk(sequence,index,b);
}
export function viewChunk(sequence,index,b){
 const s=sequence.manifest.chunks[index];need(s&&b.byteLength===s.byte_length,'Validated size');const v=s.arrays.vertices,j=s.arrays.joints,r=s.arrays.rest_roots,vertices=new Float32Array(b,v.byte_offset,v.byte_length/4),joints=new Float32Array(b,j.byte_offset,j.byte_length/4),roots=new Float32Array(b,r.byte_offset,r.byte_length/4);
 return {buffer:b,vertices,joints,roots,frame(i){need(Number.isInteger(i)&&i>=s.frame_start&&i<s.frame_end_exclusive,'Logical frame range');const local=s.local_first+i-s.frame_start,row=local-s.physical_start;return {vertices:vertices.subarray(row*20670,(row+1)*20670),joints:joints.subarray(row*72,(row+1)*72),root:roots.subarray(row*3,(row+1)*3)};}};
}
