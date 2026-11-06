// Public-only edge caching. Validate freshness and confidentiality protections
// without connecting to Cloudflare, touching D1, or inspecting private EPUBs.
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {pathToFileURL}=require('node:url');
const {resolve}=require('node:path');
async function main(){
 const mod=await import(pathToFileURL(resolve('public/_worker.js')).href);
 const {withPublicD1Cache}=mod;
 assert.equal(typeof withPublicD1Cache,'function');
 const originalCaches=globalThis.caches;
 const map=new Map(),writes=[],tasks=[];
 const fake={
  async match(request){return map.get(request.url)?.clone()||null;},
  async put(request,response){writes.push(request.url);map.set(request.url,response.clone());}
 };
 globalThis.caches={default:fake};
 const ctx={waitUntil(promise){tasks.push(promise);}};
 const url='https://conservatory.example/api/published/novels';
 let reads=0;
 const fetchData=()=>{reads++;return new Response(JSON.stringify({configured:true,overrides:[{id:1,patch:{title:'Published'}}]}),
  {headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});};
 try{
  const first=await withPublicD1Cache(new Request(url),ctx,fetchData);
  await Promise.all(tasks);
  assert.equal(reads,1);
  assert.equal(first.headers.get('cache-control'),'no-store');
  assert.deepEqual((await first.json()).overrides[0].patch,{title:'Published'});
  assert.equal(writes.length,1);
  assert.equal(map.get(url).headers.get('cache-control'),'public,max-age=60');
  const second=await withPublicD1Cache(new Request(url),ctx,fetchData);
  assert.equal(reads,1,'Cache hit must not touch D1');
  assert.equal(second.headers.get('cache-control'),'no-store');
  assert.equal((await second.json()).configured,true);
  const differentOrigin='https://another.example/api/published/novels';
  await withPublicD1Cache(new Request(differentOrigin),ctx,fetchData);
  assert.equal(reads,2,'Different origin gets separate cache key');
  const otherPublic=[
   ['/api/additional/books',60],['/api/site/config',30],['/api/banner',30]
  ];
  for(const [route,ttl] of otherPublic){
   const endpoint='https://conservatory.example'+route;
   const value=await withPublicD1Cache(new Request(endpoint),ctx,fetchData);
   await Promise.all(tasks);
   assert.equal(value.status,200);
   assert.equal(map.get(endpoint).headers.get('cache-control'),'public,max-age='+ttl);
  }
  let bypass=0;
  const bypassFn=()=>{bypass++;return new Response('{"ok":true}',{headers:{'content-type':'application/json'}});};
  for(const req of [
   new Request(url+'?user=1'),
   new Request(url,{headers:{authorization:'Bearer hidden'}}),
   new Request('https://conservatory.example/api/community/book?id=1'),
   new Request('https://conservatory.example/private/epub'),
   new Request(url,{method:'POST'})
  ])await withPublicD1Cache(req,ctx,bypassFn);
  assert.equal(bypass,5,'Never cache write, query-bearing, authenticated or private routes');
  const before=writes.length;
  await withPublicD1Cache(new Request('https://conservatory.example/api/site/config?foo=bar'),ctx,bypassFn);
  assert.equal(writes.length,before,'Query-bearing request not stored');
  const cookieRoute='https://conservatory.example/api/site/config';
  map.delete(cookieRoute);
  await withPublicD1Cache(new Request(cookieRoute),ctx,()=>new Response('{"secret":1}',
   {headers:{'content-type':'application/json','set-cookie':'auth=sensitive'}}));
  await Promise.all(tasks);
  assert.equal(map.has(cookieRoute),false,'Set-Cookie response is never stored');
  const errorRoute='https://conservatory.example/api/banner';
  map.delete(errorRoute);
  await withPublicD1Cache(new Request(errorRoute),ctx,()=>new Response('{"error":"offline"}',
   {status:503,headers:{'content-type':'application/json'}}));
  await Promise.all(tasks);
  assert.equal(map.has(errorRoute),false,'Errors are never stored');
  globalThis.caches=undefined;
  const fallback=await withPublicD1Cache(new Request(url),ctx,bypassFn);
  assert.equal(fallback.status,200,'No cache object falls back without error');
  const src=readFileSync('public/_worker.js','utf8');
  assert.ok(src.includes("path==='/api/additional/books'&&request.method==='GET'"));
  assert.ok(src.includes("path==='/api/published/novels'&&request.method==='GET'"));
  assert.ok(src.includes("path==='/api/banner'"));
  assert.ok(!src.includes("withPublicD1Cache(request,ctx,()=>communityDispatch"));
  console.log('Public-only cache behavior and safeguards: OK');
 }finally{
  globalThis.caches=originalCaches;
 }
}
main().catch(e=>{console.error(e);process.exitCode=1});
