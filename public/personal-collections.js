/* Public Novel Conservatory personal collections. No account and no network writes.
 * This intentionally uses localStorage, never the public/community D1 database.
 */
'use strict';
const PERSONAL_COLLECTIONS_KEY='conservatory-public-personal-collections-v1';
const PERSONAL_COLLECTION_DEFAULTS=['Want to Read','Reading','Finished','Favorites'];
const PERSONAL_COLLECTION_MAX=24;
const PERSONAL_COLLECTION_MAX_BOOKS=10000;
let personalCollections={lists:[],selected:'__all__'};
let personalCurrentBook=null;

function personalCleanIds(ids){
  return Array.isArray(ids) ? [...new Set(ids.filter(n=>Number.isInteger(n)&&n>=1&&(n<=962||n>=100000)))].slice(0,PERSONAL_COLLECTION_MAX_BOOKS) : [];
}
function personalLoad(){
  let raw=null;
  try{raw=JSON.parse(localStorage.getItem(PERSONAL_COLLECTIONS_KEY)||'null')}catch(e){}
  const legacy=(()=>{try{return personalCleanIds(JSON.parse(localStorage.getItem('novel-conservatory-favorites')||'[]'))}catch(e){return []}})();
  let lists=[];
  if(raw&&Array.isArray(raw.lists)){
    const seen=new Set();
    for(const item of raw.lists.slice(0,PERSONAL_COLLECTION_MAX)){
      const name=String(item?.name||'').trim().slice(0,42);
      if(!name||name==='__all__'||seen.has(name.toLocaleLowerCase())||/[<>]/.test(name))continue;
      seen.add(name.toLocaleLowerCase());lists.push({name,books:personalCleanIds(item.books)});
    }
  }
  for(const name of PERSONAL_COLLECTION_DEFAULTS){if(!lists.some(x=>x.name.toLocaleLowerCase()===name.toLocaleLowerCase()))lists.push({name,books:name==='Favorites'?legacy:[]})}
  if(!raw){const fav=lists.find(x=>x.name==='Favorites');fav.books=legacy}
  const selected=typeof raw?.selected==='string'&&lists.some(x=>x.name===raw.selected)?raw.selected:'__all__';
  return {lists,selected};
}
personalCollections=personalLoad();
function personalByName(name){return personalCollections.lists.find(x=>x.name===name)}
function personalCollectionVisibleIds(){
  if(personalCollections.selected==='__all__')return [...new Set(personalCollections.lists.flatMap(x=>x.books))];
  return personalByName(personalCollections.selected)?.books||[];
}
function personalSyncBadge(){
  const count=new Set(personalCollections.lists.flatMap(x=>x.books)).size;
  const badge=document.getElementById('saved-badge');if(badge)badge.textContent=count;
}
function personalPersist(){
  const favoritesList=personalByName('Favorites');
  if(typeof favorites!=='undefined'&&favoritesList)favorites=favoritesList.books.slice();
  try{
    localStorage.setItem(PERSONAL_COLLECTIONS_KEY,JSON.stringify(personalCollections));
    if(favoritesList)localStorage.setItem('novel-conservatory-favorites',JSON.stringify(favoritesList.books));
  }catch(e){}
  personalSyncBadge();
}
function syncFavoriteCollection(){
  const fav=personalByName('Favorites');
  if(fav){fav.books=personalCleanIds(favorites);personalPersist()}
  renderPersonalCollections();
}
function personalCreate(name){
  const value=String(name||'').trim().replace(/\s+/g,' ').slice(0,42);
  if(value.length<2)return 'Enter at least 2 characters.';
  if(value==='__all__'||/[<>]/.test(value))return 'Choose a different collection name.';
  if(personalCollections.lists.some(x=>x.name.toLocaleLowerCase()===value.toLocaleLowerCase()))return 'That collection already exists.';
  if(personalCollections.lists.length>=PERSONAL_COLLECTION_MAX)return 'You have reached the 24-collection limit.';
  personalCollections.lists.push({name:value,books:[]});personalPersist();
  return '';
}
function renderPersonalCollections(){
  const panel=document.getElementById('personal-collections');if(!panel)return;
  panel.hidden=typeof savedOnly!=='undefined'?!savedOnly:true;
  if(panel.hidden)return;
  const select=document.getElementById('personal-collection-select');
  if(!select)return;
  select.replaceChildren();
  const option=(name,label)=>{const opt=document.createElement('option');opt.value=name;opt.textContent=label;select.append(opt)};
  option('__all__','All saved novels');
  for(const list of personalCollections.lists)option(list.name,`${list.name} (${list.books.length})`);
  select.value=personalCollections.selected;
  const count=personalCollectionVisibleIds().length;
  document.getElementById('personal-collection-summary').textContent=`${count} novel${count===1?'':'s'} in this view. Saved to this browser only.`;
  document.getElementById('personal-collection-remove').hidden=PERSONAL_COLLECTION_DEFAULTS.includes(personalCollections.selected)||personalCollections.selected==='__all__';
  personalSyncBadge();
}
function personalDialogRefresh(){
  const container=document.getElementById('personal-collection-checks');if(!container)return;
  container.replaceChildren();
  for(const list of personalCollections.lists){
    const label=document.createElement('label');const check=document.createElement('input');check.type='checkbox';check.value=list.name;
    check.checked=personalCurrentBook!=null&&list.books.includes(personalCurrentBook);
    label.append(check,document.createTextNode(' '+list.name));container.append(label);
  }
}
function openPersonalCollectionPicker(id){
  personalCurrentBook=Number.isInteger(id)&&id>=1&&(id<=962||id>=100000)?id:null;
  const dialog=document.getElementById('personal-collection-dialog');if(!dialog)return;
  const book=personalCurrentBook==null?null:data.find(x=>x.id===personalCurrentBook);
  document.getElementById('personal-collection-book-name').textContent=book?book.title:'Create a collection to organize novels on this device.';
  document.getElementById('new-personal-collection-name').value='';
  document.getElementById('personal-collection-error').textContent='';
  personalDialogRefresh();
  if(!dialog.open)dialog.showModal();
}
function personalFinish(){
  personalPersist();
  const dialog=document.getElementById('personal-collection-dialog');if(dialog?.open)dialog.close();
  if(typeof renderBooks==='function')renderBooks();
  const drawer=document.getElementById('drawer');
  if(drawer?.classList.contains('on')&&personalCurrentBook!=null){const book=data.find(x=>x.id===personalCurrentBook);if(book)renderDetail(book)}
  renderPersonalCollections();
}
window.addEventListener('DOMContentLoaded',()=>{
  const dialog=document.getElementById('personal-collection-dialog');
  const select=document.getElementById('personal-collection-select');
  if(!dialog||!select)return;
  // Favorites from older versions are migrated, not discarded.
  const previousFav=personalByName('Favorites');if(previousFav&&typeof favorites!=='undefined')favorites=previousFav.books.slice();
  personalPersist();
  renderPersonalCollections();
  if(typeof renderBooks==='function')renderBooks();
  select.addEventListener('change',()=>{personalCollections.selected=select.value;personalPersist();renderPersonalCollections();renderBooks()});
  document.getElementById('personal-collection-new').addEventListener('click',()=>openPersonalCollectionPicker(null));
  document.getElementById('personal-collection-remove').addEventListener('click',()=>{
    const name=personalCollections.selected;
    if(PERSONAL_COLLECTION_DEFAULTS.includes(name)||name==='__all__')return;
    if(!window.confirm(`Delete the collection “${name}” on this device? Its books will remain in other collections.`))return;
    personalCollections.lists=personalCollections.lists.filter(x=>x.name!==name);
    personalCollections.selected='__all__';personalPersist();renderPersonalCollections();renderBooks();
  });
  document.getElementById('personal-collection-cancel').addEventListener('click',()=>dialog.close());
  document.getElementById('personal-create-in-dialog').addEventListener('click',()=>{
    const field=document.getElementById('new-personal-collection-name');
    const error=personalCreate(field.value);
    document.getElementById('personal-collection-error').textContent=error;
    if(error)return;
    const name=field.value.trim().replace(/\s+/g,' ').slice(0,42);field.value='';
    personalDialogRefresh();
    // Immediately check this list in the add-to-collection dialog.
    const boxes=[...document.querySelectorAll('#personal-collection-checks input')];
    const box=boxes.find(x=>x.value===name);if(box&&personalCurrentBook!=null)box.checked=true;
    renderPersonalCollections();
  });
  document.getElementById('personal-collection-save').addEventListener('click',()=>{
    if(personalCurrentBook!=null){
      for(const check of document.querySelectorAll('#personal-collection-checks input')){
        const list=personalByName(check.value);if(!list)continue;
        list.books=check.checked
          ?personalCleanIds([...list.books,personalCurrentBook])
          :list.books.filter(n=>n!==personalCurrentBook);
      }
    }
    personalFinish();
  });
});
