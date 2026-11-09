/* Standalone, isolated Apps Script candidate. Not yet deployed or enabled. */
var PROJECT_='dys-attendance-a5be6';
var ENABLED_=false;
var BASE_='https://firestore.googleapis.com/v1/projects/'+PROJECT_+'/databases/(default)/documents';

function doGet(){
 var html=LOOKUP_HTML_;
 return HtmlService.createHtmlOutput(html.replace('__PUBLIC_FIREBASE_WEB_API_KEY__',publicApiKey_())).setTitle('同仁工號查詢');
}

// The only RPC methods: issue requires a verified manager; lookup requires a
// one-time manager grant or a previously bound device, plus name and suffix.
function issuePairCode(request){
 try{
  if(!ENABLED_||!request||typeof request.token!=='string'||!/^\d{8}$/.test(request.employeeId||''))return {ok:false};
  var lock=LockService.getScriptLock();if(!lock.tryLock(5000))return {ok:false};
  try{
  var uid=verifiedAdmin_(request.token);if(!uid)return {ok:false};
  var key=key_(),id=docId_(key,request.employeeId),candidate=candidateById_(id);
  if(!usable_(id,candidate))return {ok:false};
  var code=generateCode_(key),expires=Date.now()+600000;
  if(!saveGrant_(id,code,expires,uid,key))return {ok:false};
  return {ok:true,code:code,expiresInSeconds:600};
  }finally{lock.releaseLock();}
 }catch(e){return {ok:false};}
}

function lookupEmployee(request){
 try{
  if(!ENABLED_||!request||typeof request.name!=='string'||!request.name.trim()||request.name.trim().length>80||!/^\d{4}$/.test(request.suffix||''))return {ok:false};
  var name=request.name.trim(),hasCode=/^\d{6}$/.test(request.code||''),hasToken=/^[a-f0-9]{64}$/.test(request.deviceToken||'');
  if(hasCode===hasToken||!takeAttempt_(name))return {ok:false};
  var candidate=candidateByName_(name),key=key_();
  if(!candidate||candidate.name!==name||!usable_(candidate.id,candidate))return {ok:false};
  var fp=hmacHex_(key,JSON.stringify([candidate.employeeId,name,request.suffix]));
  if(!equal_(fp,candidate.fingerprint))return {ok:false};
  if(hasToken){
   if(!verifyBoundLookup_(candidate.id,request.deviceToken,key,name,request.suffix))return {ok:false};
   return {ok:true,employeeId:candidate.employeeId};
  }
  var token=hmacHex_(key,'device:'+Utilities.getUuid()+':'+Utilities.getUuid()+':'+Date.now());
  if(!redeemGrant_(candidate.id,request.code,token,key,name,request.suffix))return {ok:false};
  return {ok:true,employeeId:candidate.employeeId,deviceToken:token};
 }catch(e){return {ok:false};}
}

function revokePairings(request){
 try{
  if(!ENABLED_||!request||typeof request.token!=='string'||!/^\d{8}$/.test(request.employeeId||''))return {ok:false};
  var lock=LockService.getScriptLock();if(!lock.tryLock(5000))return {ok:false};
  try{
  if(!verifiedAdmin_(request.token))return {ok:false};
  var id=docId_(key_(),request.employeeId);
  var rows=api_('post',':runQuery',{structuredQuery:{from:[{collectionId:'secureLookupBindings'}],where:{fieldFilter:{field:{fieldPath:'candidateId'},op:'EQUAL',value:{stringValue:id}}},limit:51}})||[];
  var docs=rows.filter(function(row){return row.document;}).map(function(row){return row.document;});
  if(docs.length>50)return {ok:false};
  var writes=[];
  docs.forEach(function(doc){if(decode_(doc.fields).active===true)writes.push({update:{name:doc.name,fields:{active:{booleanValue:false}}},updateMask:{fieldPaths:['active']},currentDocument:{updateTime:doc.updateTime}});});
  var grant=getDoc_('secureLookupGrants/'+id);
  if(grant&&grant.data.used===false)writes.push({update:{name:'projects/'+PROJECT_+'/databases/(default)/documents/secureLookupGrants/'+id,fields:{used:{booleanValue:true}}},updateMask:{fieldPaths:['used']},currentDocument:{updateTime:grant.version}});
  if(writes.length&&!api_('post',':commit',{writes:writes}))return {ok:false};
  return {ok:true,revoked:docs.filter(function(doc){return decode_(doc.fields).active===true;}).length};
  }finally{lock.releaseLock();}
 }catch(e){return {ok:false};}
}

function api_(method,path,body){
 var opts={method:method,headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},muteHttpExceptions:true};
 if(body!==undefined){opts.contentType='application/json';opts.payload=JSON.stringify(body);}
 var res=UrlFetchApp.fetch(BASE_+path,opts),status=res.getResponseCode();
 if(status===404)return null;
 if(status<200||status>=300)throw Error('private store unavailable');
 return JSON.parse(res.getContentText());
}
function decode_(fields){
 var data={};Object.keys(fields||{}).forEach(function(k){var f=fields[k];
  if(Object.prototype.hasOwnProperty.call(f,'stringValue'))data[k]=f.stringValue;
  else if(Object.prototype.hasOwnProperty.call(f,'booleanValue'))data[k]=f.booleanValue;
  else if(Object.prototype.hasOwnProperty.call(f,'integerValue'))data[k]=Number(f.integerValue);
  else if(f.arrayValue)data[k]=(f.arrayValue.values||[]).map(function(x){return x.stringValue;});
 });return data;
}
function getDoc_(path,transaction){var doc=api_('get','/'+path+(transaction?'?transaction='+encodeURIComponent(transaction):''));return doc?{data:decode_(doc.fields),version:doc.updateTime,name:doc.name}:null;}
function key_(){var doc=getDoc_('secureLookupSecrets/v1');if(!doc||typeof doc.data.key!=='string')throw Error('key unavailable');var bytes=Utilities.base64Decode(doc.data.key);if(bytes.length!==32)throw Error('invalid key');return bytes;}
function publicApiKey_(){var doc=getDoc_('secureLookupSecrets/v1'),value=doc&&doc.data.webApiKey;if(typeof value!=='string'||!/^AIza[A-Za-z0-9_-]{30,60}$/.test(value))throw Error('web configuration unavailable');return value;}
function bytes_(value){return Utilities.newBlob(value,'text/plain').getBytes();}
function hex_(bytes){return bytes.map(function(n){return ('0'+((n+256)%256).toString(16)).slice(-2);}).join('');}
function hmacHex_(key,value){return hex_(Utilities.computeHmacSha256Signature(bytes_(value),key));}
function shaHex_(value){return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,bytes_(value)));}
function docId_(key,id){return hmacHex_(key,'DYS candidate key v1\u0000'+id);}
function equal_(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;var mismatch=0;for(var i=0;i<a.length;i++)mismatch|=a.charCodeAt(i)^b.charCodeAt(i);return mismatch===0;}

function candidateById_(id,transaction){
 return candidateFromDoc_(id,getDoc_('secureLookupCandidates/'+id,transaction));
}
function candidateFromDoc_(id,doc){
 if(!doc)return null;var d=doc.data;
 if(!/^\d{8}$/.test(d.employee_id||'')||typeof d.name!=='string'||!/^[a-f0-9]{64}$/.test(d.fingerprint||''))return null;
 return {id:id,employeeId:d.employee_id,name:d.name,fingerprint:d.fingerprint,status:d.verification_status,blocked:d.manual_blocked===true};
}
function getTransactionDocs_(transaction,paths){
 var root='projects/'+PROJECT_+'/databases/(default)/documents/';
 var rows=api_('post',':batchGet',{documents:paths.map(function(p){return root+p;}),transaction:transaction}),result={};
 if(!Array.isArray(rows))throw Error('invalid transaction response');
 rows.forEach(function(row){if(row.found){var doc=row.found,path=doc.name.slice(root.length);result[path]={data:decode_(doc.fields),version:doc.updateTime,name:doc.name};}});
 return result;
}
function candidateByName_(name){
 var response=api_('post',':runQuery',{structuredQuery:{from:[{collectionId:'secureLookupCandidates'}],where:{fieldFilter:{field:{fieldPath:'name'},op:'EQUAL',value:{stringValue:name}}},limit:2}});
 var docs=(response||[]).filter(function(x){return x.document;}).map(function(x){return x.document;});
 if(docs.length!==1)return null;
 var id=docs[0].name.split('/').pop();if(!/^[a-f0-9]{64}$/.test(id))return null;
 return candidateById_(id);
}
function sameOperationalDate_(checkedAt,now){
 var shift=19800000;
 return Utilities.formatDate(new Date(checkedAt-shift),'Asia/Taipei','yyyy-MM-dd')===Utilities.formatDate(new Date(now-shift),'Asia/Taipei','yyyy-MM-dd');
}
function usable_(id,candidate){
 return usableSnapshot_(id,candidate,getDoc_('secureLookupSnapshots/current'));
}
function usableSnapshot_(id,candidate,snap){
 if(!candidate||candidate.blocked||['pending','verified'].indexOf(candidate.status)<0)return false;
 if(!snap||!Array.isArray(snap.data.ids))return false;
 var when=Date.parse(snap.data.checked_at),age=Date.now()-when;
 return isFinite(when)&&age>=-300000&&age<=129600000&&sameOperationalDate_(when,Date.now())&&snap.data.ids.indexOf(id)>=0;
}
function verifiedAdmin_(token){
 if(token.length>4096)return null;
 var res=UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key='+encodeURIComponent(publicApiKey_()),{method:'post',contentType:'application/json',payload:JSON.stringify({idToken:token}),muteHttpExceptions:true});
 if(res.getResponseCode()!==200)return null;
 var users=JSON.parse(res.getContentText()).users||[];if(users.length!==1)return null;
 var u=users[0],uid=u.localId;
 if(!uid||!u.email||u.disabled===true||!/^[A-Za-z0-9_-]{1,128}$/.test(uid))return null;
 var admin=getDoc_('secureLookupAdmins/'+uid);return admin&&admin.data.active===true?uid:null;
}
function generateCode_(key){
 var seed=hmacHex_(key,'code:'+Utilities.getUuid()+':'+Utilities.getUuid()+':'+Date.now());
 return ('000000'+(parseInt(seed.slice(0,12),16)%1000000)).slice(-6);
}
function saveGrant_(id,code,expires,uid,key){
 var old=getDoc_('secureLookupGrants/'+id),condition=old?{updateTime:old.version}:{exists:false};
 var docRoot='projects/'+PROJECT_+'/databases/(default)/documents/';
 var fields={codeHash:{stringValue:hmacHex_(key,'grant:'+id+':'+code)},expiresAt:{integerValue:String(expires)},used:{booleanValue:false},managerUid:{stringValue:uid}};
 return !!api_('post',':commit',{writes:[{update:{name:docRoot+'secureLookupGrants/'+id,fields:fields},currentDocument:condition}]});
}
function redeemGrant_(id,code,token,key,name,suffix){
 var begun=api_('post',':beginTransaction',{});if(!begun||!begun.transaction)return false;
 var tx=begun.transaction,committed=false;
 try{
  var docs=getTransactionDocs_(tx,['secureLookupGrants/'+id,'secureLookupCandidates/'+id,'secureLookupSnapshots/current']);
  var grant=docs['secureLookupGrants/'+id],candidate=candidateFromDoc_(id,docs['secureLookupCandidates/'+id]),snap=docs['secureLookupSnapshots/current'];
  if(!grant||grant.data.used!==false||grant.data.expiresAt<=Date.now()||!equal_(grant.data.codeHash,hmacHex_(key,'grant:'+id+':'+code))||!usableSnapshot_(id,candidate,snap)||candidate.name!==name||!equal_(candidate.fingerprint,hmacHex_(key,JSON.stringify([candidate.employeeId,name,suffix]))))return false;
  var tokenId=shaHex_(token),docRoot='projects/'+PROJECT_+'/databases/(default)/documents/';
  var result=api_('post',':commit',{transaction:tx,writes:[
   {update:{name:docRoot+'secureLookupGrants/'+id,fields:{used:{booleanValue:true}}},updateMask:{fieldPaths:['used']},currentDocument:{updateTime:grant.version}},
   {update:{name:docRoot+'secureLookupBindings/'+tokenId,fields:{candidateId:{stringValue:id},active:{booleanValue:true},expiresAt:{integerValue:String(Date.now()+15552000000)}}},currentDocument:{exists:false}}
  ]});
  committed=!!result;return committed;
 }finally{if(!committed)try{api_('post',':rollback',{transaction:tx});}catch(e){}}
}
function verifyBoundLookup_(id,token,key,name,suffix){
 var begun=api_('post',':beginTransaction',{});if(!begun||!begun.transaction)return false;
 var tx=begun.transaction,committed=false;
 try{
  var bindingPath='secureLookupBindings/'+shaHex_(token),docs=getTransactionDocs_(tx,['secureLookupCandidates/'+id,'secureLookupSnapshots/current',bindingPath]);
  var candidate=candidateFromDoc_(id,docs['secureLookupCandidates/'+id]),snap=docs['secureLookupSnapshots/current'],binding=docs[bindingPath];
  if(!usableSnapshot_(id,candidate,snap)||candidate.name!==name||!equal_(candidate.fingerprint,hmacHex_(key,JSON.stringify([candidate.employeeId,name,suffix])))||!binding||binding.data.active!==true||binding.data.candidateId!==id||binding.data.expiresAt<=Date.now())return false;
  committed=!!api_('post',':commit',{transaction:tx,writes:[]});return committed;
 }finally{if(!committed)try{api_('post',':rollback',{transaction:tx});}catch(e){}}
}
function takeAttempt_(name){
 var lock=LockService.getScriptLock();if(!lock.tryLock(5000))return false;
 try{
  var props=PropertiesService.getScriptProperties(),day=Utilities.formatDate(new Date(),'Asia/Taipei','yyyy-MM-dd');
  var hash=shaHex_(name),bucket='rate_'+hash.slice(0,1),entry=JSON.parse(props.getProperty(bucket)||'{}');
  if(entry.day!==day)entry={day:day,counts:{}};
  var global=JSON.parse(props.getProperty('rate_global')||'{}');if(global.day!==day)global={day:day,count:0};
  var id=hash.slice(0,24),count=entry.counts[id]||0;
  if(count>=5||global.count>=2000||(!entry.counts[id]&&Object.keys(entry.counts).length>=100))return false;
  entry.counts[id]=count+1;global.count++;
  props.setProperty(bucket,JSON.stringify(entry));props.setProperty('rate_global',JSON.stringify(global));return true;
 }catch(e){return false;}finally{lock.releaseLock();}
}

var LOOKUP_HTML_ = "<!doctype html>\n<html lang=\"zh-Hant\"><head><base target=\"_top\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<title>\u540c\u4ec1\u5de5\u865f\u67e5\u8a62</title>\n<style>\nbody{font-family:system-ui,-apple-system,sans-serif;background:#f3f5f8;color:#182230;margin:0;padding:20px 16px 32px}main{max-width:520px;margin:auto;background:white;border-radius:18px;padding:24px;box-shadow:0 4px 20px #0001;box-sizing:border-box}h1{font-size:24px;margin-top:0}label{display:block;font-weight:600;margin:16px 0 6px}input,button{box-sizing:border-box;width:100%;font:inherit;border-radius:10px;min-height:48px}input{border:1px solid #9aa4b2;padding:10px}button{border:0;background:#0876ec;color:white;font-weight:700;margin-top:14px;cursor:pointer}button:disabled{opacity:.5}details{margin-top:28px;border-top:1px solid #ddd;padding-top:16px}summary{cursor:pointer;font-weight:600}p{line-height:1.5}#result,#admin-result{white-space:pre-wrap;overflow-wrap:anywhere}small{color:#556}\n</style>\n<script src=\"https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js\"></script>\n<script src=\"https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js\"></script>\n</head><body><main>\n<h1>\u67e5\u8a62\u540c\u4ec1\u5de5\u865f</h1><p>\u8acb\u8f38\u5165\u60a8\u7684\u59d3\u540d\u8207\u8eab\u5206\u8b49\u5f8c\u56db\u78bc\u3002\u7b2c\u4e00\u6b21\u4f7f\u7528\uff0c\u8acb\u5148\u5411\u4e3b\u7ba1\u53d6\u5f97\u4e00\u6b21\u6027\u958b\u901a\u78bc\u3002</p>\n<form id=\"lookup-form\"><label for=\"name\">\u59d3\u540d</label><input id=\"name\" autocomplete=\"name\" required maxlength=\"80\">\n<label for=\"suffix\">\u8eab\u5206\u8b49\u5f8c\u56db\u78bc</label><input id=\"suffix\" inputmode=\"numeric\" autocomplete=\"off\" pattern=\"[0-9]{4}\" maxlength=\"4\" required>\n<div id=\"code-wrap\"><label for=\"code\">\u4e3b\u7ba1\u958b\u901a\u78bc</label><input id=\"code\" inputmode=\"numeric\" autocomplete=\"one-time-code\" pattern=\"[0-9]{6}\" maxlength=\"6\"><small>\u958b\u901a\u78bc 10 \u5206\u9418\u5167\u6709\u6548\uff0c\u53ea\u80fd\u4f7f\u7528\u4e00\u6b21\u3002</small></div>\n<button id=\"lookup-btn\" type=\"submit\">\u67e5\u8a62\u5de5\u865f</button><p id=\"result\" role=\"status\" aria-live=\"polite\"></p></form>\n<button type=\"button\" id=\"forget\" style=\"background:#eef2f7;color:#344\">\u6539\u7528\u65b0\u7684\u4e3b\u7ba1\u958b\u901a\u78bc</button>\n<details><summary>\u4e3b\u7ba1\uff1a\u6838\u5be6\u672c\u4eba\u5f8c\u63d0\u4f9b\u958b\u901a\u78bc</summary><p>\u8acb\u5148\u900f\u904e\u516c\u53f8\u65e2\u6709\u65b9\u5f0f\u78ba\u8a8d\u540c\u4ec1\u8eab\u5206\u53ca\u5728\u8077\u72c0\u614b\u3002</p>\n<label for=\"admin-email\">\u516c\u544a\uff0f\u7ba1\u7406\u5e33\u865f</label><input type=\"email\" id=\"admin-email\" autocomplete=\"username\">\n<label for=\"admin-password\">\u7ba1\u7406\u5bc6\u78bc</label><input type=\"password\" id=\"admin-password\" autocomplete=\"current-password\">\n<button type=\"button\" id=\"login\">\u767b\u5165\u7ba1\u7406\u5e33\u865f</button><label for=\"employee-id\">\u5df2\u6838\u5be6\u7684\u540c\u4ec1\u5de5\u865f</label><input id=\"employee-id\" inputmode=\"numeric\" maxlength=\"8\" pattern=\"[0-9]{8}\">\n<button type=\"button\" id=\"issue\">\u7522\u751f\u4e00\u6b21\u6027\u958b\u901a\u78bc</button><button type=\"button\" id=\"revoke\" style=\"background:#eef2f7;color:#344\">\u64a4\u92b7\u6b64\u540c\u4ec1\u7684\u88dd\u7f6e\u7d81\u5b9a</button><p id=\"admin-result\" role=\"status\" aria-live=\"polite\"></p></details>\n</main>\n<script>\n(function(){'use strict';var tokenKey='dys_lookup_device_v1',device='';var $=function(id){return document.getElementById(id);};\ntry{device=localStorage.getItem(tokenKey)||'';}catch(e){}\nfunction showCode(){ $('code-wrap').style.display=device?'none':'block';$('code').required=!device; }\nshowCode();\n$('forget').onclick=function(){device='';try{localStorage.removeItem(tokenKey);}catch(e){}$('result').textContent='';showCode();};\n$('lookup-form').onsubmit=function(e){e.preventDefault();var btn=$('lookup-btn');if(btn.disabled)return;btn.disabled=true;$('result').textContent='\u67e5\u8a62\u4e2d\u2026';\n var req={name:$('name').value.trim(),suffix:$('suffix').value};if(device)req.deviceToken=device;else req.code=$('code').value;\n google.script.run.withSuccessHandler(function(data){btn.disabled=false;if(!data||!data.ok){$('result').textContent='\u7121\u6cd5\u5b8c\u6210\u67e5\u8a62\uff0c\u8acb\u78ba\u8a8d\u8cc7\u6599\u6216\u806f\u7d61\u4e3b\u7ba1\u5354\u52a9\u3002';return;}\n if(data.deviceToken){device=data.deviceToken;try{localStorage.setItem(tokenKey,device);}catch(e){}showCode();}\n $('suffix').value='';$('code').value='';$('result').textContent='\u60a8\u7684\u540c\u4ec1\u5de5\u865f\uff1a'+data.employeeId+'\\n\u8acb\u8fd4\u56de\u6253\u5361\u9801\u8f38\u5165\u6b64\u5de5\u865f\u3002';\n }).withFailureHandler(function(){btn.disabled=false;$('result').textContent='\u76ee\u524d\u7121\u6cd5\u67e5\u8a62\uff0c\u8acb\u7a0d\u5f8c\u91cd\u8a66\u6216\u806f\u7d61\u4e3b\u7ba1\u3002';}).lookupEmployee(req);\n};\nvar auth=null;\n$('login').onclick=function(){var btn=$('login');btn.disabled=true;$('admin-result').textContent='\u6b63\u5728\u767b\u5165\u2026';\n try{if(!firebase.apps.length)firebase.initializeApp({apiKey:'__PUBLIC_FIREBASE_WEB_API_KEY__',projectId:'dys-attendance-a5be6'});auth=firebase.auth();\n auth.setPersistence(firebase.auth.Auth.Persistence.NONE).then(function(){return auth.signInWithEmailAndPassword($('admin-email').value.trim(),$('admin-password').value);}).then(function(){$('admin-password').value='';$('admin-result').textContent='\u5df2\u767b\u5165\uff1b\u8acb\u78ba\u8a8d\u672c\u4eba\u5f8c\u8f38\u5165\u540c\u4ec1\u5de5\u865f\u3002';},function(){$('admin-result').textContent='\u767b\u5165\u5931\u6557\uff0c\u8acb\u78ba\u8a8d\u5e33\u865f\u5bc6\u78bc\u3002';}).then(function(){btn.disabled=false;});\n }catch(e){btn.disabled=false;$('admin-result').textContent='\u767b\u5165\u670d\u52d9\u66ab\u6642\u7121\u6cd5\u4f7f\u7528\u3002';}\n};\n$('issue').onclick=function(){var btn=$('issue'),id=$('employee-id').value;if(!/^\\d{8}$/.test(id)){ $('admin-result').textContent='\u8acb\u8f38\u5165 8 \u78bc\u540c\u4ec1\u5de5\u865f\u3002';return; }\n if(!auth||!auth.currentUser){$('admin-result').textContent='\u8acb\u5148\u767b\u5165\u7ba1\u7406\u5e33\u865f\u3002';return;}btn.disabled=true;$('admin-result').textContent='\u6b63\u5728\u78ba\u8a8d\u6b0a\u9650\u2026';\n auth.currentUser.getIdToken().then(function(token){google.script.run.withSuccessHandler(function(data){btn.disabled=false;$('admin-result').textContent=data&&data.ok?'\u958b\u901a\u78bc\uff1a'+data.code+'\\n\u8acb\u4ee5\u516c\u53f8\u65e2\u6709\u5b89\u5168\u65b9\u5f0f\u63d0\u4f9b\u540c\u4ec1\uff0c10 \u5206\u9418\u5167\u6709\u6548\u3002':'\u7121\u6cd5\u7522\u751f\u958b\u901a\u78bc\uff0c\u8acb\u78ba\u8a8d\u6b0a\u9650\u8207\u540d\u518a\u3002';}).withFailureHandler(function(){btn.disabled=false;$('admin-result').textContent='\u76ee\u524d\u7121\u6cd5\u7522\u751f\u958b\u901a\u78bc\uff0c\u8acb\u7a0d\u5f8c\u91cd\u8a66\u3002';}).issuePairCode({token:token,employeeId:id});},function(){btn.disabled=false;$('admin-result').textContent='\u7ba1\u7406\u767b\u5165\u5df2\u5931\u6548\uff0c\u8acb\u91cd\u65b0\u767b\u5165\u3002';});\n};\n$('revoke').onclick=function(){var btn=$('revoke'),id=$('employee-id').value;if(!/^\\d{8}$/.test(id)||!auth||!auth.currentUser){$('admin-result').textContent='\u8acb\u5148\u767b\u5165\u4e26\u8f38\u5165 8 \u78bc\u540c\u4ec1\u5de5\u865f\u3002';return;}\n if(!window.confirm('\u78ba\u5b9a\u64a4\u92b7\u9019\u4f4d\u540c\u4ec1\u7684\u6240\u6709\u88dd\u7f6e\u7d81\u5b9a\uff1f\u6b64\u64cd\u4f5c\u4e0d\u5f71\u97ff\u6253\u5361\u3002'))return;\n btn.disabled=true;$('admin-result').textContent='\u6b63\u5728\u64a4\u92b7\u2026';auth.currentUser.getIdToken().then(function(token){google.script.run.withSuccessHandler(function(data){btn.disabled=false;$('admin-result').textContent=data&&data.ok?'\u5df2\u64a4\u92b7 '+data.revoked+' \u500b\u88dd\u7f6e\u7d81\u5b9a\u3002':'\u7121\u6cd5\u64a4\u92b7\uff0c\u8acb\u78ba\u8a8d\u6b0a\u9650\u5f8c\u91cd\u8a66\u3002';}).withFailureHandler(function(){btn.disabled=false;$('admin-result').textContent='\u76ee\u524d\u7121\u6cd5\u64a4\u92b7\uff0c\u8acb\u7a0d\u5f8c\u91cd\u8a66\u3002';}).revokePairings({token:token,employeeId:id});},function(){btn.disabled=false;$('admin-result').textContent='\u7ba1\u7406\u767b\u5165\u5df2\u5931\u6548\u3002';});\n};\n})();\n</script></body></html>\n";
function verifyLookupSetup() { try { var ok=!!getDoc_("secureLookupSnapshots/current"); console.log(ok?"Lookup connection: OK":"Lookup connection: unavailable"); return {available:ok}; } catch(e) { console.log("Lookup connection: unavailable"); return {available:false}; } }
