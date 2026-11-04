/* First-visit tours: no tracking, no remote requests, no auto-repetition. */
(function(){
'use strict';
const script=document.currentScript;
const site=script&&script.dataset.site==='private'?'private':'public';
const key='conservatory-tour-seen-v2-'+site;
const reduced=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const steps=[
 {title:'Welcome to the Conservatory',target:'.hero',action:'discover',
  publicText:'A free web-novel discovery catalogue. Explore stories, find translators and help the collection grow. You do not need an invitation to browse.',
  privateText:'Welcome to your private reading library. Cloudflare Access controls membership, while EPUB reading has a separate permission. Browse safely without downloading anything.'},
 {title:'Search for a story',target:'#search',action:'browse',
  publicText:'Search novel titles, authors, translators or story terms. Select a book card to see its description, tags and approved outside reading links.',
  privateText:'Search by title, author or translator. Open a novel card to view its description and any reading options available to your account.'},
 {title:'Choose tags you like',target:'#tag-picker-open',action:'browse',
  publicText:'Choose story tags opens the A–Z list. Select several tropes, choose ANY or ALL, then apply. This is a search filter, not a way to add tags to the catalogue.',
  privateText:'Use Choose story tags to select tropes and browse matching books. Combine included tags with genres, translation status and other filters.'},
 {title:'Exclude unwanted story tags',target:'#exclude-tag-search',action:'filters',
  publicText:'Open the filters, search for a tag under Exclude story tags and check it. A book with that tag disappears even if it also matches an included tag. Content warnings have their own separate filter; missing tags never mean safe.',
  privateText:'Exclude story tags hides books carrying the tropes you dislike. For example, include Found family and exclude Tragedy. Exclusions take priority, and missing metadata remains unknown.'},
 ...(site==='private'?[{title:'Spot EPUB-linked novels',target:'#epub-presence-filter',action:'browse',
  privateText:'A soft-yellow border and EPUB linked tag mean the novel has a stored edition. Filter All, With EPUB or Without EPUB. The tag shows presence only; the owner still controls who can read the file.'}]:[]),
 {title:'Keep your reading shelf',target:'#saved-nav',fallback:'#books .favorite',action:'browse',
  publicText:'Tap the heart to save a book, then visit My Collections. Favorites and collections are saved in this browser, not synced automatically between devices.',
  privateText:'Tap the heart to save books on this device. You can also explore friends’ shelves. Device favorites do not automatically sync across browsers.'},
 {title:'How to add new tags',target:'#books .book-card',fallback:'#books',action:'browse',
  publicText:'Open a novel and choose Reader reviews & suggestions, then Add story tags directly. Enter tags separated by commas and submit. They appear as reader contributions, not automatic changes to the official description.',
  privateText:'Open a novel, choose Reader reviews & suggestions, then Suggested tags. Enter comma-separated tags and submit them for review. Editors can instead use Edit Site → Edit a novel → Tags → Save novel to change official tags.'},
 {title:'Ready to explore',target:'#about-nav',fallback:'#books',action:'browse',
  publicText:'Visit About & Guide for more details. You can replay this tour with Take a tour, and contribute a missing book through Suggest a Novel.',
  privateText:'Your library is ready! Replay this tour whenever you like. If a Read online link is absent, ask the owner about separate EPUB reading permission.'}
];
const trigger=document.createElement('button');
trigger.type='button';trigger.id='conservatory-tour-launch';trigger.textContent='✦ Take a tour';
trigger.setAttribute('aria-label','Start an interactive tour of the '+site+' library');
trigger.setAttribute('aria-expanded','false');
document.body.appendChild(trigger);
const card=document.createElement('section');
card.id='conservatory-tour-card';card.hidden=true;card.tabIndex=-1;
card.setAttribute('role','dialog');card.setAttribute('aria-modal','false');
card.setAttribute('aria-labelledby','conservatory-tour-heading');
card.setAttribute('aria-describedby','conservatory-tour-copy');
card.innerHTML='<div class="tour-head"><span class="tour-kicker" id="conservatory-tour-count"></span><button type="button" class="tour-close" aria-label="Close tutorial">×</button></div><div class="tour-progress" aria-hidden="true"></div><h2 id="conservatory-tour-heading"></h2><p id="conservatory-tour-copy"></p><div class="tour-footer"><button type="button" class="tour-skip">Skip tutorial</button><div class="tour-buttons"><button type="button" class="tour-back">Back</button><button type="button" class="tour-next">Next →</button></div></div>';
document.body.appendChild(card);
const within=q=>card.querySelector(q);
let index=0,open=false,highlighted=null,previousFocus=null;
function markSeen(){try{localStorage.setItem(key,'yes')}catch(e){}}
function browse(){
 const panel=document.querySelector('#tab-covers');
 if(panel&&panel.hidden)document.getElementById('covers-nav')?.click();
}
function filters(){
 browse();
 const explorer=document.querySelector('.explorer');
 if(explorer)explorer.classList.add('filters-open');
 document.getElementById('filters-toggle')?.setAttribute('aria-expanded','true');
}
function visible(node){
 if(!node||!node.getClientRects().length)return false;
 const style=getComputedStyle(node);
 return style.display!=='none'&&style.visibility!=='hidden';
}
function findTarget(step){
 for(const selector of [step.target,step.fallback,'#books','#top']){
  if(!selector)continue;
  const el=document.querySelector(selector);
  if(visible(el))return el;
 }
 return null;
}
function clear(){if(highlighted)highlighted.classList.remove('conservatory-tour-target');highlighted=null}
function render(){
 if(!open)return;
 const step=steps[index];
 clear();
 if(step.action==='browse')browse();
 if(step.action==='filters')filters();
 if(step.action==='discover')document.getElementById('explore-nav')?.click();
 const target=findTarget(step);
 if(target){
  highlighted=target;target.classList.add('conservatory-tour-target');
  const r=target.getBoundingClientRect();
  if(r.top<115||r.top>window.innerHeight*.44){
   const y=Math.max(0,window.scrollY+r.top-Math.max(115,Math.min(190,window.innerHeight*.22)));
   window.scrollTo({top:y,behavior:reduced?'instant':'smooth'});
  }
 }
 within('#conservatory-tour-count').textContent=(site==='private'?'Private':'Public')+' library · Step '+(index+1)+' of '+steps.length;
 within('.tour-progress').innerHTML=steps.map((_,i)=>'<span class="'+(i<=index?'active':'')+'"></span>').join('');
 within('#conservatory-tour-heading').textContent=step.title;
 within('#conservatory-tour-copy').textContent=site==='private'?step.privateText:step.publicText;
 within('.tour-back').disabled=index===0;
 within('.tour-next').textContent=index===steps.length-1?'Finish ✓':'Next →';
}
function start(){
 if(open)return;
 previousFocus=document.activeElement;open=true;index=0;
 card.hidden=false;trigger.setAttribute('aria-expanded','true');
 render();card.focus({preventScroll:true});
}
function stop(){
 if(!open)return;
 open=false;clear();card.hidden=true;markSeen();trigger.setAttribute('aria-expanded','false');
 const back=previousFocus&&previousFocus.isConnected?previousFocus:trigger;
 back.focus?.({preventScroll:true});
}
trigger.addEventListener('click',start);
within('.tour-close').addEventListener('click',stop);
within('.tour-skip').addEventListener('click',stop);
within('.tour-next').addEventListener('click',()=>{
 if(index===steps.length-1){stop();return}
 index++;render();within('.tour-next').focus({preventScroll:true});
});
within('.tour-back').addEventListener('click',()=>{
 if(index<=0)return;
 index--;render();within('.tour-back').focus({preventScroll:true});
});
card.addEventListener('keydown',event=>{
 if(event.key==='Escape'){event.preventDefault();stop()}
 else if(event.key==='ArrowRight'){event.preventDefault();within('.tour-next').click()}
 else if(event.key==='ArrowLeft'&&!within('.tour-back').disabled){event.preventDefault();within('.tour-back').click()}
});
document.addEventListener('click',event=>{
 if(site==='private'&&event.target.closest('#start-private-tour')){
  document.getElementById('close-modal')?.click();start();
 }
});
window.addEventListener('load',()=>{
 const params=new URLSearchParams(location.search),forced=params.get('tour')==='1';
 let seen=true;try{seen=localStorage.getItem(key)==='yes'}catch(e){}
 const direct=params.has('novel')||params.has('book')||['#covers','#curated','#shelf'].includes(location.hash);
 if(forced||(!seen&&!direct))setTimeout(start,650);
},{once:true});
})();