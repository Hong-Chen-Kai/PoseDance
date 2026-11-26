import {decodeChunk} from './stream-reader.js';
let sequence=null;
self.onmessage=async({data})=>{if(data.type==='init'){sequence={manifest:data.manifest};self.postMessage({type:'ready'});return;}if(data.type!=='decode')return;const {id,index,buffer}=data,t=performance.now();try{await decodeChunk(sequence,index,buffer);self.postMessage({type:'decoded',id,index,buffer,validationWallMs:performance.now()-t},[buffer]);}catch(e){self.postMessage({type:'error',id,index,error:e.message,validationWallMs:performance.now()-t});}};
