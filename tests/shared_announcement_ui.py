"""Actual homepage, synthetic notice transport. All production traffic blocked."""
import json, os
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

BASE=os.environ.get('DYS_TEST_URL','http://127.0.0.1:18765/')
DOCUMENT={'fields':{'published':{'booleanValue':True},'text':{'stringValue':'測試公告 <img src=x onerror=alert(1)>'},'level':{'stringValue':'urgent'},'expiresAt':{'timestampValue':'2099-01-01T00:00:00Z'}},'updateTime':'2026-11-09T00:00:00Z'}

def verify(browser,width):
    page=browser.new_page(viewport={'width':width,'height':844},service_workers='block')
    errors=[]; writes=[]; state={'document':DOCUMENT.copy(),'fail':False,'deny':False}
    page.on('pageerror',lambda err:errors.append(str(err)))
    if os.environ.get('DYS_UI_DEBUG'):
        page.on('console',lambda msg: print('browser:',msg.text) if msg.type=='error' else None)
        page.on('requestfailed',lambda req: print('failed:',req.method,req.url,req.failure))
        page.on('response',lambda response:print('response:',response.status,response.url) if 'firestore.googleapis.com' in response.url else None)
    def route(r):
        url=r.request.url
        if '/__mock_firestore__/' in url:
            if os.environ.get('DYS_UI_DEBUG'):print('intercept:',r.request.method,url)
            cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,content-type','Access-Control-Allow-Methods':'GET,PATCH,OPTIONS'}
            if r.request.method=='OPTIONS':r.fulfill(status=204,headers=cors);return
            if state['fail']:r.abort();return
            if '/announcementAdmins/' in url:r.fulfill(headers=cors,json={'fields':{'active':{'booleanValue':True}}});return
            if r.request.method=='PATCH':
                writes.append(r.request.post_data_json)
                if state['deny']:r.fulfill(status=403,headers=cors,json={});return
                state['document']={'fields':r.request.post_data_json['fields'],'updateTime':'2026-11-09T01:00:00Z'}
            r.fulfill(headers=cors,json=state['document']);return
        if urlsplit(url).netloc==urlsplit(BASE).netloc:r.continue_();return
        r.abort()
    page.route('**/*',route)
    mock_fetch="""const noticeFetch=window.fetch.bind(window);window.fetch=(url,opts)=>noticeFetch(String(url).replace('https://firestore.googleapis.com/',location.origin+'/__mock_firestore__/'),opts);"""
    page.add_init_script(mock_fetch+"localStorage.setItem('guide_done','1');localStorage.setItem('local_records','[]')")
    page.goto(BASE,wait_until='domcontentloaded')
    page.wait_for_function('window.DysAnnouncement && document.getElementById("announcement-toggle").classList.contains("show")')
    assert not page.locator('#announce-bar').is_visible()
    page.evaluate("document.querySelectorAll('.overlay.show,.ko-overlay.show').forEach(e=>e.classList.remove('show'));closeDrawer();")
    page.locator('#announcement-toggle').click()
    assert '測試公告' in page.locator('#announce-bar').inner_text()
    assert page.locator('#announce-bar img').count()==0
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    page.locator('#announce-bar button').click()
    assert not page.locator('#announce-bar').is_visible()
    page.evaluate("""() => {
      window.announcementAuthCalls=[];
      const a={currentUser:null,setPersistence:()=>Promise.resolve(),signInWithEmailAndPassword:()=>{a.currentUser={uid:'synthetic-admin',getIdToken:()=>Promise.resolve('synthetic-token')};return Promise.resolve({user:a.currentUser});},signOut:()=>{a.currentUser=null;return Promise.resolve();}};
      window.firebase={apps:[],initializeApp:(config,name)=>{announcementAuthCalls.push(name);return {auth:()=>a};},auth:{Auth:{Persistence:{NONE:'none'}}}};
      ADMIN_UNLOCKED=true;CURRENT_ROLE='admin';showPage('admin');showSub('settings');loadSettingsFields();
      window.originalQueue=localStorage.getItem('local_records');
    }""")
    page.locator('#s-announcement').fill('新的共用公告')
    page.locator('#announcement-publish').click()
    assert '公告發布權限尚未確認' in page.locator('#announcement-status').inner_text()
    assert not writes
    assert page.evaluate("window.DysAnnouncement.authenticateAdmin('synthetic')")
    if os.environ.get('DYS_UI_DEBUG'):
        page.wait_for_timeout(1500)
        print('login-status:',page.locator('#announcement-status').inner_text(), 'calls:',page.evaluate('announcementAuthCalls'))
    page.wait_for_function("document.getElementById('announcement-status').textContent.includes('已確認管理員')")
    assert page.evaluate('announcementAuthCalls.length===1 && announcementAuthCalls[0].startsWith("dys-admin-session-")')
    state['deny']=True
    page.locator('#announcement-publish').click()
    page.wait_for_function("document.getElementById('announcement-status').textContent.includes('發布被拒絕')")
    assert page.locator('#s-announcement').input_value()=='新的共用公告'
    state['deny']=False
    page.locator('#announcement-publish').click()
    page.wait_for_function("document.getElementById('announcement-status').textContent.includes('已發布給所有同仁')")
    assert len(writes)==2
    # A separate fresh device sees the cloud result; no shared localStorage.
    second=browser.new_page(viewport={'width':width,'height':844},service_workers='block')
    second.add_init_script(mock_fetch)
    second.route('**/*',route)
    second.goto(BASE,wait_until='domcontentloaded')
    second.wait_for_function("document.getElementById('announce-bar').textContent.includes('新的共用公告')")
    second.close()
    # Stale drafts cannot overwrite a different cloud version.
    page.locator('#s-announcement').fill('尚未發布草稿')
    state['document']={'fields':DOCUMENT['fields'],'updateTime':'2026-11-09T02:00:00Z'}
    page.locator('#announcement-publish').click()
    page.wait_for_function("document.getElementById('announcement-status').textContent.includes('本次未覆蓋')")
    assert len(writes)==2
    assert page.locator('#s-announcement').input_value()=='尚未發布草稿'
    page.locator('#announcement-refresh').click()
    page.wait_for_function("document.getElementById('announcement-status').textContent.includes('已讀取最新')")
    page.on('dialog',lambda dialog:dialog.accept())
    page.locator('#announcement-withdraw').click()
    page.wait_for_function("document.getElementById('announcement-status').textContent.includes('已撤回')")
    assert page.locator('#announcement-toggle').evaluate("el => el.classList.contains('show')")
    assert '目前沒有公告' in page.locator('#announce-bar').text_content()
    state['fail']=True
    page.locator('#announcement-refresh').click()
    page.wait_for_function("document.getElementById('announcement-status').textContent.includes('暫時讀不到')")
    assert page.evaluate("localStorage.getItem('local_records')===originalQueue")
    page.evaluate('lockAdmin()')
    assert page.locator('#page-checkin').is_visible()
    assert not errors,errors
    page.close()

with sync_playwright() as p:
    for kind in os.environ.get('DYS_BROWSERS','chromium,webkit').split(','):
        browser=getattr(p,kind).launch(headless=True)
        for width in (320,390,1440):verify(browser,width)
        browser.close()
        print(kind+': shared publish, second device, auth isolation, draft/conflict, withdraw, failure, queues PASS')
