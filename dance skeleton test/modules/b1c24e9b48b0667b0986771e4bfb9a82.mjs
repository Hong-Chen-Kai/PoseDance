import * as base from './63aee26fb24c28af11cdaae9f322154e.mjs';
export {profile} from './63aee26fb24c28af11cdaae9f322154e.mjs';
export const VERSION='middle-high-positive-handoff-time-v1.0.0';
const bumps=(p)=>p?.timeBumps??[];
function integral(u,b){const width=b.end-b.start,z=Math.max(0,Math.min(1,(u-b.start)/width));return width*(3*z/8-Math.sin(2*Math.PI*z)/(4*Math.PI)+Math.sin(4*Math.PI*z)/(32*Math.PI))}
function density(u,b){return u>b.start&&u<b.end?Math.sin(Math.PI*(u-b.start)/(b.end-b.start))**4:0}
export function duration(n,bpm,profiles,native=false){if(native||!bumps(profiles[n.id]).length)return base.duration(n,bpm,profiles,native);const p=profiles[n.id];return base.duration(n,bpm,profiles)+(n.pool[1]-n.pool[0])*(p.fromBPM+p.toBPM)/(120*bpm)*bumps(p).reduce((s,b)=>s+b.stretch,0)}
export function elapsed(n,u,bpm,profiles,native=false){if(native||!bumps(profiles[n.id]).length)return base.elapsed(n,u,bpm,profiles,native);const p=profiles[n.id];return base.elapsed(n,u,bpm,profiles)+(n.pool[1]-n.pool[0])*(p.fromBPM+p.toBPM)/(120*bpm)*bumps(p).reduce((s,b)=>s+b.stretch/(3*(b.end-b.start)/8)*integral(u,b),0)}
export function rate(id,u,bpm,profiles,native=false){if(native||!bumps(profiles[id]).length)return base.rate(id,u,bpm,profiles,native);const p=profiles[id],oldDen=bpm/base.rate(id,u,bpm,profiles),extra=(p.fromBPM+p.toBPM)/2*bumps(p).reduce((s,b)=>s+b.stretch/(3*(b.end-b.start)/8)*density(u,b),0);return bpm/(oldDen+extra)}
export function fraction(n,t,bpm,profiles,native=false){if(native||!bumps(profiles[n.id]).length)return base.fraction(n,t,bpm,profiles,native);let a=0,b=1;for(let i=0;i<52;i++){const u=(a+b)/2;if(elapsed(n,u,bpm,profiles)<t)a=u;else b=u}return(a+b)/2}
