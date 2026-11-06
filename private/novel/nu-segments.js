/* NU mobile copy: split text flattened by iOS into actual known labels.
 * Unknown words are flagged for review, not silently saved as invented tags. */
(function(root){
'use strict';
const wordTokens=value=>(String(value||'').normalize('NFKC').replace(/[’‘]/g,"'")
  .replace(/[‐‑–—]/g,'-').match(/[\p{L}\p{N}][\p{L}\p{N}*'-]*/gu)||[]);
const norm=value=>wordTokens(value).map(x=>x.toLocaleLowerCase()).join(' ');
function splitLabels(raw,kind){
 const entries=kind==='genres'?root.ConservatoryNULabels?.genres:root.ConservatoryNULabels?.tags;
 const source=Array.isArray(entries)?entries:[];
 const dict=new Map();
 for(const item of source){const key=norm(item);if(key&&!dict.has(key))dict.set(key,item)}
 const chunks=String(raw||'').replace(/&nbsp;/gi,' ').replace(/\u00a0/g,' ')
  .split(/\s*(?:,|;|\||•|·)\s*/).map(x=>x.trim()).filter(Boolean);
 const labels=[],unknown=[];
 for(const chunk of chunks){
  const tokens=wordTokens(chunk),lc=tokens.map(x=>x.toLocaleLowerCase());
  let index=0,unmatched=[];
  const flush=()=>{if(unmatched.length){unknown.push(unmatched.join(' '));unmatched=[]}};
  while(index<tokens.length){
   let best='',length=0;
   for(let count=Math.min(9,tokens.length-index);count>0;count--){
    const key=lc.slice(index,index+count).join(' ');
    const candidate=dict.get(key);
    if(candidate){best=candidate;length=count;break}
   }
   if(best){
    flush();
    if(!labels.some(x=>norm(x)===norm(best)))labels.push(best);
    index+=length;
   }else{
    unmatched.push(tokens[index]);
    index++;
   }
  }
  flush();
 }
 return {labels:labels.slice(0,100),unresolved:unknown.filter(Boolean).slice(0,60)};
}
root.ConservatoryNUSplit=Object.freeze({splitLabels});
})(window);
