// 沿用speedab01 sampleAt與blend；本B01版本只改連續倍率資格與預設幀數。
export const VERSION='b01-tempo-adapter-v1';
export function tempo(targetBPM){if(!Number.isFinite(targetBPM)||targetBPM<97.5||targetBPM>162.5)throw Error('BPM不支援：僅97.5～162.5（0.75～1.25倍）；不會截斷倍率');return {source_music_bpm:130,targetBPM,rate:targetBPM/130,version:VERSION};}
export function sampleAt(music,offset,rate,count=443){
 if(![music,offset,rate].every(Number.isFinite)||(rate<.75||rate>1.25)||!Number.isInteger(count)||count<2)throw Error('TEMPO_SAMPLE');
 const sourceSeconds=(music-offset)*rate,position=Math.max(0,Math.min(count-1,sourceSeconds*60)),lo=Math.floor(position),hi=Math.min(count-1,lo+1);
 return {sourceSeconds,position,lo,hi,alpha:position-lo,phase:sourceSeconds<0?'BEFORE':sourceSeconds>=count/60?'ENDED':'DANCE',performanceDuration:count/60/rate};
}
export function blend(a,b,t){
 if(!Number.isFinite(t)||t<0||t>1)throw Error('BLEND_ALPHA');const out={};
 for(const k of ['vertices','joints','root']){
  if(!(a[k] instanceof Float32Array)||!(b[k] instanceof Float32Array)||a[k].length!==b[k].length||!a[k].every(Number.isFinite)||!b[k].every(Number.isFinite))throw Error('BLEND_INPUT');
  const c=new Float32Array(a[k].length);for(let i=0;i<c.length;i++)c[i]=a[k][i]*(1-t)+b[k][i]*t;out[k]=c;
 }return out;
}
