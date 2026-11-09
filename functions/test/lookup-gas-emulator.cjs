'use strict';
// Isolated Firestore emulator, fabricated people and manager tokens only.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto'),cp=require('node:child_process'),path=require('node:path');
if(process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:18081')throw Error('demo emulator required');
const props=new Map();let seq=0;
const Utilities={newBlob:s=>({getBytes:()=>Buffer.from(s,'utf8')}),base64Decode:s=>Buffer.from(s,'base64'),computeHmacSha256Signature:(m,k)=>Array.from(crypto.createHmac('sha256',k).update(m).digest()),computeDigest:(_a,m)=>Array.from(crypto.createHash('sha256').update(m).digest()),DigestAlgorithm:{SHA_256:'sha256'},getUuid:()=>String(++seq).padStart(36,'0'),formatDate:()=> '2026-11-09'};
const UrlFetchApp={fetch(url,opts={}){
 if(url.startsWith('https://identitytoolkit.googleapis.com/')){const id=JSON.parse(opts.payload).idToken;return {getResponseCode:()=>id==='valid-test-admin'?200:400,getContentText:()=>JSON.stringify({users:[{localId:'test-admin',email:'test@example.invalid'}]})};}
 if(!url.startsWith('http://127.0.0.1:18081/'))throw Error('external request forbidden');
 const args=['-sS','--max-time','10','-X',(opts.method||'get').toUpperCase(),'-H','Authorization: Bearer owner','-H','Content-Type: application/json','-w','\n%{http_code}'];
 if(opts.payload)args.push('--data-binary',opts.payload);args.push(url);
 const output=cp.execFileSync('curl.exe',args,{encoding:'utf8'}),split=output.lastIndexOf('\n'),body=output.slice(0,split),status=Number(output.slice(split+1));
 return {getResponseCode:()=>status,getContentText:()=>body};
}};
const c={Utilities,UrlFetchApp,Date,JSON,Number,Object,Array,String,Math,isFinite,encodeURIComponent,ScriptApp:{getOAuthToken:()=> 'owner'},PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k)||null,setProperty:(k,v)=>props.set(k,v)})},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})}};
vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(__dirname,'../../lookup-gas/Code.gs'),'utf8'),c);
c.PROJECT_='demo-dys-private-lookup';c.BASE_='http://127.0.0.1:18081/v1/projects/demo-dys-private-lookup/databases/(default)/documents';c.ENABLED_=true;
const key=Buffer.alloc(32,7),id='00000001',name='虛構同仁',suffix='0042',docId=c.docId_(key,id);
function put(path,fields){return c.api_('patch','/'+path,{fields});}
put('secureLookupSecrets/v1',{key:{stringValue:key.toString('base64')}});
put('secureLookupAdmins/test-admin',{active:{booleanValue:true}});
put('secureLookupCandidates/'+docId,{employee_id:{stringValue:id},name:{stringValue:name},fingerprint:{stringValue:c.hmacHex_(key,JSON.stringify([id,name,suffix]))},verification_status:{stringValue:'pending'},active:{booleanValue:false}});
put('secureLookupSnapshots/current',{ids:{arrayValue:{values:[{stringValue:docId}]}},checked_at:{stringValue:new Date().toISOString()},count:{integerValue:'1'}});
assert.equal(c.issuePairCode({token:'invalid',employeeId:id}).ok,false);
const grant=c.issuePairCode({token:'valid-test-admin',employeeId:id});assert.equal(grant.ok,true);assert.match(grant.code,/^\d{6}$/);
assert.equal(c.lookupEmployee({name,suffix:'9999',code:grant.code}).ok,false);
const paired=c.lookupEmployee({name,suffix,code:grant.code});assert.equal(paired.ok,true);assert.equal(paired.employeeId,id);assert.match(paired.deviceToken,/^[a-f0-9]{64}$/);
assert.equal(c.lookupEmployee({name,suffix,code:grant.code}).ok,false);
assert.equal(c.lookupEmployee({name,suffix,deviceToken:paired.deviceToken}).ok,true);
const revoke=c.revokePairings({token:'valid-test-admin',employeeId:id});assert.equal(revoke.ok,true);assert.equal(revoke.revoked,1);
assert.equal(c.lookupEmployee({name,suffix,deviceToken:paired.deviceToken}).ok,false);
console.log('Apps Script adapter + Firestore emulator: admin permission, grant, atomic single use, binding and revocation passed');
