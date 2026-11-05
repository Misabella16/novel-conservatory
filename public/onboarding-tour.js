/* First-visit tours: no tracking, no remote requests, no auto-repetition. */
(function(){
'use strict';
const script=document.currentScript;
const site=script&&script.dataset.site==='private'?'private':'public';
const key='conservatory-tour-seen-v3-'+site;
const reduced=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const steps=[
 {title:'Welcome & site access',target:'.hero',action:'discover',
  publicText:'This is the free public catalogue. Discover novels, follow credited translator links and contribute story information without signing in. The public site never provides private EPUB downloads.',
  privateText:'This is the private reading library. Cloudflare Access controls who can enter; permission to read stored EPUBs is separate. Your saved favorites live in this browser.'},
 {title:'Find every section',target:'#library-main-nav',fallback:'#section-menu-toggle',action:'menu',
  publicText:'The top navigation contains Discover, Browse novels, Collections, Translators, My Collections, About & Guide, Submit NU link, and Suggestions. On phones or narrow screens, tap “☰ All sections” to see the complete menu.',
  privateText:'The top navigation contains Discover, Browse novels, Device favorites, Friends’ shelves, Submit EPUB, About, and Sign out. Editors also see Edit Site. On mobile, tap “☰ All sections” to reveal the menu.'},
 {title:'Discover: genres & story tags',target:'#tab-discover .region-section',action:'discover',
  publicText:'Discover is your starting page. Select genre pills to browse that genre, or explore the story-tag library. “Awaiting tags” means the entry has not yet been fully reviewed.',
  privateText:'Discover shows the homepage, genres and story-tag browsing. Choose a genre, or scroll to story tags to discover more specific plots, characters and relationship dynamics.'},
 {title:'Discover: collections shortcuts',target:'#discover-collections-preview',action:'discover',
  publicText:'Just below Genre Shelves, Explore collections opens themed picks, the matchmaker and your own saved collections. These cards are shortcuts, not separate accounts.',
  privateText:'Explore collections sits directly beneath Genre Shelves. Use its cards to open Featured collections, the Matchmaker, Device favorites or Friends’ shelves.'},
 {title:'Browse novels: the complete catalogue',target:'#browse',fallback:'#search',action:'browse',
  publicText:'Browse novels displays the full searchable catalogue, including books without completed tags. Open any book card for its profile, synopsis, translator details and available source links.',
  privateText:'Browse novels displays the private catalogue. Select a book to see full details, source links and, if permitted, your stored EPUB reading options.'},
 {title:'Search within the catalogue',target:'#search',action:'browse',
  publicText:'Search titles, authors, translators or original titles here. You can combine searches with genre, tag, status and exclusion filters.',
  privateText:'Search titles, authors, translators and original titles. Combine search with EPUB availability, status, genre and story-tag filters.'},
 {title:'Sort dropdown: arrange your results',target:'#sort',action:'browse',
  publicText:'Use the Sort dropdown to choose Curated first, Artwork first, Title A–Z, Title Z–A, or Shuffle shelf. Sorting changes the order, not which books exist.',
  privateText:'The Sort dropdown offers Curated first, Artwork first, Title A–Z, Title Z–A and Shuffle shelf. Use it with search and filters to refine your reading list.'},
 {title:'List View: read the details',target:'#view-list',action:'list',
  publicText:'List View shows books with more readable text: title, translator, synopsis and available reviewed tags. Best when comparing several novels.',
  privateText:'List View is best for comparing titles, status, synopsis and available tags. It shows details instead of focusing primarily on cover artwork.'},
 {title:'Cover View: browse visually',target:'#view-covers',action:'covers',
  publicText:'Choose Cover View to see a cover-focused gallery. Use “Compact / Roomy” to change cover density. Real published covers appear when available; other cards use decorative jackets.',
  privateText:'Choose Cover View to browse a visual gallery of covers. The Compact / Roomy button changes how tightly the jackets are arranged.'},
 {title:'The cover hover trick',target:'#books .nu-card .cover',fallback:'#books',action:'covers',
  publicText:'On a desktop, MOVE YOUR POINTER OVER a cover to preview its synopsis and story tags without opening the entire profile. On a phone or tablet, TAP a cover to see its details. Click or tap again to explore the full book.',
  privateText:'On a computer, HOVER over a cover to reveal its summary and story tags. On mobile/touchscreens, TAP a cover to preview or open the full novel profile. The heart saves it to your shelf.'},
 {title:'Open filters and use dropdowns',target:'#filters-toggle',action:'filters',
  publicText:'The ☰ filter button opens advanced filtering. Use Translation status, Genres, Story tags, content warnings and Reviewed descriptions to decide what to see. Clear resets your choices.',
  privateText:'The ☰ filter button opens advanced filtering. Combine translation status, Genres, Story tags, content warnings and EPUB availability. Clear resets filters.'},
 {title:'Include story tags',target:'#tag-picker-open',action:'browse',
  publicText:'“Choose story tags” opens an A–Z list with checkboxes. You can select several tags. This is a SEARCH filter; it does not add or edit metadata on a novel.',
  privateText:'Choose story tags lets you select several tropes using checkboxes. This is a browsing filter, not the editor for a novel’s official tags.'},
 {title:'ANY versus ALL dropdown',target:'#tag-match-mode',action:'discover',
  publicText:'On Discover, after choosing tags, use the Match dropdown: ANY means a novel can match at least one selected tag; ALL requires every selected tag. Apply your choice to browse results.',
  privateText:'On Discover, the Match dropdown offers “Any selected tag” or “All selected tags.” ANY finds more possibilities; ALL narrows books to those matching every chosen tag.'},
 {title:'Exclude story tags you dislike',target:'#exclude-tag-search',action:'filters',
  publicText:'Search inside “Exclude story tags,” then tick unwanted tropes. Books carrying ANY excluded tag disappear, even if they match included tags. Missing tags are unknown and stay visible.',
  privateText:'Select unwanted tropes in “Exclude story tags.” Exclusions take priority over included tags. No tags available does NOT prove a book is free of those themes.'},
 {title:'Content warnings are separate',target:'#warning-filters',action:'filters',
  publicText:'“Avoid content warnings” is separate from excluding story tags. This filter also hides novels with unreviewed warnings rather than claiming they are safe.',
  privateText:'Content warning exclusions are separate from story tropes. Titles without reviewed warning metadata are hidden when you use the warning filter.'},
 ...(site==='private'?[
  {title:'EPUB availability dropdown',target:'#epub-presence-filter',action:'browse',
   privateText:'Private-only EPUB availability dropdown: All novels, With EPUB, Without EPUB, ✓ Verified EPUB only, and EPUB awaiting verification. A soft-yellow card border and 📖 EPUB linked badge mean at least one file exists.'},
  {title:'✓ EPUB verified means owner-reviewed',target:'#epub-presence-filter',fallback:'#books .epub-verified-label',action:'browse',
   privateText:'✓ EPUB verified means the OWNER marked every stored EPUB edition for that novel as perfect. Every EPUB already in this library was initially marked verified at your request. New or replaced files start unverified until reviewed by the owner.'}
 ]:[]),
 {title:'Collections: featured books',target:'#tab-curated .spotlight-section',action:'curated',
  publicText:'Collections opens themed shelves and highlighted picks. Select a featured cover to open a profile, or send the owner a collection suggestion.',
  privateText:'The Featured collections shortcut opens curated book selections. Choose a cover to open its profile or use the Matchmaker below to explore by mood.'},
 {title:'Matchmaker: three dropdowns',target:'#tab-curated .discover-controls',action:'matchmaker',
  publicText:'The Matchmaker has THREE dropdowns: Genre, Trope, and Avoid warning. Choose one or more of those options, then tap “Find a book” for a recommendation from reviewed records.',
  privateText:'The Matchmaker uses Genre, Trope and Avoid dropdowns. Choose your preferences and tap “Find a book.” It selects from reviewed story metadata rather than inventing book information.'},
 {title:'Your saved collections & favorites',target:'#saved-nav',fallback:'#books',action:'saved',
  publicText:'Tap ♡ on any novel to save it. My Collections lets you organize reading lists. They stay in this browser and do not automatically sync to other devices.',
  privateText:'Tap ♡ to save novels to Device favorites. This saved shelf lives in your browser. Friends’ shelves is a separate page for seeing lists shared by other members.'},
 {title:'Tags and reader contributions',target:'#books',action:'browse',
  publicText:'To ADD tags, open a novel → Reader reviews & suggestions → Add story tags directly. Type tags separated by commas and submit. Contributions are shown separately from official editorial tags.',
  privateText:'Readers: open a novel → Reader reviews & suggestions → Suggested tags and submit comma-separated tags for review. Editors: Edit Site → Edit a novel → Tags → Save novel changes the official record.'},
 {title:'Refresh a novel from Novel Updates',target:'#books',action:'browse',
  publicText:'A novel can already have a Novel Updates link and still lack synopsis, story tags, genres or cover art. Open its profile and tap “Refresh details from Novel Updates.” Copy the series URL from Novel Updates, or leave the existing URL prefilled. Choose which fields are missing, then submit. An editor retrieves and reviews the real source metadata. Cover artwork is a reference until credit and permission are checked.'},
 {title:'Other pages, help & sharing',target:'#library-main-nav',fallback:'#section-menu-toggle',action:'menu',
  publicText:'Translators lists credited translation sources; Submit / Refresh NU accepts missing or existing Novel Updates series URLs to request reviewed synopsis, tags, genres or cover reference updates; Suggestions & Questions sends feedback to the editor; About & Guide explains everything. Clear saved data removes local favorites only.',
  privateText:'Friends’ shelves shows shared lists; Submit EPUB sends a private file for owner review; About explains access; Edit Site is for Editors/Owner only. Sign out ends your Cloudflare session, but does not delete saved favorites.'},
 {title:'Ready to explore!',target:'#about-nav',fallback:'#discover-collections-preview',action:'discover',
  publicText:'You have toured the tabs, views, hover covers, filters, dropdowns and contributions. Replay anytime with “✦ Take a tour”; the intro will not automatically repeat after you finish or skip it.',
  privateText:'You have toured the private sections, Cover View, filters, EPUB verification and editing workflows. Use “✦ Take a tour” to replay; it will not automatically repeat on this device.'}
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
card.innerHTML='<div class="tour-head"><span class="tour-kicker" id="conservatory-tour-count"></span><button type="button" class="tour-close" aria-label="Close tutorial">×</button></div><div class="tour-progress" aria-hidden="true"></div><label class="tour-jump-label" for="conservatory-tour-jump">Jump to a section</label><select id="conservatory-tour-jump" aria-label="Jump to a tour section"></select><h2 id="conservatory-tour-heading"></h2><p id="conservatory-tour-copy"></p><div class="tour-footer"><button type="button" class="tour-skip">Skip tutorial</button><div class="tour-buttons"><button type="button" class="tour-back">Back</button><button type="button" class="tour-next">Next →</button></div></div>';
document.body.appendChild(card);
const within=q=>card.querySelector(q);
const jump=within('#conservatory-tour-jump');steps.forEach((step,i)=>{const option=document.createElement('option');option.value=String(i);option.textContent=(i+1)+'. '+step.title;jump.appendChild(option)});
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

function revealMenu(){
 const toggler=document.getElementById('section-menu-toggle'),nav=document.getElementById('library-main-nav');
 if(!toggler||!nav)return;
 if(getComputedStyle(toggler).display!=='none'&&toggler.getAttribute('aria-expanded')!=='true')toggler.click();
}
function hideMenu(){
 const toggler=document.getElementById('section-menu-toggle');
 if(toggler?.getAttribute('aria-expanded')==='true')toggler.click();
}
function curated(){
 hideMenu();
 const panel=document.getElementById('tab-curated');
 if(panel?.hidden){
  const shortcut=document.querySelector('[data-discover-collection="curated"]');
  const nav=document.getElementById('curated-nav');
  if(nav)nav.click();else if(shortcut)shortcut.click();
 }
}
function matchmaker(){
 curated();
 const panel=document.querySelector('#tab-curated .discover-panel');
 if(panel&&panel.getClientRects().length)panel.scrollIntoView({behavior:reduced?'auto':'smooth',block:'start'});
}
function setLayout(mode){
 hideMenu();browse();
 const b=document.getElementById(mode==='list'?'view-list':'view-covers');
 if(b&&b.getAttribute('aria-pressed')!=='true')b.click();
}
function showSaved(){
 hideMenu();
 document.getElementById('saved-nav')?.click();
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
 if(step.action==='menu')revealMenu();
 if(step.action==='browse'){hideMenu();browse()}
 if(step.action==='filters'){hideMenu();filters()}
 if(step.action==='list')setLayout('list');
 if(step.action==='covers')setLayout('covers');
 if(step.action==='curated')curated();
 if(step.action==='matchmaker')matchmaker();
 if(step.action==='saved')showSaved();
 if(step.action==='discover'){hideMenu();document.getElementById('explore-nav')?.click()}
 const target=findTarget(step);
 if(target){
  highlighted=target;target.classList.add('conservatory-tour-target');
  const r=target.getBoundingClientRect();
  if(r.top<115||r.top>window.innerHeight*.44){
   const y=Math.max(0,window.scrollY+r.top-Math.max(115,Math.min(190,window.innerHeight*.22)));
   window.scrollTo({top:y,behavior:reduced?'auto':'smooth'});
  }
 }
 within('#conservatory-tour-count').textContent=(site==='private'?'Private':'Public')+' library · Step '+(index+1)+' of '+steps.length;
 jump.value=String(index);
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
jump.addEventListener('change',()=>{const value=Number(jump.value);if(Number.isSafeInteger(value)&&value>=0&&value<steps.length){index=value;render()}});
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