/* Public catalogue: no login session exists.
   Clear only the two keys used for browser-saved favorites and collections.
   Never touch community submissions, catalogue content, or other site settings. */
(()=>{
'use strict';
const favoritesKey='novel-conservatory-favorites';
const collectionsKey='conservatory-public-personal-collections-v1';
function clearPublicSaved(){
 const approved=window.confirm(
  'Clear ALL saved favorites and personal collections on this browser?\n\n'+
  'This cannot be undone. Your contributions and public catalogue entries will NOT be deleted. '+
  'This does not sign you out of the separate private library.'
 );
 if(!approved)return;
 try{
  localStorage.removeItem(favoritesKey);
  localStorage.removeItem(collectionsKey);
 }catch(e){
  window.alert('Your browser could not clear saved data. Check that local storage is allowed and try again.');
  return;
 }
 // Reloading also resets in-memory collections, active book hearts and counters.
 window.location.reload();
}
for(const id of ['clear-public-saved','clear-public-collections']){
 document.getElementById(id)?.addEventListener('click',clearPublicSaved);
}
})();