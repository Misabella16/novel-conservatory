import test, {before} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import worker,{verifyAccess} from '../_worker.js';

if(!globalThis.crypto) globalThis.crypto=webcrypto;
const team='https://book-tests.cloudflareaccess.com';
const env={ACCESS_TEAM_DOMAIN:team, ACCESS_AUD:'book-audience', OWNER_EMAIL:'owner@example.com'};
let privateKey, keyInfo, oldFetch;
const encode=v=>Buffer.from(v instanceof Uint8Array || v instanceof ArrayBuffer ? v : (typeof v==='string'?v:JSON.stringify(v))).toString('base64url');
async function jwt(overrides={},mutate=false) {
  const now=Math.floor(Date.now()/1000);
  const header={alg:'RS256',typ:'JWT',kid:'test-rsa'};
  const claims={iss:team,aud:['book-audience'],email:'owner@example.com',exp:now+600,iat:now-2,...overrides};
  const signed=encode(header)+'.'+encode(claims);
  const sig=await crypto.subtle.sign({name:'RSASSA-PKCS1-v1_5'},privateKey,new TextEncoder().encode(signed));
  return signed+'.'+encode(Buffer.from(sig))+(mutate?'x':'');
}
function req(url,token,method='GET',value,origin){
  const headers={'Cf-Access-Jwt-Assertion':token};
  if(origin) headers.origin=origin;
  if(value!==undefined) headers['content-type']='application/json';
  return new Request(url,{method,headers,body:value===undefined?undefined:JSON.stringify(value)});
}
before(async()=>{
  const keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,
    publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  privateKey=keys.privateKey;
  keyInfo={...(await crypto.subtle.exportKey('jwk',keys.publicKey)),kid:'test-rsa',alg:'RS256',use:'sig'};
  oldFetch=globalThis.fetch;
  globalThis.fetch=async url=>{
    assert.equal(url,team+'/cdn-cgi/access/certs');
    return Response.json({keys:[keyInfo]});
  };
});

test('valid Cloudflare Access signature and exact owner email work',async()=>{
  const token=await jwt();
  assert.equal((await verifyAccess(req('https://books.example.com/api/session',token),env)).ok,true);
  const response=await worker.fetch(req('https://books.example.com/api/session',token),{...env,BOOK_DB:{}});
  assert.equal(response.status,200);
  assert.equal((await response.json()).owner,true);
  assert.equal(response.headers.get('cache-control'),'no-store');
});

test('invalid audience, issuer, owner, expiry and tampering are all denied',async()=>{
  for(const claims of [
    {aud:'wrong-audience'}, {iss:'https://evil.example'},
    {email:'friend@example.com'}, {exp:Math.floor(Date.now()/1000)-10},
    {nbf:Math.floor(Date.now()/1000)+500}
  ]) assert.equal((await verifyAccess(req('https://books.example.com/',await jwt(claims)),env)).ok,false);
  assert.equal((await verifyAccess(req('https://books.example.com/',await jwt({},true)),env)).ok,false);
  assert.equal((await verifyAccess(new Request('https://books.example.com/'),env)).ok,false);
});

test('private API and static assets require owner authentication',async()=>{
  let served=false;
  const config={...env,BOOK_DB:{},ASSETS:{fetch:async()=>{served=true;return new Response('private files')}}};
  const missing=await worker.fetch(new Request('https://books.example.com/'),config);
  assert.equal(missing.status,403);assert.equal(served,false);
  const bad=await worker.fetch(req('https://books.example.com/api/books',await jwt({email:'other@example.com'})),config);
  assert.equal(bad.status,403);
  const good=await worker.fetch(req('https://books.example.com/',await jwt()),config);
  assert.equal(good.status,200);assert.equal(served,true);
  assert.match(good.headers.get('content-security-policy'),/frame-ancestors 'none'/);
});

test('cross-origin write requests are rejected before data access',async()=>{
  const token=await jwt();
  const request=req('https://books.example.com/api/books',token,'POST',{title:'New Book'},'https://attacker.example');
  const response=await worker.fetch(request,{...env,BOOK_DB:{}});
  assert.equal(response.status,403);
  const missingOrigin=req('https://books.example.com/api/books',token,'POST',{title:'New Book'});
  assert.equal((await worker.fetch(missingOrigin,{...env,BOOK_DB:{}})).status,403);
});

test('book notes can be updated only via an authenticated same-origin request',async()=>{
  const bookId='11111111-2222-4333-8444-555555555555';
  const current={id:bookId,title:'Sample',author:'Writer',normalized_title:'sample',normalized_author:'writer',
    private_notes:'Old note',updated_at:'2026-11-05T17:00:00.000Z'};
  let audit=0;
  const db={
    prepare(sql) {
      return {bind(...values) {
        return {
          async first(){
            if(sql.startsWith('SELECT * FROM books WHERE id=?')) return {...current};
            return null;
          },
          async run(){
            if(sql.startsWith('UPDATE books SET ')) {
              assert.equal(values[values.length-2],bookId);
              assert.equal(values[values.length-1],current.updated_at);
              current.private_notes=values[0];
              current.updated_at=values[1];
              return {meta:{changes:1}};
            }
            if(sql.startsWith('INSERT INTO change_log ')) {audit++;return {meta:{changes:1}};}
            throw Error('Unexpected SQL '+sql);
          }
        };
      }};
    }
  };
  const token=await jwt();
  const res=await worker.fetch(req('https://books.example.com/api/books/'+bookId,token,'PATCH',
    {private_notes:'A private margin note',expected_updated_at:current.updated_at},'https://books.example.com'),{...env,BOOK_DB:db});
  assert.equal(res.status,200,await res.clone().text());
  const result=await res.json();
  assert.equal(result.item.private_notes,'A private margin note');
  assert.equal(current.private_notes,'A private margin note');
  assert.equal(audit,1);
  const conflict=await worker.fetch(req('https://books.example.com/api/books/'+bookId,token,'PATCH',
    {private_notes:'Stale note',expected_updated_at:'2020-01-01'},'https://books.example.com'),{...env,BOOK_DB:db});
  assert.equal(conflict.status,409);
  assert.equal(current.private_notes,'A private margin note');
});
