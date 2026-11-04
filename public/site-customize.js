/* Novel Conservatory public-safe contact/credit and live page copy. */
(()=>{'use strict';
const textSelectors={homeEyebrow:'#tab-discover .hero .eyebrow',homeHeadline:'#tab-discover .hero h1',homeFlavor:'#editable-hero-description',storyTagsHeadline:'#tab-discover .tag-index-section .heading-inline h2',storyTagsFlavor:'#tab-discover .tag-index-section .heading-inline p',browseHeadline:'#tab-covers #section-title',curatedHeadline:'#tab-curated .curated-heading h1',curatedFlavor:'#tab-curated .curated-heading p',noticeText:'.public-notice span'};
function injectFooter(){
 if(document.getElementById('momo-creator-credit'))return;
 const footer=document.createElement('footer');footer.id='momo-creator-credit';footer.setAttribute('aria-label','Website credit and contact');
 footer.style.cssText='font:12px/1.6 system-ui,-apple-system,sans-serif;text-align:center;padding:22px 18px 28px;margin-top:36px;color:#708076;background:#f7f5f0;border-top:1px solid #e2e3d9;';
 const credit=document.createElement('span');credit.textContent='Website created by Momo';footer.appendChild(credit);
 const contact=document.createElement('a');contact.id='momo-instagram-contact';contact.hidden=true;contact.target='_blank';contact.rel='noopener noreferrer';contact.style.cssText='margin-left:12px;color:#3c6654;text-decoration:underline;text-underline-offset:3px;';footer.appendChild(contact);
 document.body.appendChild(footer);
}
function apply(settings){
 for(const [key,selector] of Object.entries(textSelectors)){const value=settings[key];const element=document.querySelector(selector);if(element&&typeof value==='string'&&value.trim())element.textContent=value;}
 const contact=document.getElementById('momo-instagram-contact');
 if(contact){const v=String(settings.instagram||'');if(/^https:\/\/www\.instagram\.com\/[a-zA-Z0-9._]{1,30}\/$/.test(v)){
  contact.href=v;contact.textContent=settings.instagramLabel||'Message Momo on Instagram';contact.hidden=false;
 }else{contact.hidden=true;contact.removeAttribute('href');}}
 document.querySelectorAll('[data-momo-contact]').forEach(anchor=>{
  const v=String(settings.instagram||'');if(/^https:\/\/www\.instagram\.com\/[a-zA-Z0-9._]{1,30}\/$/.test(v)){anchor.href=v;anchor.textContent=settings.instagramLabel||'Message Momo on Instagram';anchor.hidden=false;}else anchor.hidden=true;
 });
}
async function setup(){injectFooter();try{const r=await fetch('/api/site/config',{cache:'no-store'});if(r.ok){const j=await r.json();if(j.settings)apply(j.settings);}}catch{}}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',setup,{once:true});else setup();
})();
