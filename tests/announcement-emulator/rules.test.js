'use strict';
// Isolated emulator with fictional accounts and announcements only.
const fs=require('node:fs'),path=require('node:path');
const {initializeTestEnvironment,assertFails,assertSucceeds}=require('@firebase/rules-unit-testing');
const {doc,getDoc,setDoc,deleteDoc,Timestamp}=require('firebase/firestore');
async function main(){
 const rules=fs.readFileSync(process.env.DYS_RULES_SOURCE||path.join(__dirname,'announcement-spark.rules'),'utf8');
 const env=await initializeTestEnvironment({projectId:'demo-dys-private-lookup',firestore:{rules,host:'127.0.0.1',port:18081}});
 try{
  await env.withSecurityRulesDisabled(async c=>{await setDoc(doc(c.firestore(),'announcementAdmins','admin1'),{active:true});});
  const publicDb=env.unauthenticatedContext().firestore();
  const admin=env.authenticatedContext('admin1',{firebase:{sign_in_provider:'password'}}).firestore();
  const other=env.authenticatedContext('other',{firebase:{sign_in_provider:'password'}}).firestore();
  const anon=env.authenticatedContext('admin1',{firebase:{sign_in_provider:'anonymous'}}).firestore();
  const target=db=>doc(db,'publicAnnouncements','current');
  const data={published:true,text:'模擬公告',level:'normal',expiresAt:Timestamp.fromMillis(Date.now()+600000)};
  // Synthetic legacy collection checks: preserve previously observed access.
  await env.withSecurityRulesDisabled(async c=>{await setDoc(doc(c.firestore(),'blacklist','synthetic'),{fake:true});});
  await assertSucceeds(getDoc(doc(publicDb,'blacklist','synthetic')));
  await assertSucceeds(setDoc(doc(other,'pending','synthetic'),{fake:true}));
  await assertFails(setDoc(doc(publicDb,'pending','synthetic'),{fake:true}));
  await assertFails(setDoc(target(publicDb),data));await assertFails(setDoc(target(other),data));await assertFails(setDoc(target(anon),data));
  await assertFails(setDoc(doc(other,'announcementAdmins','other'),{active:true}));
  await assertSucceeds(getDoc(doc(admin,'announcementAdmins','admin1')));
  await assertFails(getDoc(doc(other,'announcementAdmins','admin1')));
  await assertFails(getDoc(doc(anon,'announcementAdmins','admin1')));
  await assertSucceeds(setDoc(target(admin),data));await assertSucceeds(getDoc(target(publicDb)));
  await assertFails(setDoc(target(admin),{...data,extra:'bad'}));await assertFails(setDoc(target(admin),{...data,text:'x'.repeat(1001)}));
  await assertFails(deleteDoc(target(admin)));await assertSucceeds(setDoc(target(admin),{published:false}));
  await env.withSecurityRulesDisabled(async c=>{await setDoc(doc(c.firestore(),'announcementAdmins','admin1'),{active:false});});
  await assertFails(setDoc(target(admin),data));
  console.log('Spark candidate rules: public read, authorized publish, validation, withdraw and revocation passed');
 }finally{await env.cleanup()}
}
main().catch(e=>{console.error(e);process.exitCode=1});
