import {openContinuous,placedSample,sourceInfo} from './pool-reader.mjs';
import {GraphPairCache,futureFrames} from './graph-pair-cache.mjs';
import {createWorkerDecoder} from './legacy/worker-decoder-bounded.js';
import {createView} from './legacy/stream-view.js';
import {setActorMode} from './three-bridge.mjs';
import {createMusicAdapter} from './music/music-adapter.js';
import {bind,musicAtFrame} from './clock-binding.mjs';
import {blend} from './tempo.mjs';
import{guardAudio,sampleForSession,checkSeek}from'./rolling-clock.mjs';
const $=s=>document.querySelector(s),music=createMusicAdapter({makeAudio:()=>$('#audio')});
let plan=null;let pool=null,cache=null,decoder=null,view=null,config=null,binding=null,sample=null,file=null,want=false,phase='WAIT_AUDIO',error=null,pending=0,busy=false,tail=Promise.resolve(),disposed=false,reloads=0,drawn=0,misses=0,maxOccurrence=0,totalEvents=0;
const startupEvidence=[];let paintSerial=0;const resources=[],trace=[];let sync={count:0,sum:0,max:0};
const settings=()=>({bpm:Number($('#bpm').value),tempoMode:$('#tempo').value,offset:Number($('#offset').value),seed:Number($('#seed').value),mode:$('#style').selectedOptions[0]?.dataset.formal==='false'?'alternating':$('#route').value,style:$('#style').value,target_seconds:Number($('#seconds').value)});
function event(type){const a=music.getSnapshot();trace.push({type,music:a.currentTimeSeconds,frame:sample?.position??0,occurrence:sample?.left.occurrence??0});totalEvents++;if(trace.length>64)trace.shift();}
function fail(e){want=false;try{music.pause();}catch{}phase='ERROR';error=e.stack??String(e);$('#error').textContent=error;event('ERROR');publish();}
async function release(){const c=cache,d=decoder,v=view;pool=cache=decoder=view=null;if(c)await c.dispose();else d?.dispose();v?.dispose();if(c){resources.push({cache:c.stats(),worker:d?.stats(),view:v?.inspect()});if(resources.length>16)resources.shift();}}
function atMusic(t,b,scheduler){return sampleForSession(t,b,scheduler,plan);}
async function present(s){
 const a=s.left,b=s.right;cache.setPair(a.poolFrame,b.poolFrame,futureFrames(pool,s));
 let resume=false;if(!cache.frame(a.poolFrame)||!cache.frame(b.poolFrame)){misses++;const media=music.getSnapshot();resume=want&&media.phase!=='ended'&&media.currentTimeSeconds<media.durationSeconds;if(media.phase!=='ended'&&media.currentTimeSeconds<media.durationSeconds)music.pause();phase='BUFFERING';await cache.ensure(a.poolFrame);await cache.ensure(b.poolFrame);}
 const x=placedSample(pool,cache,a),y=placedSample(pool,cache,b);if(!x||!y)throw Error('SOURCE_POOL_MISSING');
 const displayFrame=s.alpha===0?x:blend(x,y,s.alpha);view.show(s.position,displayFrame);view.followRoot?.(displayFrame.root);view.setVisible(true);sample=s;drawn++;maxOccurrence=Math.max(maxOccurrence,a.occurrence);
 if(resume&&want){await music.play();phase='PLAYING';}
}

// 音樂保持暫停，先呈現已取樣的同一幀；只增加開播前準備時間，不修改來源或主時鐘映射。
async function paintBeforeStart(reason){
 const before=music.getSnapshot();if(before.phase==='playing')throw Error('PAINT_REQUIRES_PAUSED_CLOCK');
 view.render();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));view.render();
 const after=music.getSnapshot();if(Math.abs(after.currentTimeSeconds-before.currentTimeSeconds)>1e-4)throw Error('CLOCK_MOVED_DURING_FIRST_PAINT');
 startupEvidence.push({serial:++paintSerial,reason,frame:sample.position,musicBefore:before.currentTimeSeconds,musicAfter:after.currentTimeSeconds,render:view.inspect().rendererCpuMs,camera:view.inspect().camera});if(startupEvidence.length>16)startupEvidence.shift();
}

async function load(s=settings(),chosen=file){
 want=false;try{music.pause();}catch{}phase='LOADING';error=null;$('#error').textContent='';binding=sample=plan=null;file=chosen;await release();publish();
 try{if(!chosen){phase='WAIT_AUDIO';publish();return;}
  const catalog=await(await fetch('./catalog.json',{cache:'no-store'})).json();const selected=catalog.styles.find(e=>e.style===s.style);if(!selected||!Number.isInteger(s.seed)||s.seed<0||s.seed>4294967295)throw Error('舞風或Seed不正確');config={...selected,seed:s.seed,route:s.mode};
  pool=await openContinuous(config);plan=pool.performance;await music.load(chosen);binding=guardAudio(bind(pool.profile,{...s,tempoMode:'native',duration:music.getSnapshot().durationSeconds}),plan);
  view=createView($('#stage'));view.build({...pool,manifest:{...pool.manifest,bounds:pool.renderBounds}});view.options({joints:true,floor:true});setActorMode($('#mode').value);
  decoder=createWorkerDecoder(pool);cache=new GraphPairCache(pool,{decode:decoder.decode,decoderStats:decoder.stats,decoderRecords:decoder.records,disposeDecoder:decoder.dispose});
  await music.seek(binding.offset);await present(atMusic(binding.offset,binding,pool.scheduler));await paintBeforeStart('LOAD');phase='PAUSED';reloads++;drawn=0;maxOccurrence=0;sync={count:0,sum:0,max:0};trace.length=0;totalEvents=0;event('LOADED');publish();
 }catch(e){await release();throw e;}
}
async function play(){if(!binding||!cache||error)return;if(phase==='ENDED'||phase==='STOPPED'){await music.seek(binding.offset);await present(atMusic(binding.offset,binding,pool.scheduler));await paintBeforeStart('RESTART');}want=true;await music.play();phase='PLAYING';event('PLAY');publish();}
function pause(){want=false;try{music.pause();}catch{}if(cache&&!['ENDED','STOPPED'].includes(phase))phase='PAUSED';event('PAUSE');publish();}
function stop(){want=false;try{music.pause();}catch{}if(cache)phase='STOPPED';event('USER_STOP');publish();}
async function replay(){if(!binding||!cache||error)return;pause();await music.seek(binding.offset);await present(atMusic(binding.offset,binding,pool.scheduler));await paintBeforeStart('REPLAY');phase='PAUSED';await play();}
async function seekFrame(f){if(!binding||!cache||error)throw Error('尚未載入');pause();checkSeek(f,binding);const t=musicAtFrame(f,binding);await music.seek(t);await present(atMusic(t,binding,pool.scheduler));phase='PAUSED';event('SEEK');publish();}
function info(){return pool&&sample?sourceInfo(pool,sample):null;}
function inspect(){return {performance:plan,sharedIdentity:pool?.sharedIdentity,registration:pool?.recipe,startupEvidence,phase,error,want,pending,reloads,drawn,misses,frame:sample?.position??0,source:info(),binding,music:music.getSnapshot(),scheduler:pool?.scheduler.inspect(),metadataFrames:pool?.manifest.frames.length,metadataChunks:pool?.manifest.chunks.length,maxOccurrence,cache:cache?.stats(),worker:decoder?.stats(),view:view?.inspect(),resources,retainedTrace:trace.length,totalEvents,sync:{count:sync.count,mean:sync.count?sync.sum/sync.count:0,max:sync.max},finitePlaylistGenerated:false};}
function publish(){
 const a=music.getSnapshot(),i=info();for(const id of ['play','pause','replay','stop','seek'])$('#'+id).disabled=!binding||!cache||!!error;
 $('#song').textContent='歌曲：'+(a.audio?.name??'尚未選擇')+'｜音樂結束停止當前姿態；尚未合成自然收尾';
 $('#performance').textContent=plan?(pool.recipe.formal?'正式Rolling Graph｜'+plan.graph+'｜有限佇列 '+pool.scheduler.inspect().queued+'/8｜可持續分支節點 '+pool.scheduler.inspect().branchNodes.length:'待人工候選｜固定 S→T→S｜不同原始序列；尚未正式登錄，不宣稱Seed多分支'):'選歌或使用測試提示音後載入。';
 $('#sources').textContent=pool?.recipe?.human_status?('人工資格：'+pool.recipe.human_status+'｜'+(pool.recipe.known_limitations??[]).join('；')):'';
 $('#position').textContent='音樂 '+a.currentTimeSeconds.toFixed(3)+' / '+(a.durationSeconds??0).toFixed(3)+' 秒｜倍率 '+(binding?.rate.toFixed(6)??'未套用')+'｜狀態 '+phase;
 $('#current').textContent=i?'目前 '+i.asset+'｜循環 '+i.occurrence+'｜來源幀 '+i.sourceFrame.toFixed(0):'來源：'+(document.documentElement.dataset.style??'House')+'版本化動作資料';
 $('#seek').max=binding?Math.max(0,Math.ceil((binding.audioDuration-binding.offset)*60)-1):0;$('#seek').value=Math.floor(sample?.position??0);
 $('#bpm').disabled=$('#tempo').value==='native';$('#route').disabled=!!pool&&!pool.recipe.formal;
 $('#diagnostics').textContent=JSON.stringify({binding,source:i,scheduler:pool?.scheduler.inspect(),metadataFrames:pool?.manifest.frames.length,metadataChunks:pool?.manifest.chunks.length,cache:cache?.stats(),worker:decoder?.stats(),traceKept:trace.length,totalEvents,sourceAcceptance:pool?.recipe?.status??'尚未載入',loopPhase:'UNVERIFIED',contact:'CONTACT_UNVERIFIED'},null,2);
}
async function tick(){
 if(disposed)return;if(pending){requestAnimationFrame(tick);return;}busy=true;
 try{if(cache&&binding&&!error){const a=music.getSnapshot();if(a.phase==='error')throw Error(a.error?.message||'AUDIO_ERROR');
  if(!['STOPPED','ENDED'].includes(phase)){
   if(a.phase==='ended'){want=false;await present(atMusic(a.currentTimeSeconds,binding,pool.scheduler));phase='ENDED';event('AUDIO_ENDED_CURRENT_POSE_NOT_CHOREOGRAPHED_OUTRO');}
   else await present(atMusic(a.currentTimeSeconds,binding,pool.scheduler));
  }view.render();publish();
 }}catch(e){fail(e);}busy=false;requestAnimationFrame(tick);
}
async function command(fn){if(disposed)throw Error('DISPOSED');if(pending>=12)throw Error('操作過密');pending++;const p=tail.catch(()=>{}).then(async()=>{while(busy)await new Promise(r=>setTimeout(r,5));if(disposed)throw Error('DISPOSED');return fn();});tail=p.catch(()=>{});try{return await p;}finally{pending--;}}
const control=fn=>()=>command(fn).catch(fail);
$('#play').onclick=control(play);$('#pause').onclick=control(pause);$('#replay').onclick=control(replay);$('#stop').onclick=control(stop);
$('#reload').onclick=()=>{const s=settings(),f=file;return command(()=>load(s,f)).catch(fail);};
$('#audiofile').onchange=e=>{const f=e.target.files?.[0],s=settings();if(f)command(()=>load(s,f)).catch(fail);};
$('#seek').oninput=e=>{const f=Number(e.target.value);return command(()=>seekFrame(f)).catch(fail);};
$('#style').onchange=()=>{const s=settings(),f=file;return command(()=>load(s,f)).catch(fail);};
$('#mode').onchange=()=>setActorMode($('#mode').value);$('#tempo').onchange=publish;
$('#download').onclick=()=>{if(!binding)return;const data={profile:pool.profile,binding,audio:music.getSnapshot().audio,currentMusicTime:music.getSnapshot().currentTimeSeconds,recipe:plan,trace,totalEvents,current:info(),status:'CONTACT_UNVERIFIED'},u=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=u;a.download='continuous-autochoreo-record.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);};
async function dispose(){if(disposed)return;disposed=true;want=false;await music.dispose();await release();file=binding=config=sample=null;trace.length=0;$('#audiofile').value='';phase='DISPOSED';}
window.continuousPlayer={inspect,reload:()=>command(()=>load()),seekFrame:f=>command(()=>seekFrame(f)),stop:()=>command(stop),dispose:()=>command(dispose),verifyCache:()=>cache.verify()};
publish();document.addEventListener('visibilitychange',()=>{if(document.hidden)command(pause).catch(()=>{});});window.addEventListener('pagehide',()=>dispose().catch(()=>{}));requestAnimationFrame(tick);

