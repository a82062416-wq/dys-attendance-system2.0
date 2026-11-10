'use strict';
// Fictional users only. The demo project prevents access to production.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {initializeApp,deleteApp}=require('firebase/app');
const {getAuth,connectAuthEmulator,signInAnonymously,createUserWithEmailAndPassword,signInWithEmailAndPassword,signOut,EmailAuthProvider,reauthenticateWithCredential,updatePassword}=require('firebase/auth');
const {getFirestore,connectFirestoreEmulator,doc,setDoc,getDoc,Timestamp}=require('firebase/firestore');
const {initializeTestEnvironment,assertFails,assertSucceeds}=require('@firebase/rules-unit-testing');

async function main(){
 const projectId='demo-dys-private-lookup';
 const rules=fs.readFileSync(process.env.DYS_RULES_SOURCE||path.join(__dirname,'../announcement-emulator/announcement-spark.rules'),'utf8');
 const env=await initializeTestEnvironment({projectId,firestore:{rules,host:'127.0.0.1',port:18081}});
 const apps=[];
 function instance(name){
  const app=initializeApp({apiKey:'fake',projectId},name);apps.push(app);
  const auth=getAuth(app);connectAuthEmulator(auth,'http://127.0.0.1:19099',{disableWarnings:true});
  const db=getFirestore(app);connectFirestoreEmulator(db,'127.0.0.1',18081);
  return {auth,db};
 }
 try{
  const punch=instance('synthetic-attendance'),admin=instance('synthetic-admin'),other=instance('synthetic-other');
  await signInAnonymously(punch.auth);
  const punchUid=punch.auth.currentUser.uid;
  // Fictional numeric password, proving the existing-password flow in isolation.
  const email='site-admin@dys.invalid',password='42001573';
  await createUserWithEmailAndPassword(admin.auth,email,password);
  await createUserWithEmailAndPassword(other.auth,'other@dys.invalid','synthetic-other-password');
  const uid=admin.auth.currentUser.uid;
  await env.withSecurityRulesDisabled(c=>setDoc(doc(c.firestore(),'announcementAdmins',uid),{active:true}));
  const notice={published:true,text:'fictional notice',level:'normal',expiresAt:Timestamp.fromMillis(Date.now()+600000)};
  const target=db=>doc(db,'publicAnnouncements','current');
  await assertFails(setDoc(target(punch.db),notice));
  await assertFails(setDoc(target(other.db),notice));
  await assertSucceeds(setDoc(target(admin.db),notice));
  await assertSucceeds(getDoc(target(punch.db)));
  await reauthenticateWithCredential(admin.auth.currentUser,EmailAuthProvider.credential(email,password));
  await updatePassword(admin.auth.currentUser,'synthetic-new-password-2026');
  await signOut(admin.auth);
  if(!punch.auth.currentUser||punch.auth.currentUser.uid!==punchUid)throw Error('attendance auth changed');
  await assert.rejects(signInWithEmailAndPassword(admin.auth,email,password));
  await assertSucceeds(signInWithEmailAndPassword(admin.auth,email,'synthetic-new-password-2026'));
  await env.withSecurityRulesDisabled(c=>setDoc(doc(c.firestore(),'announcementAdmins',uid),{active:false}));
  await assertFails(setDoc(target(admin.db),notice));
  console.log('Auth + actual Firestore rules: one login, no anonymous write, role revocation, password change, attendance isolation PASS');
 }finally{await Promise.all(apps.map(deleteApp));await env.cleanup();}
}
main().catch(e=>{console.error(e);process.exitCode=1});
