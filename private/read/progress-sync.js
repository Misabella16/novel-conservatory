/* Account-synced EPUB bookmarks, separate from the existing local fallback.
 * Never stores EPUB content, only a CFI for an authorized account and edition. */
(function(root){
'use strict';
const valid=value=>typeof value==='string'&&value.length<=2048&&(value===''||
 /^epubcfi\([\x20-\x7e]{1,2035}\)$/.test(value)&&!/[<>]/.test(value));
function session({id,edition,onStatus=()=>{},fetcher=fetch,delay=30000}){
 let version=0,remote=null,loaded=false,pending=null,timer=null,inFlight=null,closed=false;
 const endpoint='/api/me/reading-position';
 const status=text=>{try{onStatus(text)}catch{}};
 function requestParams(){return '?id='+encodeURIComponent(id)+'&edition='+encodeURIComponent(edition)}
 async function load(){
  try{
   const response=await fetcher(endpoint+requestParams(),{credentials:'same-origin',cache:'no-store'});
   if(!response.ok)throw Error('Sync unavailable');
   const result=await response.json();
   if(!result?.ok||!result.position||!Number.isSafeInteger(result.position.version)||
      !valid(result.position.cfi))throw Error('Invalid remote bookmark');
   version=result.position.version;remote=result.position;loaded=true;
   return {available:true,exists:!!result.exists,position:remote};
  }catch{
   status('Saved on this device · cloud sync unavailable');
   return {available:false,exists:false,position:null};
  }
 }
 async function send(cfi,keepalive=false){
  if(!loaded)return false;
  const response=await fetcher(endpoint,{method:'POST',credentials:'same-origin',
   headers:{'content-type':'application/json'},keepalive,
   body:JSON.stringify({id,edition,cfi,version})});
  const value=await response.json().catch(()=>({}));
  if(response.status===409){
   if(value.position&&valid(value.position.cfi)&&Number.isSafeInteger(value.position.version)){
    remote=value.position;version=value.position.version;
   }
   status('Another device has a newer bookmark. Continue reading here to update it.');
   return false;
  }
  if(!response.ok||!value.ok||!value.position||!valid(value.position.cfi))
   throw Error(value.error||'Bookmark sync failed');
  version=value.position.version;remote=value.position;
  status(cfi===''?'Reading position reset on this account':'Reading position synced across devices');
  return true;
 }
 function queue(cfi){
  if(closed||!valid(cfi))return;
  pending=cfi;
  if(!loaded){status('Saved on this device · cloud sync unavailable');return}
  if(timer!==null)return; // throttle writes, always use latest position
  timer=setTimeout(()=>{timer=null;void flush()},delay);
 }
 async function flush({keepalive=false}={}){
  if(timer!==null){clearTimeout(timer);timer=null}
  if(inFlight){try{await inFlight}catch{}}
  if(pending===null||!loaded)return false;
  const cfi=pending;pending=null;
  inFlight=send(cfi,keepalive).catch(()=>{
   // A failed network attempt must not discard the last local bookmark.
   status('Saved on this device · cloud sync unavailable');
   return false;
  });
  try{return await inFlight}finally{inFlight=null}
 }
 async function reset(){
  if(timer!==null){clearTimeout(timer);timer=null}
  pending=null;
  if(inFlight){try{await inFlight}catch{}}
  if(!loaded){status('Reset on this device · cloud sync unavailable');return false}
  try{return await send('')}catch{status('Reset on this device · cloud sync unavailable');return false}
 }
 function close(){
  if(timer!==null){clearTimeout(timer);timer=null}
  closed=true;
  // keepalive allows the browser to finish the final save after navigation.
  if(pending!==null&&loaded)void flush({keepalive:true});
 }
 return {load,queue,flush,reset,close,get version(){return version},get loaded(){return loaded}};
}
root.ConservatoryReaderProgress=Object.freeze({session,valid});
})(window);
