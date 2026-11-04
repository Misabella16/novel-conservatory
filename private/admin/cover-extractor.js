/* Owner-side EPUB cover extraction. No EPUB bytes leave the browser through this module. */
(()=>{'use strict';
const MB=1048576,MAX_EPUB=250*MB,MAX_IMAGE=16*MB;
function byName(xml,name){return [...xml.getElementsByTagName('*')].filter(n=>n.localName===name)}
function pathFor(opf,href){
 const p=String(href||'').split('#')[0];
 if(!p||/^(?:https?:|data:|\/)/i.test(p))return '';
 try{const pathname=decodeURI(new URL(p,'https://epub.local/'+opf).pathname.slice(1));
  return pathname.startsWith('../')||pathname.includes('/../')?'':pathname;
 }catch{return ''}
}
function mime(path){const ext=String(path).split('.').pop().toLowerCase();return ext==='png'?'image/png':ext==='jpg'||ext==='jpeg'?'image/jpeg':ext==='webp'?'image/webp':''}
async function jpg(blob){
 const bitmap=await createImageBitmap(blob);
 try{const scale=Math.min(1,1800/Math.max(bitmap.width,bitmap.height));
   const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
   const c=canvas.getContext('2d');if(!c)throw Error('Canvas unavailable');c.fillStyle='#fff';c.fillRect(0,0,canvas.width,canvas.height);c.drawImage(bitmap,0,0,canvas.width,canvas.height);
   let result;
   for(const quality of [.82,.67,.48]){result=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));if(result&&result.size>=80&&result.size<=2800000)break}
   if(!result||result.size>2800000)throw Error('Image too large after compression');
   return result;
 }finally{bitmap.close?.()}
}
async function detectCover(file){
 if(typeof JSZip==='undefined')return {image:null,reason:'EPUB ZIP reader unavailable'};
 if(file.size>MAX_EPUB)return {image:null,reason:'EPUB larger than browser cover-scanning limit (250 MiB); EPUB itself can still upload'};
 let z;
 try{z=await JSZip.loadAsync(file)}catch{return {image:null,reason:'Could not inspect EPUB package'}}
 const c=z.file('META-INF/container.xml');if(!c)return {image:null,reason:'EPUB package metadata missing'};
 let doc,opf;
 try{const p=new DOMParser(),cDoc=p.parseFromString(await c.async('text'),'application/xml');
   opf=byName(cDoc,'rootfile')[0]?.getAttribute('full-path');if(!opf||!/\.opf$/i.test(opf)||!z.file(opf))throw Error();
   doc=p.parseFromString(await z.file(opf).async('text'),'application/xml');
 }catch{return {image:null,reason:'EPUB manifest could not be read'}}
 const coverId=byName(doc,'meta').find(n=>n.getAttribute('name')==='cover')?.getAttribute('content');
 const all=byName(doc,'item').map(item=>({id:item.getAttribute('id')||'',path:pathFor(opf,item.getAttribute('href')||''),props:item.getAttribute('properties')||'',type:item.getAttribute('media-type')||''})).filter(row=>mime(row.path)&&z.file(row.path));
 let picks=all.map(row=>({...row,priority:row.props.split(/\s+/).includes('cover-image')?100:coverId&&row.id===coverId?90:/(?:^|[\/_-])(cover|front|titlepage|jacket)(?:[\/_\d.-]|$)/i.test(row.path)?60:0})).filter(row=>row.priority>0).sort((a,b)=>b.priority-a.priority);
 if(!picks.length)return {image:null,reason:'No declared or clearly named cover image found'};
 for(const item of picks){
   const compressed=z.file(item.path);
   if(compressed?._data?.uncompressedSize>MAX_IMAGE)continue;
   try{const bytes=await compressed.async('uint8array');if(bytes.length<80||bytes.length>MAX_IMAGE)continue;
     const jpeg=await jpg(new Blob([bytes],{type:mime(item.path)}));
     return {image:jpeg,path:item.path,reason:''};
   }catch{continue}
 }
 return {image:null,reason:'No usable cover image could be extracted'};
}
window.CoverExtractor={detectCover};
})();
