"""One editor action should merge successive safe batches and preserve Undo."""
from pathlib import Path
import subprocess,tempfile
root=Path(__file__).resolve().parents[1]
js=(root/'private/admin/resolve-duplicates.js').read_text('utf8')
html=(root/'private/admin/resolve-duplicates.html').read_text('utf8')
worker=(root/'private/_worker.js').read_text('utf8')
start=js.index('let autoMergeRunning=false,autoMergeStop=false;')
end=js.index('const idOf=x=>',start)
handler=js[start:end]
assert 'id="safe-stop"' in html and 'id="safe-merge"' in html
assert 'Merge all safe duplicates' in html
assert 'Stop after this batch' in html
assert "await api('/api/admin/nu/duplicates/merge-safe'" in handler
assert 'result.remainingMayExist' in handler
assert 'if(!result.merged||!more)break' in handler
assert '}while(batches<10)' in handler
assert 'autoMergeStop=true' in handler
assert 'await history()' in handler
assert 'await scanSafe()' in handler
assert "if(autoMergeRunning||!safeScan?.proposals?.length)return" in handler
assert "'/api/admin/nu/undo'" in worker
assert 'slice(0,12)' in worker
subprocess.run(['node','--check',str(root/'private/admin/resolve-duplicates.js')],check=True)

test=r"""
const vm=require('vm'),fs=require('fs'),assert=require('assert');
const input=fs.readFileSync(process.argv[2],'utf8');
const elements={};
for(const name of ['safe-merge','safe-scan','safe-stop','safe-status']){
 elements[name]={disabled:false,events:{},textContent:'',addEventListener(name,fn){this.events[name]=fn}};
}
const state={calls:0,history:0,scans:0,text:''};
const ctx={
 $:id=>elements[id],
 safeScan:{proposals:[{sourceId:1}]},
 show:(node,msg)=>{node.textContent=msg;state.text=msg},
 async api(url){
  assert.equal(url,'/api/admin/nu/duplicates/merge-safe');
  state.calls++;
  return state.calls===1?{merged:12,results:[],remainingMayExist:true}:
   {merged:2,results:[],remainingMayExist:false};
 },
 async history(){state.history++},
 async scanSafe(){state.scans++;ctx.safeScan={proposals:[]}},
};
vm.createContext(ctx);
vm.runInContext(input,ctx);
(async()=>{
 await elements['safe-merge'].events.click();
 assert.equal(state.calls,2,'Two bounded batches should be merged by one click');
 assert.equal(state.history,1);
 assert.equal(state.scans,1);
 assert.match(state.text,/14 safe duplicates merged/);
 assert.equal(elements['safe-stop'].disabled,true);
 assert.equal(elements['safe-merge'].disabled,true);
 await elements['safe-merge'].events.click();
 assert.equal(state.calls,2,'No candidates must not trigger more writes');
 console.log('One-click multi-batch safe merge and Undo state: OK');
})().catch(err=>{console.error(err);process.exitCode=1});
"""
with tempfile.NamedTemporaryFile(mode='w',suffix='.js',encoding='utf8') as lib, tempfile.NamedTemporaryFile(mode='w',suffix='.js',encoding='utf8') as testfile:
 lib.write(handler);lib.flush();testfile.write(test);testfile.flush()
 subprocess.run(['node',testfile.name,lib.name],check=True)
print('Multiple bounded merge batches without per-record approvals: OK')
