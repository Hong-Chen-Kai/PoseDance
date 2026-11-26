// 隔離切點循環演出v1；不是正式Graph，不把假設邊送入M3 Registry。
export const LIMITS=Object.freeze({maxFrames:19000,maxSeconds:19000/60,maxItems:128,maxChunks:512,cacheCapacity:4,maxInflight:1});
export const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
const need=(v,m)=>{if(!v)throw Error(m);};
export function plan({mode='short',seed=1}={}){
 need(['short','180','300'].includes(mode),'MODE');need(Number.isSafeInteger(seed)&&seed>=0&&seed<=0xffffffff,'SEED');
 const intro=mode==='short'?0:1757,requested=mode==='short'?null:Number(mode),visits=mode==='short'?1:Math.ceil((requested*60-intro-334)/345);
 const items=[];let at=0;
 const add=(kind,lo,hi,occurrence)=>{items.push({kind,source_frames:[lo,hi],occurrence,output_frames:[at,at+hi-lo]});at+=hi-lo;};
 if(intro)add('formal-b-b01-prefix',0,intro,0);
 for(let n=0;n<visits;n++){add('accepted-b01-source-cut',1757,2091,n);add('new-unaccepted-11-frame-bridge',0,11,n);}
 add('accepted-b01-source-cut',1757,2091,visits);
 need(at<=LIMITS.maxFrames&&items.length<=LIMITS.maxItems,'BOUNDED_LIMIT');
 return {schema:'posedance-experimental-cutloop-performance-v1',scope:'ISOLATED_TRIAL_NOT_FORMAL_GRAPH',mode,seed,selection:'單一待驗閉環，Seed記錄與可重現；未宣稱多個新閉環候選',requested_seconds:requested,seconds:at/60,frame_count:at,fps:60,insertions_per_return:11,new_return_uses:visits,original_source_cut:[15,349],registration:'G^occurrence作用整段與下一接縫，無瞬間Root重設',items,limits:LIMITS,human:'PENDING',contact:'CONTACT_UNVERIFIED',formal_graph_changed:false,exact_requested_duration:requested===null?null:at===requested*60};
}
export function validate(p){need(canonical(p)===canonical(plan({mode:p.mode,seed:p.seed})),'PLAN_MUTATION');return p;}
export function locate(p,f){validate(p);need(Number.isInteger(f)&&f>=0&&f<p.frame_count,'FRAME_RANGE');const i=p.items.find(x=>f>=x.output_frames[0]&&f<x.output_frames[1]);return {...i,source_frame:i.source_frames[0]+f-i.output_frames[0]};}
export function power(Y,u,n){let r=[1,0,0,0,1,0,0,0,1],t=[0,0,0];const A=Y.flat();for(let k=0;k<n;k++){t=[0,1,2].map(i=>A[i*3]*t[0]+A[i*3+1]*t[1]+A[i*3+2]*t[2]+u[i]);r=Array.from({length:9},(_,z)=>{const i=Math.floor(z/3),j=z%3;return A[i*3]*r[j]+A[i*3+1]*r[3+j]+A[i*3+2]*r[6+j];});}return {r,t};}
export function transform(a,g){const out=new Float32Array(a.length),{r,t}=g;for(let k=0;k<a.length;k+=3)for(let i=0;i<3;i++)out[k+i]=r[i*3]*a[k]+r[i*3+1]*a[k+1]+r[i*3+2]*a[k+2]+t[i];return out;}
