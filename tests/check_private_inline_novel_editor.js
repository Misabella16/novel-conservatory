const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const html=fs.readFileSync('private/index.html','utf8');
const source=fs.readFileSync('private/novel/quick-editor.js','utf8');
const css=fs.readFileSync('private/novel/quick-editor.css','utf8');

assert.match(html, /\/novel\/quick-editor\.js/);
assert.match(html, /\/novel\/quick-editor\.css/);
assert.match(html, /id="novel-inline-cover-slot"/);
assert.match(html, /id="novel-inline-info-slot"/);
const infoAt=html.indexOf('id="novel-inline-info-slot"');
assert.ok(infoAt>html.indexOf('<div class="detail-desc">${synopsis}'));
assert.ok(infoAt<html.indexOf('${editionCards(d)}',infoAt),'Editor must precede the translations');
assert.match(html,/ConservatoryQuickEdit\.mount\(d/);
assert.doesNotMatch(html,/a\.textContent='✎ Edit this book'/);
assert.match(css,/\.novel-cover-edit-trigger/);
assert.match(source,/trigger\.id='novel-cover-edit-trigger'/);
assert.match(css,/inset:0/);

class Element{
 constructor(tag){
  this.tagName=tag;this.children=[];this.listeners={};
  this.attributes={};this.hidden=false;this.textContent='';
  this.value='';this.checked=false;this.disabled=false;
  this.files=[];this.className='';
 }
 append(...children){this.children.push(...children);}
 prepend(...children){this.children.unshift(...children);}
 replaceChildren(...children){this.children=[...children];}
 setAttribute(name,value){this.attributes[name]=String(value);}
 removeAttribute(name){delete this.attributes[name];}
 addEventListener(type,callback){this.listeners[type]=callback;}
 focus(){}
 scrollIntoView(){}
 async fire(type,event={}){return this.listeners[type]?.({
  target:this,preventDefault(){},...event});}
}
const findChildren=(root,tag)=>{
 let result=[];
 if(root.tagName===tag)result.push(root);
 for(const child of root.children||[])result=result.concat(findChildren(child,tag));
 return result;
};
const label=(root,labelText)=>{
 for(const item of findChildren(root,'label')){
  if(item.children.some(c=>c.tagName==='span'&&c.textContent===labelText))
   return item.children.find(c=>c.tagName==='input'||c.tagName==='textarea');
 }
 return null;
};
function setup(authorized=true){
 const info=new Element('div'),slot=new Element('div'),cover=new Element('div'),
  drawer=new Element('div');
 drawer.querySelector=selector=>selector==='.detail-head .detail-cover'?cover:null;
 const ids=new Map([
  ['novel-inline-info-slot',info],['novel-inline-cover-slot',slot],
  ['drawer-content',drawer]
 ]);
 const calls=[];
 const root={
  novelConservatoryCanEdit:authorized,
  document:{getElementById:id=>ids.get(id)||null,
   createElement:tag=>new Element(tag)},
  location:{href:''},
  fetch:async(url,opts)=>{
   calls.push({url,opts});
   if(url==='/api/admin/upload'){
    return {ok:true,json:async()=>({ok:true,url:'/media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg'})};
   }
   if(url==='/api/admin/novel'){
    const body=JSON.parse(opts.body);
    return {ok:true,json:async()=>({ok:true,id:body.id,patch:body.patch})};
   }
   return {ok:false,status:404,json:async()=>({error:'Not found'})};
  }
 };
 vm.runInNewContext(source,{window:root,URL,console});
 return {root,info,slot,cover,calls};
}
const book=()=>({id:17,title:'Desharow Merman',author:'Shen Hai Xian Sheng',
 synopsis:'Marine biology adventure',originalTitle:'德萨罗人鱼',
 genres:['Fantasy','Horror'],tags:Array.from({length:30},(_,i)=>'Tag '+(i+1)),
 contentWarnings:['Violence'],cover:'/media/old.jpg'});

(async()=>{
 const viewer=setup(false);
 viewer.root.ConservatoryQuickEdit.mount(book(),()=>{});
 assert.equal(viewer.info.children.length,0);
 assert.equal(viewer.slot.children.length,0);
 assert.equal(viewer.calls.length,0);

 const editor=setup();
 const current=book();
 let latest='';
 editor.root.ConservatoryQuickEdit.mount(current,(_book,message)=>latest=message);
 assert.equal(editor.info.children.length,1);
 assert.equal(editor.slot.children.length,1);
 const section=editor.info.children[0];
 const toggle=section.children[0],form=section.children[1];
 assert.equal(form.hidden,false,'Editing controls should be visible beside synopsis by default');
 await toggle.fire('click');
 assert.equal(form.hidden,true);
 assert.equal(toggle.attributes['aria-expanded'],'false');
 await toggle.fire('click');
 assert.equal(form.hidden,false);
 assert.equal(toggle.attributes['aria-expanded'],'true');
 const title=label(form,'Title');
 assert.ok(title);title.value='Desharow Merman: Updated';
 await form.fire('submit');
 assert.equal(editor.calls.length,1);
 const payload=JSON.parse(editor.calls[0].opts.body);
 assert.equal(payload.id,17);
 assert.deepEqual(Object.keys(payload.patch),['title']);
 assert.equal(payload.patch.title,'Desharow Merman: Updated');
 assert.equal(current.tags.length,30,'Imported tags must be preserved');
 assert.equal(latest,'Novel information saved.');

 const trigger=editor.cover.children[0];
 assert.equal(trigger.tagName,'button');
 assert.equal(trigger.children[0].textContent,'✎ Edit cover');
 const coverPanel=editor.slot.children[0];
 assert.equal(coverPanel.hidden,true);
 await trigger.fire('click',{target:trigger});
 assert.equal(coverPanel.hidden,false,'Tapping cover opens editor');
 assert.equal(trigger.attributes['aria-expanded'],'true');
 const imageUrl=label(coverPanel,'Paste a direct cover image URL');
 imageUrl.value='https://example.org/cover.jpg';
 const save=findChildren(coverPanel,'button').find(x=>x.textContent==='Save cover');
 await save.fire('click');
 const urlSave=JSON.parse(editor.calls[1].opts.body);
 assert.equal(urlSave.patch.cover,'https://example.org/cover.jpg');
 assert.equal(urlSave.patch.coverRights,false,'Private cover must not be published automatically');
 assert.equal(urlSave.patch.privateCover,true,'Owner-selected image must display only in the private catalogue');
 assert.equal(editor.calls.length,2);

 const uploadEditor=setup();
 uploadEditor.root.ConservatoryQuickEdit.mount(book(),()=>{});
 const uploadPanel=uploadEditor.slot.children[0];
 const uploadInput=label(uploadPanel,'Or choose an image from your phone');
 uploadInput.files=[new Blob([new Uint8Array(120)],{type:'image/png'})];
 const uploadSave=findChildren(uploadPanel,'button').find(x=>x.textContent==='Save cover');
 await uploadSave.fire('click');
 assert.equal(uploadEditor.calls[0].url,'/api/admin/upload');
 assert.equal(uploadEditor.calls[0].opts.headers['Content-Type'],'image/png');
 assert.equal(uploadEditor.calls[1].url,'/api/admin/novel');
 assert.equal(JSON.parse(uploadEditor.calls[1].opts.body).patch.cover,
  '/media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg');
 assert.equal(JSON.parse(uploadEditor.calls[1].opts.body).patch.privateCover,true);

 const extra=setup();
 extra.root.ConservatoryQuickEdit.mount({...book(),id:100123},()=>{});
 assert.equal(findChildren(extra.info,'a')[0].href,
  '/admin/add-novels.html?novel=100123');
 assert.equal(extra.calls.length,0);
 console.log('Private inline novel editor and cover controls: OK');
})().catch(error=>{console.error(error);process.exitCode=1});
