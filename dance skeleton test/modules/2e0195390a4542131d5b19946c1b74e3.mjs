import * as base from './63b25653369fed02876e2eefc4fd6d25.mjs';
export {profile} from './63b25653369fed02876e2eefc4fd6d25.mjs';
export const VERSION='middle-u130-coupled-boundary-time-v1.0.0';
const smooth=x=>10*x**3-15*x**4+6*x**5,clamp=x=>Math.max(0,Math.min(1,x));
function integral(u,b){const z=clamp(u/b.entryWidth),y=clamp((u-1+b.exitWidth)/b.exitWidth);return b.entryExtra*b.entryWidth*(z-2.5*z**4+3*z**5-z**6)+b.exitExtra*b.exitWidth*(2.5*y**4-3*y**5+y**6)}
function density(u,b){return b.entryExtra*(1-smooth(clamp(u/b.entryWidth)))+b.exitExtra*smooth(clamp((u-1+b.exitWidth)/b.exitWidth))}
export function duration(n,bpm,p,native=false){const b=p[n.id]?.bodyBoundary;return base.duration(n,bpm,p,native)+(!native&&b?(n.pool[1]-n.pool[0])/(60*bpm)*integral(1,b):0)}
export function elapsed(n,u,bpm,p,native=false){const b=p[n.id]?.bodyBoundary;return base.elapsed(n,u,bpm,p,native)+(!native&&b?(n.pool[1]-n.pool[0])/(60*bpm)*integral(u,b):0)}
export function rate(id,u,bpm,p,native=false){const b=p[id]?.bodyBoundary;if(native||!b)return base.rate(id,u,bpm,p,native);return bpm/(bpm/base.rate(id,u,bpm,p)+density(u,b))}
export function fraction(n,t,bpm,p,native=false){if(native||!p[n.id]?.bodyBoundary)return base.fraction(n,t,bpm,p,native);let a=0,b=1;for(let i=0;i<52;i++){const u=(a+b)/2;if(elapsed(n,u,bpm,p)<t)a=u;else b=u}return(a+b)/2}
