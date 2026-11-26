import {Q} from './85b33f53a8fc4048667a2694a5042450.mjs';
import {need,same,sha,fetchBytes} from './9a793ebf85618c62d84c2b4d0ac9502b.mjs';
import {validateRegistry,resolvePlaylist,chunkIndexForFrame} from './1d82423eb2d3ad9df70711487557912a.mjs';
export {need,same,sha,fetchBytes,chunkIndexForFrame};
export async function openSequence(entry,options={}){
 need(new Uint8Array(new Uint32Array([0x01020304]).buffer)[0]===4,'Little endian required');
 const registry=options.registry??entry.registry;validateRegistry(registry);
 const pb=await fetchBytes(entry.assets['manifest.json'],options);need(await sha(pb)===entry.manifest_sha256,'Playlist hash');const p=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(pb));need(same(p,entry.playlist)&&p.playlist_id===entry.id,'Playlist identity');const plan=resolvePlaylist(p,registry);
 const loaded=new Map();
 for(const s of plan.items){
  if(loaded.has(s.asset_id))continue;const a=s.asset,b=await fetchBytes(a.assets['manifest.json'],options);need(await sha(b)===a.manifest_sha256,'Segment manifest pin');const m=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));
  need(m.schema==='aist-playlist-segment-v1'&&m.version===1&&m.asset_id===a.asset_id&&m.asset_version===a.asset_version&&m.kind===a.kind&&m.style_id===p.style_id&&m.frame_count===a.frame_count&&m.fps===60&&m.duration_seconds===m.frame_count/60,'Segment identity/version');
  need(m.clip_id===a.clip_id&&m.sequence_id===a.sequence_id&&m.source_sha256===a.source_sha256&&same(m.source_frames,a.source_frames)&&same(m.transition,a.transition)&&same(m.acceptance,a.acceptance),'Segment provenance');
  need(m.reference?.manifest_sha256===p.reference_manifest_sha256&&/^[a-f0-9]{64}$/.test(m.inputs_sha256)&&/^[a-f0-9]{64}$/.test(m.model_npz_sha256),'Unverified coordinate/build context');
  if(a.acceptance.qualification_profile==='A4_TECHNICAL_PLUS_HUMAN_V1')need(m.reference.scope==='COORDINATE_ANCHOR_ONLY_NOT_ORIGINAL_ABC_GEOMETRY_REFERENCE'&&m.reference.evidence_profile==='A4_TECHNICAL_PLUS_HUMAN_V1'&&m.reference.A4_numeric_sha256===Q.numeric_evidence_sha256&&a.acceptance.evidence_sha256===Q.human_evidence_sha256,'M3_REFERENCE_PROFILE');
  need(m.vertex_count===6890&&m.joint_count===24&&m.face_count===13776&&m.L_world>0&&same(m.coordinates,{mapping:'identity',unit:'aist_world_unit',model_transform:'identity'}),'Geometry contract');
  need(m.frames?.length===m.frame_count&&m.chunks?.length===Math.ceil(m.frame_count/60)&&Object.keys(a.assets).length===m.chunks.length+2,'Asset coverage');
  need(m.bounds?.min?.length===3&&m.bounds?.max?.length===3&&m.bounds.min.every((v,c)=>Number.isFinite(v)&&Number.isFinite(m.bounds.max[c])&&v<m.bounds.max[c]),'Bounds');
  for(let ci=0;ci<m.chunks.length;ci++){
   const c=m.chunks[ci],st=ci*60,count=Math.min(60,m.frame_count-st),v=count*20670*4,j=count*72*4,r=count*3*4;
   need(c.frame_start===st&&c.frame_end_exclusive===st+count&&c.frame_count===count&&c.file===`frames_${String(st).padStart(4,'0')}.bin`&&c.byte_length===64+v+j+r,'Local chunk coverage');
   need(same(c.arrays,{vertices:{shape:[count,6890,3],dtype:'float32',byte_offset:64,byte_length:v},joints:{shape:[count,24,3],dtype:'float32',byte_offset:64+v,byte_length:j},rest_roots:{shape:[count,3],dtype:'float32',byte_offset:64+v+j,byte_length:r}}),'Segment arrays');need(a.assets[c.file]?.sha256===c.sha256&&a.assets[c.file]?.byte_length===c.byte_length,'Chunk pin');
  }
  for(let i=0;i<m.frames.length;i++)need(m.frames[i].index===i&&['vertices_f32','joints_f32','rest_root_f32'].every(k=>/^[a-f0-9]{64}$/.test(m.frames[i][k])),'Frame hash contract');
  loaded.set(a.asset_id,{descriptor:a,manifest:m});
 }
 // Runtime composition: no complete-sequence binary or precompiled ABC manifest.
 const chunks=[],frames=[],assets={...entry.assets};let globalAt=0;
 for(const s of plan.items){
  const {manifest:m,descriptor:a}=loaded.get(s.asset_id),[lo,hi]=s.asset_frames;
  for(let i=lo;i<hi;i++)frames.push({...m.frames[i],index:globalAt+i-lo,asset_id:a.asset_id,asset_frame:i});
  for(const c of m.chunks){const from=Math.max(lo,c.frame_start),to=Math.min(hi,c.frame_end_exclusive);if(from>=to)continue;const file=a.asset_id+'--'+c.file;assets[file]=a.assets[c.file];chunks.push({...c,file,asset_id:a.asset_id,physical_start:c.frame_start,physical_count:c.frame_count,physical_frames:m.frames.slice(c.frame_start,c.frame_end_exclusive),local_first:from,frame_start:globalAt+from-lo,frame_end_exclusive:globalAt+to-lo,frame_count:to-from});}
  globalAt+=hi-lo;
 }
 const first=loaded.values().next().value,m0=first.manifest;let covered=0;for(const c of chunks){need(c.frame_start===covered,'Virtual chunk gap');covered=c.frame_end_exclusive;}need(covered===p.frame_count&&frames.length===p.frame_count,'Virtual complete coverage');
 for(const {manifest:m} of loaded.values())need(same(m.topology,m0.topology)&&m.L_world===m0.L_world&&m.estimated_floor_y===m0.estimated_floor_y&&m.model_npz_sha256===m0.model_npz_sha256,'Shared actor/topology');
 const ts=m0.topology;need(ts.file==='topology.bin'&&ts.byte_length===165504&&first.descriptor.assets['topology.bin'].sha256===ts.sha256,'Topology pin');const tb=await fetchBytes(first.descriptor.assets['topology.bin'],options);
 const specs={faces:[[13776,3],'uint32',0,165312],joint_ids:[[24],'uint32',165312,96],parent_columns:[[24],'int32',165408,96]};
 for(const [k,[shape,dtype,off,len]] of Object.entries(specs)){const a=ts.arrays[k];need(same(a.shape,shape)&&a.dtype===dtype&&a.byte_offset===off&&a.byte_length===len&&await sha(new Uint8Array(tb,off,len))===a.sha256_c_order,'Topology layout/hash');}
 need(ts.arrays.faces.sha256_c_order==='ad8505aef6d1a4269a5f17705ba293911dd0a4b33b6bb887fabd9f9345728626','Male topology');const faces=new Uint32Array(tb,0,41328),ids=new Uint32Array(tb,165312,24),parents=new Int32Array(tb,165408,24);need(ids.every((x,i)=>x===i)&&same([...parents],[-1,0,0,0,1,2,3,4,5,6,7,8,9,9,9,12,13,14,16,17,18,19,20,21]),'Skeleton');for(let i=0;i<faces.length;i+=3)need(faces[i]<6890&&faces[i+1]<6890&&faces[i+2]<6890&&new Set(faces.subarray(i,i+3)).size===3,'Faces');
 const bounds={min:[0,1,2].map(c=>Math.min(...[...loaded.values()].map(v=>v.manifest.bounds.min[c]))),max:[0,1,2].map(c=>Math.max(...[...loaded.values()].map(v=>v.manifest.bounds.max[c])))};
 return {plan,manifest:{schema:'aist-virtual-playlist-view-v1',frame_count:p.frame_count,fps:60,duration_seconds:p.duration_seconds,frames,chunks,bounds,L_world:m0.L_world,estimated_floor_y:m0.estimated_floor_y},manifestHash:entry.manifest_sha256,faces,ids,parents,topologyBuffer:tb,entry:{...entry,assets}};
}
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
