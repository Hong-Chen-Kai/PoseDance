const abortError=()=>Object.assign(new Error('Media operation cancelled'),{name:'AbortError'});
const sha=async b=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(v=>v.toString(16).padStart(2,'0')).join('');
export function createMusicAdapter({makeAudio=()=>new Audio(),now=()=>performance.now(),timeoutMs=10000,urls=URL}={}){
 if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw new RangeError('Invalid timeout');
 let audio=null,url=null,generation=0,operation=0,revision=0,phase='idle',error=null,disposed=false,pending=null,loaded=false,info=null,disposeTask=null,loadAbort=null,wantPlaying=false;
 const listeners=new Set(),waiters=new Set(),queue=[];let delivering=false;
 function live(){if(disposed)throw Object.assign(new Error('Media disposed'),{code:'DISPOSED'});}
 function snapshot(){return Object.freeze({mediaId:info?.sha256??null,generation,revision,phase,pending,currentTimeSeconds:audio?.currentTime??0,durationSeconds:loaded?audio.duration:null,playbackRate:audio?.playbackRate??1,seeking:audio?.seeking??false,readyState:audio?.readyState??0,sampledAtMonotonicMs:now(),error:error?Object.freeze({...error}):null,audio:info?Object.freeze({...info}):null});}
 function emit(type){revision++;queue.push(Object.freeze({type,state:snapshot()}));if(delivering)return;delivering=true;try{while(queue.length){const e=queue.shift();for(const f of [...listeners])if(listeners.has(f))try{f(e);}catch{}}}finally{delivering=false;}}
 function stopWaiters(){for(const w of [...waiters])w.cancel();}
 function clear(){wantPlaying=false;loadAbort?.abort();loadAbort=null;stopWaiters();if(audio){audio.pause();audio.removeAttribute('src');audio.load();audio=null;}if(url){urls.revokeObjectURL(url);url=null;}loaded=false;info=null;}
 function wait(a,event,test,g,token){
  if(test())return Promise.resolve();
  return new Promise((resolve,reject)=>{let timer;const finish=e=>{clearTimeout(timer);a.removeEventListener(event,on);a.removeEventListener('error',bad);waiters.delete(w);e?reject(e):resolve();};const on=()=>{if(g!==generation||token!==operation||disposed)return finish(abortError());if(test())finish();};const bad=()=>finish(new Error('Media decode failed'));const w={cancel:()=>finish(abortError())};waiters.add(w);a.addEventListener(event,on);a.addEventListener('error',bad);timer=setTimeout(()=>finish(Object.assign(new Error('Media '+event+' timeout'),{code:'TIMEOUT'})),timeoutMs);});
 }
 function bind(a,g){const signal=loadAbort.signal;for(const type of ['playing','pause','waiting','stalled','seeking','seeked','ended','error','ratechange'])a.addEventListener(type,()=>{
  if(disposed||g!==generation||audio!==a)return;
  if(type==='ratechange'&&a.playbackRate!==1){wantPlaying=false;operation++;stopWaiters();pending=null;a.pause();phase='error';error={code:'UNSUPPORTED_RATE',message:'Only rate 1 is supported'};emit('error');return;}
  if(type==='error'){wantPlaying=false;operation++;stopWaiters();pending=null;phase='error';error={code:'MEDIA_ERROR',message:'Audio decode/playback error'};emit('error');return;}
  if(!loaded)return;
  if(type==='playing'&&!wantPlaying){a.pause();return;}
  if(type==='waiting'||type==='stalled')phase='buffering';
  if(type==='seeking')phase='seeking';
  if(type==='pause'&&!a.ended&&pending!=='seek')phase='paused';
  if(type==='ended')phase='ended';
  // playing is not committed until play() Promise AND event have completed.
  if(type==='playing'&&pending!=='play'&&pending!=='seek')phase='playing';
  if(type==='seeked'&&pending!=='seek')phase=a.paused?'paused':'playing';
  emit(type);
 },{signal});}
 let ready=Promise.resolve(snapshot());
 const api={get ready(){return ready;},
  load(file,{signal}={}){
   live();if(!(file instanceof Blob))return Promise.reject(new TypeError('Select a local audio File/Blob'));
   const g=++generation,token=++operation;clear();loadAbort=new AbortController();phase='loading';pending='load';error=null;emit('loadstart');
   const cancel=()=>{if(g===generation&&!disposed){generation++;operation++;clear();phase='idle';pending=null;emit('loadcancel');}};
   signal?.addEventListener('abort',cancel,{once:true});
   const p=(async()=>{try{
    if(signal?.aborted)throw abortError();const bytes=await file.arrayBuffer(),hash=await sha(bytes);if(g!==generation||disposed||signal?.aborted)throw abortError();
    info={sha256:hash,bytes:file.size,name:file.name||'local-audio',purpose:'TEMPORAL_SYNC_DEMO'};audio=makeAudio();const a=audio;a.preload='auto';a.playbackRate=1;bind(a,g);url=urls.createObjectURL(file);a.src=url;
    const metadata=wait(a,'loadedmetadata',()=>Number.isFinite(a.duration)&&a.duration>0,g,token);a.load();await metadata;
    if(g!==generation||disposed||signal?.aborted)throw abortError();loaded=true;pending=null;phase='ready';emit('loadcomplete');return snapshot();
   }catch(e){if(g===generation&&!disposed){clear();pending=null;phase=e.name==='AbortError'?'idle':'error';error=e.name==='AbortError'?null:{code:e.code||'LOAD_FAILED',message:e.message};emit(error?'error':'loadcancel');}throw e;}finally{signal?.removeEventListener('abort',cancel);}})();ready=p;p.catch(()=>{});return p;
  },
  async play(){live();if(!loaded||phase==='error')throw new Error('No ready media');if(phase==='playing'&&pending===null)return snapshot();if(pending)throw new Error('Media operation pending');
   const a=audio,g=generation,token=++operation;wantPlaying=true;pending='play';phase='ready';emit('playrequest');
   try{const observed=wait(a,'playing',()=>!a.paused&&a.readyState>=3,g,token);observed.catch(()=>{});const requested=Promise.resolve(a.play()).then(()=>{if(disposed||g!==generation||token!==operation&&!wantPlaying)a.pause();});await Promise.all([requested,observed]);if(g!==generation||token!==operation||disposed){if(audio!==a||!wantPlaying)a.pause();throw abortError();}pending=null;phase='playing';emit('play');return snapshot();}
   catch(e){if(g===generation&&token===operation&&!disposed){stopWaiters();a.pause();pending=null;phase='error';error={code:e.name||e.code||'PLAY_FAILED',message:e.message};emit('error');}throw e;}
  },
  pause(){live();if(!loaded)throw new Error('No ready media');wantPlaying=false;operation++;stopWaiters();pending=null;audio.pause();phase=audio.ended?'ended':'paused';emit('pause');return snapshot();},
  async seek(seconds){live();if(!loaded||!Number.isFinite(seconds)||seconds<0||seconds>audio.duration)throw new RangeError('Media seek outside duration');const a=audio,g=generation;operation++;stopWaiters();const token=operation,resume=!a.paused&&phase==='playing';a.pause();pending='seek';phase='seeking';emit('seekrequest');
   try{if(Math.abs(a.currentTime-seconds)>1e-9||a.seeking){const done=wait(a,'seeked',()=>!a.seeking&&Math.abs(a.currentTime-seconds)<=.05,g,token);a.currentTime=seconds;await done;}if(g!==generation||token!==operation||disposed)throw abortError();pending=null;phase='paused';emit('seek');if(resume)await api.play();return snapshot();}
   catch(e){if(g===generation&&token===operation&&!disposed){pending=null;phase='error';error={code:e.code||'SEEK_FAILED',message:e.message};emit('error');}throw e;}
  },
  async replay(){api.pause();await api.seek(0);return api.play();},getSnapshot:snapshot,
  subscribe(f){live();if(typeof f!=='function')throw new TypeError('Listener required');listeners.add(f);return()=>listeners.delete(f);},
  dispose(){if(disposeTask)return disposeTask;let finish;disposeTask=new Promise(r=>{finish=r;});disposed=true;generation++;operation++;clear();pending=null;phase='disposed';emit('disposed');listeners.clear();finish();return disposeTask;}
 };return Object.freeze(api);
}
