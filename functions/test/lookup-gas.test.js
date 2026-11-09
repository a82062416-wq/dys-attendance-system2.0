'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
function build(){
 const props=new Map();let sequence=0;
 const Utilities={newBlob:s=>({getBytes:()=>Buffer.from(s,'utf8')}),base64Decode:s=>Buffer.from(s,'base64'),computeHmacSha256Signature:(m,k)=>Array.from(crypto.createHmac('sha256',k).update(m).digest()),computeDigest:(_a,m)=>Array.from(crypto.createHash('sha256').update(m).digest()),DigestAlgorithm:{SHA_256:'sha256'},getUuid:()=>String(++sequence).padStart(36,'0'),formatDate:()=> '2026-11-09'};
 const context={Utilities,Date,JSON,Number,Object,Array,String,Math,isFinite,encodeURIComponent,HtmlService:{},ScriptApp:{getOAuthToken:()=> 'fake'},PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k)||null,setProperty:(k,v)=>props.set(k,v)})},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})}};
 vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../../lookup-gas/Code.gs'),'utf8'),context);return context;
}
test('undeployed service fails closed and does not read storage',()=>{
 const c=build();c.getDoc_=()=>{throw Error('unexpected read')};
 assert.equal(c.issuePairCode({token:'fake',employeeId:'00000001'}).ok,false);
 assert.equal(c.lookupEmployee({name:'虛構',suffix:'0042',code:'123456'}).ok,false);
});
test('HMAC serialization matches desktop importer including leading zero',()=>{
 const c=build(),key=Buffer.alloc(32,7),id='00000001',name='虛構同仁',suffix='0042';
 assert.equal(c.docId_(key,id),crypto.createHmac('sha256',key).update('DYS candidate key v1\0'+id,'utf8').digest('hex'));
 assert.equal(c.hmacHex_(key,JSON.stringify([id,name,suffix])),crypto.createHmac('sha256',key).update(JSON.stringify([id,name,suffix]),'utf8').digest('hex'));
});
test('current snapshot and explicit block control eligibility',()=>{
 const c=build(),id='a'.repeat(64),candidate={status:'pending',blocked:false};
 c.getDoc_=()=>({data:{ids:[id],checked_at:new Date().toISOString()}});
 assert.equal(c.usable_(id,candidate),true);
 assert.equal(c.usable_(id,{status:'pending',blocked:true}),false);
 assert.equal(c.usable_(id,{status:'blocked',blocked:false}),false);
 c.getDoc_=()=>({data:{ids:[id],checked_at:'2001-01-01T00:00:00Z'}});assert.equal(c.usable_(id,candidate),false);
});
test('yesterday snapshot expires when the 05:30 daily update is due',()=>{
 const c=build();
 c.Utilities.formatDate=d=>new Date(d.getTime()+8*3600000).toISOString().slice(0,10);
 const previous=Date.parse('2026-11-08T05:31:00+08:00');
 assert.equal(c.sameOperationalDate_(previous,Date.parse('2026-11-09T05:29:00+08:00')),true);
 assert.equal(c.sameOperationalDate_(previous,Date.parse('2026-11-09T05:30:00+08:00')),false);
});
test('rate limit stops sixth attempt using persistent locked state',()=>{
 const c=build();for(let i=0;i<5;i++)assert.equal(c.takeAttempt_('虛構同仁'),true);assert.equal(c.takeAttempt_('虛構同仁'),false);
});
test('one-time redemption requires exact grant and creates binding atomically',()=>{
 const c=build(),key=Buffer.alloc(32,7),id='a'.repeat(64),code='123456',token='b'.repeat(64),name='虛構',suffix='0042';let writes;
 c.getTransactionDocs_=()=>({['secureLookupGrants/'+id]:{data:{used:false,expiresAt:Date.now()+60000,codeHash:c.hmacHex_(key,'grant:'+id+':'+code)},version:'2026-11-09T00:00:00Z'},['secureLookupCandidates/'+id]:{data:{}},'secureLookupSnapshots/current':{data:{}}});
 c.candidateFromDoc_=()=>({employeeId:'00000001',name,fingerprint:c.hmacHex_(key,JSON.stringify(['00000001',name,suffix]))});c.usableSnapshot_=()=>true;
 c.api_=(method,path,body)=>{assert.equal(method,'post');if(path===':beginTransaction')return {transaction:'test-transaction'};if(path===':rollback')return {};assert.equal(path,':commit');assert.equal(body.transaction,'test-transaction');writes=body.writes;return {ok:true};};
 assert.equal(c.redeemGrant_(id,code,token,key,name,suffix),true);
 assert.equal(writes.length,2);assert.equal(writes[0].currentDocument.updateTime,'2026-11-09T00:00:00Z');assert.equal(writes[1].currentDocument.exists,false);
 assert.equal(c.redeemGrant_(id,'999999',token,key,name,suffix),false);
});
test('lookup needs correct name, four digits and one-time or bound device proof',()=>{
 const c=build(),key=Buffer.alloc(32,7),id='a'.repeat(64),employeeId='00000001',name='虛構同仁';let redeemed=false;
 c.ENABLED_=true;c.key_=()=>key;c.takeAttempt_=()=>true;c.usable_=()=>true;
 c.candidateByName_=()=>({id,employeeId,name,status:'pending',blocked:false,fingerprint:c.hmacHex_(key,JSON.stringify([employeeId,name,'0042']))});
 c.redeemGrant_=()=>{if(redeemed)return false;redeemed=true;return true;};
 assert.equal(c.lookupEmployee({name,suffix:'9999',code:'123456'}).ok,false);
 assert.equal(c.lookupEmployee({name,suffix:'0042'}).ok,false);
 const ok=c.lookupEmployee({name,suffix:'0042',code:'123456'});assert.equal(ok.ok,true);assert.equal(ok.employeeId,employeeId);assert.equal(ok.deviceToken.length,64);
 assert.equal(c.lookupEmployee({name,suffix:'0042',code:'123456'}).ok,false);
});
test('revocation also invalidates outstanding one-time grant',()=>{
 const c=build();c.ENABLED_=true;c.verifiedAdmin_=()=> 'admin';c.key_=()=>Buffer.alloc(32,7);
 c.getDoc_=()=>({data:{used:false},version:'2026-11-09T00:00:00Z'});let commit;
 c.api_=(_m,p,b)=>p===':runQuery'?[]:(commit=b,{ok:true});
 const result=c.revokePairings({token:'fake-admin',employeeId:'00000001'});
 assert.equal(result.ok,true);assert.equal(commit.writes.length,1);
 assert.equal(commit.writes[0].update.fields.used.booleanValue,true);
 assert.equal(commit.writes[0].currentDocument.updateTime,'2026-11-09T00:00:00Z');
});
