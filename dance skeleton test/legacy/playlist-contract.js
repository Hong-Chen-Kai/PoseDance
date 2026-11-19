import{need}from'./reader-base.js';
export function chunkIndexForFrame(sequence,frame){
 need(Number.isInteger(frame)&&frame>=0&&frame<sequence.manifest.frame_count,'Chunk frame range');const a=sequence.manifest.chunks;let lo=0,hi=a.length-1;
 while(lo<=hi){const mid=(lo+hi)>>1,s=a[mid];if(frame<s.frame_start)hi=mid-1;else if(frame>=s.frame_end_exclusive)lo=mid+1;else return mid;}throw new Error('Missing virtual chunk');
}
