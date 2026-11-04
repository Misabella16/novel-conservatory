(()=>{'use strict';
const $=id=>document.getElementById(id);
const dialog=$('info-dialog'),remember=$('remember-explanation');
const modalKey='conservatory-public-nu-link-intro-v1';
const showInfo=()=>{if(typeof dialog.showModal==='function'){if(!dialog.open)dialog.showModal();}else{dialog.setAttribute('open','');}};
$('explain').addEventListener('click',showInfo);
$('start').addEventListener('click',()=>{
 try{if(remember.checked)localStorage.setItem(modalKey,'1');else localStorage.removeItem(modalKey)}catch(e){}
 if(typeof dialog.close==='function')dialog.close();else dialog.removeAttribute('open');
 $('nu-url').focus();
});
try{if(localStorage.getItem(modalKey)!=='1')showInfo()}catch(e){showInfo()}
let enabled=false,widgetId=null,token='';
const status=(msg,err=false)=>{$('status').textContent=msg;$('status').classList.toggle('error',err)};
function canonical(raw){
 try{
  const value=new URL(raw.trim());
  const match=/^\/series\/([a-z0-9][a-z0-9-]{0,190})\/?$/.exec(value.pathname);
  if(value.protocol!=='https:'||value.hostname!=='www.novelupdates.com'||value.port||value.username||value.password||value.search||value.hash||!match)return null;
  return 'https://www.novelupdates.com/series/'+match[1]+'/';
 }catch{return null}
}
async function init(){
 try{
  const r=await fetch('/api/site/config',{cache:'no-store'}),j=await r.json();
  if(!r.ok||!j.feedbackEnabled||!j.turnstileSiteKey)throw Error('Link submissions are temporarily unavailable. Please try again later.');
  enabled=true;$('send').disabled=false;
  $('security-note').textContent='Complete the anti-spam check to submit.';
  const script=document.createElement('script');script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';script.async=true;
  script.onload=()=>{widgetId=window.turnstile.render('#challenge',{sitekey:j.turnstileSiteKey,callback:value=>token=value,'expired-callback':()=>token=''})};
  script.onerror=()=>{enabled=false;$('send').disabled=true;status('Security check could not load. Please allow Cloudflare Turnstile or try another browser.',true)};
  document.head.appendChild(script);
  status('Ready to accept a Novel Updates link.');
 }catch(e){status(e.message||'The submission service is unavailable.',true);$('security-note').textContent='Cannot submit until the security service is configured.'}
}
$('nu-form').addEventListener('submit',async e=>{
 e.preventDefault();
 if(!enabled)return;
 const url=canonical($('nu-url').value);
 if(!url){status('Enter an exact HTTPS Novel Updates series URL, such as https://www.novelupdates.com/series/title/',true);$('nu-url').focus();return}
 if(!token){status('Complete the security verification before submitting.',true);return}
 const btn=$('send');btn.disabled=true;
 status('Sending your link to the private review queue…');
 try{
  const r=await fetch('/api/nu-links/submit',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({
    nuUrl:url,name:$('visitor').value.trim(),replyTo:$('reply').value.trim(),note:$('notes').value.trim(),website:$('website').value,turnstile:token
  })});
  const data=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(data.error||'Could not save link');
  status(data.message||'Link received for editorial review.');
  $('nu-form').reset();
 }catch(err){status(err.message||'Could not submit the link.',true)}
 finally{btn.disabled=false;token='';if(widgetId!==null&&window.turnstile)window.turnstile.reset(widgetId)}
});
init();
})();