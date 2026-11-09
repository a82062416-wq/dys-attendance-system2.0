'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const file=path.join(__dirname,'../shared-announcement.js');
const load=()=>require(file);
test('homepage loads the shared notice separately and has explicit publish controls',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
 assert.match(html,/src="shared-announcement.js/);
 assert.match(html,/id="announcement-publish"/);
 assert.match(html,/id="announcement-login"/);
 const save=html.slice(html.indexOf('function saveSettings(){'),html.indexOf('//  Navigation'));
 assert.doesNotMatch(save,/localStorage\.setItem\('site_announcement'/);
});
test('public REST read never uses an attendance credential or writes data',async()=>{
 assert.ok(fs.existsSync(file),'shared runtime missing');
 const calls=[];
 const api=load().createTransport({projectId:'demo-notice',fetch:async(url,opts)=>{calls.push({url,opts});return {ok:true,json:async()=>({fields:{published:{booleanValue:false}},updateTime:'v1'})}}});
 const result=await api.read();assert.equal(result.notice,null);assert.equal(result.version,'v1');
 assert.equal(calls.length,1);assert.equal(calls[0].opts.method,'GET');assert.equal(calls[0].opts.headers.Authorization,undefined);
});
test('expired or withdrawn notices do not reappear and untrusted fields are rejected',()=>{
 const {decode}=load();
 assert.equal(decode({published:{booleanValue:false}},Date.now()),null);
 assert.equal(decode({published:{booleanValue:true},text:{stringValue:'old'},level:{stringValue:'normal'},expiresAt:{timestampValue:'2000-01-01T00:00:00Z'}},Date.now()),null);
 assert.throws(()=>decode({published:{booleanValue:true}},Date.now()));
});
test('publish uses a version precondition, bearer identity and no automatic retry',async()=>{
 const calls=[];
 const api=load().createTransport({projectId:'demo-notice',fetch:async(url,opts)=>{calls.push({url,opts});return {ok:false,status:409}}});
 await assert.rejects(api.write({published:{booleanValue:false}},'fake-token','2026-11-09T00:00:00Z'),/conflict/);
 assert.equal(calls.length,1);assert.match(calls[0].url,/currentDocument.updateTime=/);
 assert.equal(calls[0].opts.headers.Authorization,'Bearer fake-token');
});
test('missing document create uses exists=false; forbidden writes are not successful',async()=>{
 let called;
 const api=load().createTransport({projectId:'demo-notice',fetch:async(url,opts)=>{called=url;return {ok:false,status:403}}});
 await assert.rejects(api.write({published:{booleanValue:false}},'fake',null),/forbidden/);
 assert.match(called,/currentDocument.exists=false/);
});
test('failed reads are distinguishable from an unpublished notice',async()=>{
 const api=load().createTransport({projectId:'demo-notice',fetch:async()=>({ok:false,status:503})});
 await assert.rejects(api.read(),/unavailable/);
});
