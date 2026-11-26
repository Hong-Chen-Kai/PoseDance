import {qualified} from './qualification.mjs';
export const need=(x,m)=>{if(!x)throw new Error(m);};
export const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const hash=x=>/^[a-f0-9]{64}$/.test(x??'');
export function validateRegistry(l){
 need(l?.schema==='aist-playlist-library-v1'&&l.version===1&&Array.isArray(l.styles)&&Array.isArray(l.segments)&&Array.isArray(l.clips),'Library version');
 const styles=new Set(l.styles.map(s=>s.id)),ids=new Set();need(styles.size===l.styles.length&&styles.size>0,'Styles');
 for(const a of l.segments){need(typeof a.asset_id==='string'&&/^[a-z0-9-]+$/.test(a.asset_id)&&!ids.has(a.asset_id),'Asset ID');ids.add(a.asset_id);need(styles.has(a.style_id)&&a.asset_version==='1.0.0'&&['clip','transition'].includes(a.kind)&&Number.isSafeInteger(a.frame_count)&&a.frame_count>0&&a.fps===60&&hash(a.manifest_sha256),'Asset contract');need(qualified(a)&&a.acceptance?.contact==='CONTACT_UNVERIFIED','Unverified asset');
  if(a.kind==='clip')need(typeof a.clip_id==='string'&&typeof a.sequence_id==='string'&&hash(a.source_sha256)&&Array.isArray(a.source_frames)&&a.source_frames[1]-a.source_frames[0]===a.frame_count,'Clip identity/range');
  else need(a.transition&&typeof a.transition.transition_id==='string'&&typeof a.transition.from_clip_id==='string'&&typeof a.transition.to_clip_id==='string'&&a.transition.inserted_frames===a.frame_count&&a.transition.endpoint_gap_seconds===(a.frame_count+1)/60&&hash(a.transition.recipe_sha256),'Transition provenance');
 }
 const playlists=new Set();for(const e of l.clips){need(typeof e.id==='string'&&!playlists.has(e.id)&&hash(e.manifest_sha256),'Playlist identity');playlists.add(e.id);resolvePlaylist(e.playlist,l);need(e.frame_count===e.playlist.frame_count&&e.fps===60&&e.duration_seconds===e.playlist.duration_seconds,'Entry time');}return true;
}
export function resolvePlaylist(p,registry){
 need(p.extension_version==='autochoreo-m3-qualified-graph-v1'&&p.reference_policy==='MIXED_EVIDENCE_WITH_COMMON_COORDINATE_ANCHOR','M3_PLAYLIST_VERSION');
 need(p?.schema==='aist-executable-playlist-v1'&&p.version===1&&p.playlist_version==='1.0.0','Unsupported Playlist version');
 need(typeof p.playlist_id==='string'&&registry.styles.some(s=>s.id===p.style_id)&&p.fps===60&&Number.isSafeInteger(p.frame_count)&&p.frame_count>0&&p.frame_count<=10000&&p.duration_seconds===p.frame_count/60,'Playlist time/style');
 need(Array.isArray(p.items)&&p.items.length>0&&p.items.length<=128,'Playlist items');const itemIds=new Set();let at=0;
 const items=p.items.map((s,index)=>{
  need(typeof s.item_id==='string'&&!itemIds.has(s.item_id),'Item identity');itemIds.add(s.item_id);const a=registry.segments.find(a=>a.asset_id===s.asset_id);need(a,'Missing asset '+s.asset_id);
  need(a.style_id===p.style_id&&a.asset_version===s.asset_version&&a.manifest_sha256===s.manifest_sha256&&a.kind===s.kind,'Asset version/hash/style mismatch');need(qualified(a),'Unverified asset '+a.asset_id);
  need(Array.isArray(s.asset_frames)&&s.asset_frames.length===2,'Asset range');const [lo,hi]=s.asset_frames;need(Number.isInteger(lo)&&Number.isInteger(hi)&&lo>=0&&hi<=a.frame_count&&hi>lo&&same(s.output_frames,[at,at+hi-lo]),'Timeline gap/range');at+=hi-lo;
  if(a.kind==='clip')need(s.clip_id===a.clip_id&&same(s.source_frames,[a.source_frames[0]+lo,a.source_frames[0]+hi])&&s.transition===null,'Clip/source mapping');
  else need(lo===0&&hi===a.frame_count&&same(s.transition,a.transition)&&s.clip_id===null&&s.source_frames===null,'Partial or mismatched transition');
  return {...s,index,asset:a};
 });
 need(at===p.frame_count&&items[0].kind==='clip'&&items.at(-1).kind==='clip','Complete timeline endpoints');
 for(let i=0;i<items.length;i++){
  const s=items[i];if(s.kind==='transition'){const left=items[i-1],right=items[i+1],t=s.transition;need(left?.kind==='clip'&&right?.kind==='clip'&&left.clip_id===t.from_clip_id&&right.clip_id===t.to_clip_id&&left.source_frames[1]-1===t.from_source_frame&&right.source_frames[0]===t.to_source_frame,'Transition endpoint incompatibility');}
  else if(i>0)need(items[i-1].kind==='transition','Unverified direct clip cut');
 }
 return {playlist:p,items,frame_count:at,fps:60};
}
export function locateFrame(plan,frame){
 need(Number.isInteger(frame)&&frame>=0&&frame<plan.frame_count,'Frame range');const s=plan.items.find(s=>frame>=s.output_frames[0]&&frame<s.output_frames[1]);need(s,'Missing timeline interval');const offset=frame-s.output_frames[0];return Object.freeze({frame,itemId:s.item_id,kind:s.kind,assetId:s.asset_id,assetFrame:s.asset_frames[0]+offset,clipId:s.clip_id,sequenceId:s.asset.sequence_id,sourceFrame:s.kind==='clip'?s.source_frames[0]+offset:null,transitionId:s.transition?.transition_id??null});
}
export function chunkIndexForFrame(sequence,frame){
 need(Number.isInteger(frame)&&frame>=0&&frame<sequence.manifest.frame_count,'Chunk frame range');const a=sequence.manifest.chunks;let lo=0,hi=a.length-1;
 while(lo<=hi){const mid=(lo+hi)>>1,s=a[mid];if(frame<s.frame_start)hi=mid-1;else if(frame>=s.frame_end_exclusive)lo=mid+1;else return mid;}throw new Error('Missing virtual chunk');
}
