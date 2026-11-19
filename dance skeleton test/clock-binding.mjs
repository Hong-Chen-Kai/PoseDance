// 連續時間無固定frameCount。BPM資格屬舞風profile，不是全系統歌曲限制。
import {tempo} from './accepted-tempo.mjs';
export function bind(profile,{bpm=130,tempoMode='bpm',offset=0,duration,seed=1}){
 if(!Number.isFinite(duration)||duration<=0||!Number.isFinite(offset)||offset<0||offset>=duration)throw Error('起始Offset須介於0與歌曲結尾之間');
 if(!Number.isSafeInteger(seed)||seed<0||seed>0xffffffff)throw Error('SEED');
 let rate=1,qualification='原速預覽，不宣稱歌曲跟拍';
 if(tempoMode==='bpm'){if(profile.style!=='house'||profile.source_bpm!==130)throw Error('此舞風尚無BPM資格，請使用原速預覽');rate=tempo(bpm).rate;qualification='House已驗證範圍的統一倍率，循環相位未驗證';}
 else if(tempoMode!=='native')throw Error('TEMPO_MODE');
 return {schema:'continuous-audio-binding-v1',profile_id:profile.id,style:profile.style,sourceMusicBPM:profile.source_bpm??null,targetBPM:tempoMode==='bpm'?bpm:null,providedSongBPM:Number.isFinite(bpm)&&bpm>0?bpm:null,tempoMode,rate,offset,audioDuration:duration,sourceSecondsAtAudioEnd:(duration-offset)*rate,seed,qualification,endPolicy:'AUDIO_ENDED_OR_USER_STOP',durationRequirement:'不要求預設180/300秒；任何剩餘長度大於0的歌曲都可播放',contact:'CONTACT_UNVERIFIED'};
}
export function atMusic(music,b,scheduler){if(!Number.isFinite(music)||music<0)throw Error('MUSIC_TIME');const sourceSeconds=Math.max(0,(music-b.offset)*b.rate);return {...scheduler.sample(sourceSeconds),musicSeconds:music,sourceSeconds};}
export function musicAtFrame(f,b){if(!Number.isSafeInteger(f)||f<0)throw Error('FRAME');const t=b.offset+f/60/b.rate;if(t>b.audioDuration)throw Error('此來源時間超過歌曲結尾');return t;}
