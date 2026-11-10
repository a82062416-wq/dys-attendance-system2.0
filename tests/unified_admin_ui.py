"""Unified admin login with synthetic data and no production traffic."""
import os
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

BASE = os.environ.get('DYS_TEST_URL', 'http://127.0.0.1:18785/')


def test_secure_login_and_publish(browser):
    page = browser.new_page(viewport={'width': 390, 'height': 844}, service_workers='block')
    state = {'document': {'fields': {'published': {'booleanValue': False}}, 'updateTime': 'v1'}, 'writes': [], 'allow': True}
    errors = []
    page.on('pageerror', lambda err: errors.append(str(err)))

    def route(r):
        u = r.request.url
        if '/__mock_firestore__/' in u:
            if r.request.method == 'OPTIONS':
                r.fulfill(status=204, headers={'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,PATCH,OPTIONS'}); return
            if '/announcementAdmins/' in u:
                r.fulfill(json={'fields': {'active': {'booleanValue': state['allow']}}}, headers={'Access-Control-Allow-Origin': '*'}); return
            if r.request.method == 'PATCH':
                state['writes'].append(r.request.post_data_json)
                state['document'] = {'fields': r.request.post_data_json['fields'], 'updateTime': 'v2'}
            r.fulfill(json=state['document'], headers={'Access-Control-Allow-Origin': '*'}); return
        if urlsplit(u).netloc == urlsplit(BASE).netloc and r.request.method in ('GET', 'HEAD'):
            r.continue_(); return
        r.abort()

    page.route('**/*', route)
    page.add_init_script("""const realFetch=window.fetch.bind(window);
      window.fetch=(u,o)=>realFetch(String(u).replace('https://firestore.googleapis.com/',location.origin+'/__mock_firestore__/'),o);
      localStorage.setItem('guide_done','1');localStorage.setItem('local_records','[]');""")
    page.goto(BASE, wait_until='domcontentloaded')
    page.wait_for_function('window.DysAnnouncement')
    page.evaluate("""() => {
      const publisher={currentUser:null,setPersistence:()=>Promise.resolve(),
        signInWithEmailAndPassword:(email,password)=>{
          if(password!=='synthetic-secure-password')return Promise.reject({code:'auth/invalid-credential'});
          publisher.currentUser={uid:'synthetic-admin',getIdToken:()=>Promise.resolve('synthetic-token')};return Promise.resolve({user:publisher.currentUser});
        },signOut:()=>{publisher.currentUser=null;return Promise.resolve();}};
      window.syntheticPublisher=publisher;window.attendanceSession={uid:'anonymous-attendance',isAnonymous:true};
      window.firebase={apps:[],initializeApp:(config,name)=>({name,options:config,auth:()=>publisher}),auth:{Auth:{Persistence:{NONE:'none'}}}};
      syncSupervisorsFromFirebase=async s=>{s.verified=true};syncAuthFromFirebase=async s=>{s.loaded=true;s.verified=true};
      FB_AUTH_READY=Promise.resolve(true);localStorage.setItem('admin_pwd_hash',hashPwd('synthetic-legacy-password'));
      document.querySelectorAll('.overlay.show,.ko-overlay.show').forEach(e=>e.classList.remove('show'));closeDrawer();
    }""")
    page.locator('#tab-admin').click()
    page.locator('#lock-screen').wait_for()
    page.locator('#lock-input').fill('synthetic-secure-password')
    page.locator('#login-submit-btn').click()
    page.wait_for_function("ADMIN_UNLOCKED && CURRENT_ROLE==='admin'", timeout=12000)
    page.evaluate("showSub('settings');loadSettingsFields()")
    assert page.locator('#announcement-login').count() == 0, '後台不得再顯示獨立公告登入'
    page.locator('#s-announcement').fill('虛構公告')
    page.locator('#announcement-publish').click()
    page.wait_for_function("document.getElementById('announcement-status').textContent.includes('已發布')")
    assert len(state['writes']) == 1
    assert page.evaluate('attendanceSession.uid') == 'anonymous-attendance'
    assert page.evaluate("localStorage.getItem('local_records')") == '[]'

    # Signing out before a pending token arrives must cancel publication.
    page.locator('#s-announcement').fill('登出前尚未送出的虛構公告')
    page.evaluate("""() => {syntheticPublisher.currentUser.getIdToken=()=>new Promise(resolve=>{
      window.finishSyntheticToken=()=>resolve('synthetic-token');});}""")
    page.locator('#announcement-publish').click()
    page.wait_for_function('typeof window.finishSyntheticToken === "function"')
    page.evaluate('window.DysAnnouncement.signOut();finishSyntheticToken()')
    page.wait_for_function("document.getElementById('announcement-status').textContent.includes('尚未確認發布結果')",timeout=5000)
    assert len(state['writes']) == 1
    assert page.locator('#s-announcement').input_value() == '登出前尚未送出的虛構公告'
    assert page.evaluate("window.DysAnnouncement.authenticateAdmin('synthetic-secure-password')")

    # Changing the new unified password must use Firebase reauthentication and
    # never write its weak hash into the legacy public attendance database.
    page.evaluate("""() => {
      window.syntheticPasswordChanges=[];window.legacyHashBefore=localStorage.getItem('admin_pwd_hash');
      firebase.auth.EmailAuthProvider={credential:(email,password)=>({password})};
      syntheticPublisher.currentUser.reauthenticateWithCredential=c=>c.password==='synthetic-secure-password'?Promise.resolve():Promise.reject(Error('invalid'));
      syntheticPublisher.currentUser.updatePassword=p=>{syntheticPasswordChanges.push(p==='synthetic-new-secure-password');return Promise.resolve();};
    }""")
    page.locator('#s-pwd-old').fill('synthetic-wrong-password')
    page.locator('#s-pwd-new').fill('synthetic-new-secure-password')
    page.locator('button[onclick="saveSettings()"]').click()
    page.wait_for_function("document.getElementById('toast').textContent.includes('無法確認密碼是否變更')")
    assert page.evaluate('syntheticPasswordChanges.length') == 0
    assert page.locator('#s-pwd-new').input_value() == 'synthetic-new-secure-password'
    page.locator('#s-pwd-old').fill('synthetic-secure-password')
    page.locator('#s-pwd-new').fill('synthetic-legacy-password')
    page.locator('button[onclick="saveSettings()"]').click()
    page.wait_for_function("document.getElementById('toast').textContent.includes('與舊版不同')")
    assert page.evaluate('syntheticPasswordChanges.length') == 0
    page.locator('#s-pwd-new').fill('synthetic-new-secure-password')
    page.locator('button[onclick="saveSettings()"]').click()
    page.wait_for_function('window.syntheticPasswordChanges.length===1', timeout=5000)
    assert page.evaluate('syntheticPasswordChanges[0]')
    assert page.evaluate("localStorage.getItem('admin_pwd_hash')===legacyHashBefore")
    page.evaluate('lockAdmin()')
    page.wait_for_function('syntheticPublisher.currentUser===null')

    # The old local password can still open the existing back office when its
    # separate cloud authorization fails, but cannot publish without that role.
    page.locator('#tab-admin').click()
    page.locator('#lock-screen').wait_for()
    page.locator('#lock-input').fill('synthetic-legacy-password')
    page.locator('#login-submit-btn').click()
    page.wait_for_function('ADMIN_UNLOCKED')
    page.evaluate("showSub('settings');loadSettingsFields()")
    page.wait_for_function("document.getElementById('announcement-status').textContent.includes('無法確認公告發布權限')")
    assert '修改管理員密碼' in page.locator('#admin-password-label').inner_text()
    page.locator('#s-announcement').fill('尚未授權的虛構公告')
    page.locator('#announcement-publish').click()
    assert '公告發布權限尚未確認' in page.locator('#announcement-status').inner_text()
    assert len(state['writes']) == 1
    page.evaluate('lockAdmin()')

    # A valid login with a revoked role must not enter the admin area or write.
    state['allow'] = False
    page.locator('#tab-admin').click()
    page.locator('#lock-screen').wait_for()
    page.locator('#lock-input').fill('synthetic-secure-password')
    page.locator('#login-submit-btn').click()
    page.wait_for_function("document.getElementById('lock-hint').textContent.includes('密碼錯誤')")
    assert not page.evaluate('ADMIN_UNLOCKED')
    assert page.evaluate('syntheticPublisher.currentUser===null')
    assert len(state['writes']) == 1

    # A late response after leaving the login screen cannot restore a session.
    state['allow'] = True
    page.evaluate("""() => {
      syntheticPublisher.signInWithEmailAndPassword=()=>new Promise(resolve=>{
        window.finishSyntheticLogin=()=>{
          syntheticPublisher.currentUser={uid:'synthetic-admin',getIdToken:()=>Promise.resolve('synthetic-token')};
          resolve({user:syntheticPublisher.currentUser});
        };
      });
    }""")
    page.locator('#lock-input').fill('synthetic-secure-password')
    page.locator('#login-submit-btn').click()
    page.wait_for_function('typeof window.finishSyntheticLogin === "function"')
    page.evaluate("showPage('checkin');finishSyntheticLogin()")
    page.wait_for_function('syntheticPublisher.currentUser===null')
    assert not page.evaluate('ADMIN_UNLOCKED') and len(state['writes']) == 1
    page.evaluate("localStorage.removeItem('admin_pwd_hash')")
    page.locator('#tab-admin').click()
    page.locator('#lock-screen').wait_for()
    assert page.locator('#lock-input').is_visible(), '沒有舊版雲端雜湊時，仍應能開啟安全登入畫面'
    assert not errors, errors
    page.close()


with sync_playwright() as p:
    for kind in ('chromium', 'webkit'):
        b = getattr(p, kind).launch(headless=True)
        test_secure_login_and_publish(b)
        b.close()
        print(kind + ': one admin login, authorized publication, isolated attendance and logout PASS')
