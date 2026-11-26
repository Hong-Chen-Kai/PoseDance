// 通用有限狀態循環定位。只有當前/下一個placement，不展開演出或累積路徑。
import {power as acceptedPower,transform} from './accepted-math.mjs';
export {transform};
export const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
const need=(v,m)=>{if(!v)throw Error(m);};
export class ContinuousScheduler{
 constructor(profile){
  need(profile.schema==='posedance-continuous-motion-profile-v1','PROFILE_SCHEMA');this.profile=profile;this.prefix=profile.prefix_frames;this.period=profile.cycle_frames;this.fps=60;this.memo=new Map();
  need(Number.isInteger(this.prefix)&&this.prefix>=0&&Number.isInteger(this.period)&&this.period>1,'SOURCE_TIME');
  need(profile.cycle_segments.reduce((a,x)=>a+x.frames[1]-x.frames[0],0)===this.period,'CYCLE_COVERAGE');
  const {Y,u}=profile.placement;need(Y.length===3&&Y.every(a=>a.length===3&&a.every(Number.isFinite))&&u.length===3&&u.every(Number.isFinite)&&u[1]===0,'SE2_SHAPE');
  need(Math.abs(Y[0][0]-Y[2][2])<1e-12&&Math.abs(Y[0][2]+Y[2][0])<1e-12&&Math.abs(Y[0][0]**2+Y[0][2]**2-1)<1e-12&&Y[1][1]===1&&Y[0][1]===0&&Y[1][0]===0&&Y[1][2]===0&&Y[2][1]===0,'SE2_ISOMETRY');
  this.Y=Y;this.u=u;this.theta=Math.atan2(Y[0][2],Y[0][0]);const det=(1-Y[0][0])*(1-Y[2][2])-Y[0][2]*Y[2][0];
  this.center=Math.abs(det)>1e-20?[( (1-Y[2][2])*u[0]+Y[0][2]*u[2])/det,(Y[2][0]*u[0]+(1-Y[0][0])*u[2])/det]:null;
 }
 locateFrame(f){
  need(Number.isSafeInteger(f)&&f>=0,'NUMERIC_FRAME_DOMAIN');
  if(f<this.prefix)return {logicalFrame:f,poolFrame:f,occurrence:0,cycleFrame:null};
  const t=f-this.prefix,occurrence=Math.floor(t/this.period),cycleFrame=t-occurrence*this.period;
  return {logicalFrame:f,poolFrame:this.prefix+cycleFrame,occurrence,cycleFrame};
 }
 sample(sourceSeconds){
  need(Number.isFinite(sourceSeconds),'SOURCE_SECONDS');const position=Math.max(0,sourceSeconds*60),i=Math.floor(position);need(Number.isSafeInteger(i+1),'NUMERIC_TIME_DOMAIN');
  const left=this.locateFrame(i),right=this.locateFrame(i+1);
  if(left.cycleFrame===this.period-1&&right.cycleFrame===0)right.poolFrame=this.prefix+this.period;
  return {position,alpha:position-i,left,right};
 }
 placement(k){
  need(Number.isSafeInteger(k)&&k>=0,'NUMERIC_OCCURRENCE_DOMAIN');if(this.memo.has(k))return this.memo.get(k);
  let g;
  // 第一個已接受有限範圍逐字沿用原運算；之後用同一SE2群的有界解析式。
  if(k<=47)g=acceptedPower(this.Y,this.u,k);
  else if(this.center){const a=(k*this.theta)%(2*Math.PI),c=Math.cos(a),s=Math.sin(a),[x,z]=this.center;g={r:[c,0,s,0,1,0,-s,0,c],t:[x-c*x-s*z,0,z+s*x-c*z]};}
  else g={r:[1,0,0,0,1,0,0,0,1],t:[k*this.u[0],0,k*this.u[2]]};
  this.memo.set(k,g);while(this.memo.size>2)this.memo.delete(this.memo.keys().next().value);return g;
 }
 inspect(){return {prefixFrames:this.prefix,cycleFrames:this.period,poolFrames:this.prefix+this.period+1,placementMemo:this.memo.size,maxPlacementMemo:2,totalTimelineFrames:null,totalOccurrences:null,termination:'AUDIO_ENDED_OR_USER_STOP',finitePlaylistGenerated:false};}
 renderBounds(){
  const p=this.profile,b=p.cycle_bounds,first=p.prefix_bounds;
  if(!this.center)return {min:[...b.min],max:[...b.max],translationMayTravel:true};
  const [x,z]=this.center;let radius=0;for(const a of [b.min[0],b.max[0]])for(const c of [b.min[2],b.max[2]])radius=Math.max(radius,Math.hypot(a-x,c-z));
  return {min:[Math.min(first.min[0],x-radius),Math.min(first.min[1],b.min[1]),Math.min(first.min[2],z-radius)],max:[Math.max(first.max[0],x+radius),Math.max(first.max[1],b.max[1]),Math.max(first.max[2],z+radius)]};
 }
}
