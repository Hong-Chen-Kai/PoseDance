// M2 display adapter only. Original renderer, geometry, normals and clocks stay.
export * from 'https://esm.sh/three@0.170.0';
import {Mesh as OriginalMesh} from 'https://esm.sh/three@0.170.0';
const actors=new Set();let mode='mesh';
export class Mesh extends OriginalMesh{
 constructor(geometry,material){
  super(geometry,material);
  if(geometry?.attributes?.position?.count===6890&&geometry?.index?.count===41328){
   actors.add(this);this.visible=mode==='mesh';geometry.addEventListener('dispose',()=>actors.delete(this),{once:true});
  }
 }
}
export function setActorMode(value){if(!['mesh','skeleton'].includes(value))throw Error('DISPLAY_MODE');mode=value;for(const mesh of actors)mesh.visible=mode==='mesh';}
export function actorState(){return {mode,trackedActorMeshes:actors.size,visibleActorMeshes:[...actors].filter(x=>x.visible).length,meshUpdateStillRuns:true};}
