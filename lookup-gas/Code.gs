/* Standalone, isolated Apps Script candidate. Not yet deployed or enabled. */
var PROJECT_='dys-attendance-a5be6';
var ENABLED_=false;
var BASE_='https://firestore.googleapis.com/v1/projects/'+PROJECT_+'/databases/(default)/documents';

function doGet(){
 var html=HtmlService.createHtmlOutputFromFile('Lookup').getContent();
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
