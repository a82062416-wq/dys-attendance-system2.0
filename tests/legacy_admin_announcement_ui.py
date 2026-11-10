"""Synthetic same-password experiment. All actual cloud traffic is blocked."""
import os
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

BASE = os.environ.get('DYS_TEST_URL', 'http://127.0.0.1:18785/')


def verify(browser):
    page = browser.new_page(viewport={'width': 390, 'height': 844}, service_workers='block')
    state = {'writes': [], 'document': {'fields': {'published': {'booleanValue': False}}, 'updateTime': 'v1'}}
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))

    def route(r):
        u = r.request.url
        if '/__mock_firestore__/' in u:
            headers = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,PATCH,OPTIONS'}
            if r.request.method == 'OPTIONS': r.fulfill(status=204, headers=headers); return
            if '/announcementAdmins/' in u:
                r.fulfill(json={'fields': {'active': {'booleanValue': True}}}, headers=headers); return
            if r.request.method == 'PATCH':
                state['writes'].append(r.request.post_data_json)
                state['document'] = {'fields': r.request.post_data_json['fields'], 'updateTime': 'v2'}
            r.fulfill(json=state['document'], headers=headers); return
        if urlsplit(u).netloc == urlsplit(BASE).netloc and r.request.method in ('GET', 'HEAD'):
            r.continue_(); return
        r.abort()

    page.route('**/*', route)
    page.add_init_script("""const realFetch=window.fetch.bind(window);
      window.fetch=(u,o)=>realFetch(String(u).replace('https://firestore.googleapis.com/',location.origin+'/__mock_firestore__/'),o);
      localStorage.setItem('guide_done','1');localStorage.setItem('local_records','[{\"synthetic\":true}]');""")
    page.goto(BASE, wait_until='domcontentloaded')
    page.wait_for_function('window.DysAnnouncement')
    page.evaluate("""() => {
      window.syntheticMode='pending';window.syntheticAttempts=0;
      const a={currentUser:null,setPersistence:()=>Promise.resolve(),
        signInWithEmailAndPassword:(email,pwd)=>{syntheticAttempts++;
          if(pwd!=='synthetic-legacy-password')return Promise.reject(Error('bad-password'));
          if(syntheticMode==='offline')return Promise.reject(Error('offline'));
          return new Promise(resolve=>{window.finishSyntheticSignin=()=>{
            a.currentUser={uid:'synthetic-admin',getIdToken:()=>Promise.resolve('synthetic-token')};resolve({user:a.currentUser});};});},
        signOut:()=>{a.currentUser=null;return Promise.resolve();}};
      window.syntheticPublisher=a;
      window.firebase={apps:[],initializeApp:()=>({auth:()=>a}),auth:{Auth:{Persistence:{NONE:'none'}}}};
      syncSupervisorsFromFirebase=async s=>{s.verified=true};syncAuthFromFirebase=async s=>{s.loaded=true;s.verified=true};
      FB_AUTH_READY=Promise.resolve(true);localStorage.setItem('admin_pwd_hash',hashPwd('synthetic-legacy-password'));
      document.querySelectorAll('.overlay.show,.ko-overlay.show').forEach(e=>e.classList.remove('show'));closeDrawer();
      window.syntheticQueue=localStorage.getItem('local_records');
    }""")
    page.locator('#tab-admin').click()
    page.locator('#lock-input').fill('synthetic-legacy-password')
    page.locator('#login-submit-btn').click()
    page.wait_for_function('ADMIN_UNLOCKED', timeout=3000)
    assert page.evaluate('syntheticAttempts') == 1, '原密碼應同步用於確認公告權限'
    page.evaluate("showSub('settings');loadSettingsFields()")
    page.locator('#s-announcement').fill('虛構公告')
    page.locator('#announcement-publish').click()
    assert not state['writes']
    assert page.locator('#s-announcement').input_value() == '虛構公告'
    assert '正在確認公告發布權限' in page.locator('#announcement-status').inner_text()
    page.evaluate('finishSyntheticSignin()')
    page.wait_for_function('window.DysAnnouncement.hasAdminSession()')
    page.locator('#announcement-publish').click()
    page.wait_for_function("document.getElementById('announcement-status').textContent.includes('已發布')")
    assert len(state['writes']) == 1
    assert page.evaluate("localStorage.getItem('local_records')===syntheticQueue")
    page.evaluate('lockAdmin();syntheticMode="offline"')
    page.locator('#tab-admin').click()
    page.locator('#lock-input').fill('synthetic-legacy-password')
    page.locator('#login-submit-btn').click()
    page.wait_for_function('ADMIN_UNLOCKED', timeout=3000)
    page.wait_for_function('syntheticAttempts===2')
    assert not page.evaluate('window.DysAnnouncement.hasAdminSession()')
    assert page.evaluate("localStorage.getItem('local_records')===syntheticQueue")

    # A background authorization resolving after logout cannot restore access.
    page.evaluate('lockAdmin();syntheticMode="pending";delete window.finishSyntheticSignin')
    page.locator('#tab-admin').click()
    page.locator('#lock-input').fill('synthetic-legacy-password')
    page.locator('#login-submit-btn').click()
    page.wait_for_function('typeof window.finishSyntheticSignin === "function"')
    page.evaluate('lockAdmin();finishSyntheticSignin()')
    page.wait_for_function('syntheticPublisher.currentUser===null')
    assert not page.evaluate('ADMIN_UNLOCKED || window.DysAnnouncement.hasAdminSession()')
    assert len(state['writes']) == 1

    # A single admin password must not diverge when changed in settings.
    page.evaluate('delete window.finishSyntheticSignin')
    page.locator('#tab-admin').click()
    page.locator('#lock-input').fill('synthetic-legacy-password')
    page.locator('#login-submit-btn').click()
    page.wait_for_function('typeof window.finishSyntheticSignin === "function"')
    page.evaluate('finishSyntheticSignin()')
    page.wait_for_function('window.DysAnnouncement.hasAdminSession()')
    page.evaluate("""() => {
      firebase.auth.EmailAuthProvider={credential:(email,password)=>({password})};
      window.syntheticCloudPassword='synthetic-legacy-password';window.syntheticDbFail=false;
      window.syntheticDbHash=getPwdHash();
      syntheticPublisher.currentUser.reauthenticateWithCredential=c=>c.password===syntheticCloudPassword?Promise.resolve():Promise.reject(Error('bad-password'));
      syntheticPublisher.currentUser.updatePassword=p=>{window.syntheticCloudUpdated=true;syntheticCloudPassword=p;return Promise.resolve();};
      FB_DB={ref:path=>({transaction:fn=>{
        if(syntheticDbFail)return Promise.reject(Error('offline'));
        const next=fn(syntheticDbHash);if(next===undefined)return Promise.resolve({committed:false});
        syntheticDbHash=next;return Promise.resolve({committed:true});
      },push:()=>Promise.resolve()})};
      showSub('settings');loadSettingsFields();
    }""")
    page.locator('#s-pwd-old').fill('synthetic-legacy-password')
    page.locator('#s-pwd-new').fill('synthetic-next-password')
    page.locator('button[onclick="saveSettings()"]').click()
    page.wait_for_function("getPwdHash()===hashPwd('synthetic-next-password')", timeout=5000)
    assert page.evaluate("syntheticCloudPassword==='synthetic-next-password'")
    page.evaluate('syntheticDbFail=true')
    page.locator('#s-pwd-old').fill('synthetic-next-password')
    page.locator('#s-pwd-new').fill('synthetic-failure-password')
    page.locator('button[onclick="saveSettings()"]').click()
    page.wait_for_function("document.getElementById('toast').textContent.includes('原密碼未變更')",timeout=5000)
    assert page.evaluate("getPwdHash()===hashPwd('synthetic-next-password') && syntheticCloudPassword==='synthetic-next-password'")
    assert not errors, errors
    page.close()


with sync_playwright() as p:
    for kind in ('chromium', 'webkit'):
        browser = getattr(p, kind).launch(headless=True)
        verify(browser)
        browser.close()
        print(kind + ': original password, background authorization and offline attendance isolation PASS')
