'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
test('身分證查詢入口具明確識別並維持既有備用查詢',()=>{
 assert.match(html,/id="secure-id-lookup-link"/);
 assert.match(html,/身分證後四碼查詢/);
 assert.match(html,/<option value="mobile">/);assert.match(html,/<option value="birthday">/);
});
test('尚未設定的查詢服務不可顯示假連結，也不可傳輸姓名或後四碼到網址',()=>{
 const match=html.match(/function configureSecureLookupEntry\([^)]*\)\s*\{[\s\S]*?\n\}/);assert.ok(match);
 const link={hidden:false,href:'',removeAttribute(name){if(name==='href')this.href='';}};
 const c={document:{getElementById:()=>link}};vm.createContext(c);vm.runInContext(match[0],c);
 c.configureSecureLookupEntry('');assert.equal(link.hidden,true);assert.equal(link.href,'');
 c.configureSecureLookupEntry('https://evil.example/?name=private');assert.equal(link.hidden,true);
 const safe='https://script.google.com/macros/s/TEST_ONLY/exec';c.configureSecureLookupEntry(safe);assert.equal(link.hidden,false);assert.equal(link.href,safe);
});
