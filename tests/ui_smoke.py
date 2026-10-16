import os
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("DYS_TEST_URL", Path(__file__).resolve().parents[1].joinpath("index.html").as_uri())


def new_test_page(browser, viewport):
    page = browser.new_page(viewport=viewport)
    # 冒煙只存取本機，測試待補傳紀錄不可連上正式 Firebase／Sheets。
    page.route("**/*", lambda route: route.continue_() if urlsplit(route.request.url).netloc == urlsplit(BASE_URL).netloc else route.abort())
    page.add_init_script("localStorage.setItem('admin_pwd_hash', 'test-only-hash')")
    return page


def stub_backend_sync(page):
    page.evaluate("""() => {
      syncSupervisorsFromFirebase = async status => { if(status) status.verified = true; return []; };
      syncAuthFromFirebase = async status => { if(status){ status.verified = true; status.loaded = true; } };
    }""")


def verify_viewport(browser, viewport):
    page = new_test_page(browser, viewport)
    page.set_default_timeout(5000)
    page_errors = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.goto(BASE_URL, wait_until="domcontentloaded")
    stub_backend_sync(page)
    page.wait_for_timeout(500)

    if page.locator("#guide-overlay.show").count():
        page.get_by_role("button", name="跳過，直接打卡").click()
    else:
        page.locator("#change-btn").click()
    page.locator("#keyboard-overlay.show").wait_for()
    page.get_by_role("button", name="忘記員工編號？點這裡查詢").click()
    page.locator("#employee-lookup-modal.show").wait_for()
    assert not page.locator("#keyboard-overlay").evaluate("el => el.classList.contains('show')")

    page.locator("#lookup-submit").click()
    assert "請輸入您的完整姓名" in page.locator("#lookup-name-error").inner_text()
    assert "請輸入四碼數字" in page.locator("#lookup-value-error").inner_text()
    page.locator("#employee-lookup-modal .ko-close").click()
    assert not page.locator("#employee-lookup-modal").evaluate("el => el.classList.contains('show')")

    page.locator("#tab-admin").click()
    page.locator("#lock-screen").wait_for()
    assert "雲端" in page.locator("#login-cloud-status").inner_text()
    page.locator("#role-supervisor").click()
    assert page.locator("#login-role-title").inner_text() == "幹部登入"
    assert page.locator("#sup-id-wrap").is_visible()
    assert not page_errors, f"頁面 JavaScript 錯誤：{page_errors}"
    page.close()


def verify_admin_entry_over_overlays(browser):
    page = new_test_page(browser, {"width": 390, "height": 844})
    page.set_default_timeout(2000)
    page.goto(BASE_URL, wait_until="domcontentloaded")
    stub_backend_sync(page)
    page.locator("#guide-overlay.show").wait_for()
    page.locator("#tab-admin").click()
    page.locator("#lock-screen").wait_for()
    assert not page.locator("#guide-overlay").evaluate("el => el.classList.contains('show')")
    page.close()

    page = new_test_page(browser, {"width": 390, "height": 844})
    page.add_init_script("localStorage.setItem('guide_done', '1')")
    page.set_default_timeout(2000)
    page.goto(BASE_URL, wait_until="domcontentloaded")
    stub_backend_sync(page)
    page.locator("#keyboard-overlay.show").wait_for()
    page.locator("#tab-admin").click()
    page.locator("#lock-screen").wait_for()
    assert not page.locator("#keyboard-overlay").evaluate("el => el.classList.contains('show')")
    page.close()


def verify_admin_cloud_confirmation(browser):
    for supervisor_failure in (False, True):
        page = new_test_page(browser, {"width": 390, "height": 844})
        page.set_default_timeout(3000)
        page.goto(BASE_URL, wait_until="domcontentloaded")
        page.evaluate("""failure => {
          window.cloudReads = [];
          FB_AUTH_READY = new Promise(resolve => { window.finishTestAuth = resolve; });
          FB_DB = { ref: path => ({ once: async () => {
            cloudReads.push(path);
            if(path === 'config/supervisors' && failure) throw new Error('test permission denied');
            return { val: () => path === 'config/auth' ? {admin_pwd_hash: 'cloud-test-hash'} : [] };
          } }) };
        }""", supervisor_failure)
        page.locator("#tab-admin").click()
        assert page.evaluate("cloudReads.length") == 0, "匿名登入完成前不可讀取後台資料"
        assert page.locator("#tab-admin").is_disabled()
        page.evaluate("finishTestAuth(true)")
        page.locator("#lock-screen").wait_for()
        assert page.locator("#login-cloud-status").inner_text() == "✓ 管理員登入資料已從雲端確認"
        assert "幹部名單尚未確認，幹部功能可能不是最新" in page.locator("#login-supervisor-status").inner_text()
        assert page.evaluate("localStorage.getItem('admin_pwd_hash')") == "cloud-test-hash"
        page.locator("#role-supervisor").click()
        page.locator("#sup-emp-input").fill(page.evaluate("getSupervisors().find(s => s.active).empId"))
        page.locator("#login-submit-btn").click()
        assert "登入資料未經雲端確認" in page.locator("#supervisor-home-sync").inner_text(), "管理員密碼確認不可誤認為幹部權限也已確認"
        page.close()


def verify_login_layout_on_short_phone(browser):
    page = new_test_page(browser, {"width": 320, "height": 568})
    page.add_init_script("localStorage.setItem('guide_done', '1')")
    page.set_default_timeout(5000)
    page.goto(BASE_URL, wait_until="domcontentloaded")
    stub_backend_sync(page)
    assert page.locator("#pwa-banner").count() == 0, "打卡頁不可保留底部安裝浮條"
    page.locator("#keyboard-overlay.show").wait_for()
    page.locator("#tab-admin").click()
    page.locator("#lock-screen").wait_for()
    page.locator("#login-submit-btn").scroll_into_view_if_needed()
    assert page.locator("#login-submit-btn").is_visible()
    box = page.locator(".lock-box").bounding_box()
    assert box["y"] >= 12 and box["y"] + box["height"] <= 556, "短螢幕登入卡片應完整顯示"
    page.close()


def verify_supervisor_home(browser):
    page = new_test_page(browser, {"width": 390, "height": 844})
    page.add_init_script("""
      localStorage.setItem('guide_done', '1');
      localStorage.setItem('supervisors', JSON.stringify([{
        empId: '7001', name: '測試幹部', title: '主任', active: true,
        sites: ['A058'], permissions: [], viewAll: false
      }]));
    """)
    page.goto(BASE_URL, wait_until="domcontentloaded")
    stub_backend_sync(page)
    page.locator("#tab-admin").click()
    page.locator("#role-supervisor").click()
    page.locator("#sup-emp-input").fill("7001")
    page.locator("#login-submit-btn").click()
    assert page.locator("#supervisor-home").is_visible()
    assert not page.locator("#page-checkin").is_visible(), "進入後台後打卡首頁不可佔用畫面"
    assert "測試幹部" in page.locator("#supervisor-home-title").inner_text()
    assert "1 個案場" in page.locator("#supervisor-home-scope").inner_text()
    assert page.locator("#supervisor-home").get_by_role("button").count() == 3
    assert not page.locator("#sub-records").is_visible()
    assert not page.locator("#admin-extra-menu .admin-menu-section").first.is_visible()
    page.locator("#admin-extra-menu summary").click()
    assert page.locator("#admin-extra-menu .admin-menu-section").first.is_visible()
    page.close()


def verify_yangji_post_selection(browser):
    page = new_test_page(browser, {"width": 390, "height": 844})
    page.add_init_script("""
      localStorage.setItem('guide_done', '1');
      localStorage.setItem('employees', JSON.stringify([{id:'70000001', name:'測試人員'}]));
      localStorage.setItem('sites_catalog_version', '2026-09-10');
      localStorage.setItem('sites', JSON.stringify([
        {id:'C151', name:'洋基美光－早', active:true},
        {id:'A001', name:'一般案場', active:true}
      ]));
    """)
    page.goto(BASE_URL, wait_until="domcontentloaded")
    page.evaluate("""() => {
      FB_AUTH_READY = new Promise(() => {});
      CURRENT_SITE_ID = 'C151'; currentId = '70000001';
      fetchClientIP = async () => null;
      uploadToFirebase = () => {};
      SCRIPT_URL = ''; IS_DEMO = true;
      doPunch('上班');
    }""")
    page.locator("#yangji-post-modal.show").wait_for()
    assert page.locator("#yangji-post-options").get_by_role("button", name="東哨D2").count() == 1
    page.locator("#yangji-post-options").get_by_role("button", name="東哨D2").click()
    page.wait_for_function("localRecs.length === 1")
    assert page.evaluate("localRecs[0].postName") == "東哨D2"

    page.evaluate("""() => {
      CURRENT_SITE_ID = 'A001';
      doPunch('下班');
    }""")
    page.wait_for_function("localRecs.length === 2")
    assert not page.locator("#yangji-post-modal").evaluate("el => el.classList.contains('show')")
    assert page.evaluate("localRecs[0].postName") is None
    page.close()


def verify_collapsed_announcement(browser):
    page = new_test_page(browser, {"width": 390, "height": 844})
    page.add_init_script("localStorage.setItem('guide_done', '1')")
    page.goto(BASE_URL, wait_until="domcontentloaded")
    assert not page.locator("#announcement-toggle").is_visible()
    assert not page.locator("#announce-bar").is_visible()
    page.close()

    page = new_test_page(browser, {"width": 390, "height": 844})
    page.add_init_script("""
      localStorage.setItem('guide_done', '1');
      localStorage.setItem('site_announcement', '測試公告');
      localStorage.setItem('site_announcement_level', 'urgent');
    """)
    page.goto(BASE_URL, wait_until="domcontentloaded")
    assert page.locator("#announcement-toggle").is_visible()
    assert not page.locator("#announce-bar").is_visible()
    page.locator("#announcement-toggle").click()
    assert page.locator("#announce-bar").is_visible()
    assert "測試公告" in page.locator("#announce-bar").inner_text()
    page.close()


def verify_local_duty_status_and_handover(browser):
    page = new_test_page(browser, {"width": 320, "height": 568})
    page_errors = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.add_init_script("""
      localStorage.setItem('guide_done', '1');
      localStorage.setItem('last_emp_id', '70000001');
      localStorage.setItem('employees', JSON.stringify([{id:'70000001',name:'本人同仁'}]));
      localStorage.setItem('sites_catalog_version', '2026-09-10');
      localStorage.setItem('sites', JSON.stringify([{id:'A001',name:'一般案場',active:true},{id:'C151',name:'洋基美光－早',active:true}]));
      localStorage.setItem('local_records', JSON.stringify([
        {empId:'70000001',siteId:'A001',type:'上班',date:'2026-10-14',time:'20:00:00',timestamp:'2026-10-14T20:00:00+08:00',synced:false,fbSynced:false},
        {empId:'70000001',siteId:'A001',type:'下班',date:'2026-10-15',time:'04:00:00',timestamp:'2026-10-15T04:00:00+08:00',synced:false,fbSynced:false}
      ]));
    """)
    page.goto(BASE_URL, wait_until="domcontentloaded")
    assert page.locator("#my-duty-card").count() == 1
    assert not page.locator("#my-duty-card").is_visible(), "僅還原上次編號不應顯示個人勤務"
    page.evaluate("() => { currentId='70000001'; confirmId(); }")
    assert page.locator("#my-duty-card").is_visible()
    assert "10/14" in page.locator("#my-duty-in").inner_text()
    assert "10/15" in page.locator("#my-duty-out").inner_text()
    assert page.locator("#my-duty-status").inner_text() == "已儲存待同步"
    page.locator("#btn-in").scroll_into_view_if_needed()
    assert page.locator("#btn-in").is_visible(), "短手機仍可捲動到打卡按鈕"
    assert page.evaluate("document.querySelector('#change-btn').getBoundingClientRect().top >= document.querySelector('#btn-in').getBoundingClientRect().bottom"), "打卡按鈕不可與換人按鈕重疊"
    page.evaluate("openDrawer()")
    assert not page.locator("#my-duty-card").is_visible()
    assert page.locator("#my-duty-in").inner_text() == ""
    page.evaluate("""() => {
      closeDrawer(); currentId='70000001'; confirmId();
      const incoming={empId:'70000001',siteId:'C151',postName:'東哨D2',type:'上班',date:'2026-10-15',time:'20:00:00',timestamp:'2026-10-15T20:00:00+08:00'};
      localRecs=[{...incoming,empId:'other',name:'不應公開姓名',time:'08:00:00',timestamp:'2026-10-15T08:00:00+08:00'},incoming];
      showLocalHandoverReminder(incoming);
    }""")
    page.locator("#handover-reminder-modal.show").wait_for()
    reminder = page.locator("#handover-reminder-modal").inner_text()
    assert "交接班貼心提醒" in reminder
    assert "不應公開姓名" not in reminder and "other" not in reminder and "08:00" not in reminder
    assert page.locator("#handover-reminder-modal").get_by_role("button").count() == 1
    page.get_by_role("button", name="知道了", exact=True).click()
    assert not page.locator("#handover-reminder-modal").is_visible()
    page.evaluate("showLocalHandoverReminder(localRecs[1])")
    assert not page.locator("#handover-reminder-modal").is_visible()
    page.evaluate("""() => {
      CURRENT_SITE_ID=null; IS_DEMO=false; getSites=()=>[{id:'A001',active:true}];
      window.beforeQrPunch=localRecs.length; doPunch('上班');
    }""")
    assert page.evaluate("localRecs.length === beforeQrPunch"), "未掃 QR 時不得新增打卡"
    assert not page_errors, f"頁面 JavaScript 錯誤：{page_errors}"
    page.close()


def verify_restored_identity_punch_privacy(browser):
    for confirmed in (False, True):
        page = new_test_page(browser, {"width": 390, "height": 844})
        page.add_init_script("""
          localStorage.setItem('guide_done', '1');
          localStorage.setItem('last_emp_id', '70000001');
          localStorage.setItem('employees', JSON.stringify([{id:'70000001',name:'本人同仁'}]));
          localStorage.setItem('sites_catalog_version', '2026-09-10');
          localStorage.setItem('sites', JSON.stringify([{id:'C151',name:'洋基美光－早',active:true}]));
          const prior = new Date(Date.now() - 12*60*60*1000);
          const record = {empId:'other',siteId:'C151',postName:'東哨D2',type:'上班',date:'2026-10-14',time:'08:00:00',timestamp:prior.toISOString(),synced:true,fbSynced:true};
          localStorage.setItem('local_records', JSON.stringify([record,
            {...record,empId:'70000001',siteId:'A001',type:'下班',timestamp:new Date(prior.getTime()-60*60*1000).toISOString()}
          ]));
        """)
        page.goto(BASE_URL, wait_until="domcontentloaded")
        assert page.evaluate("_myDutyEmpId") == ""
        assert not page.locator("#my-duty-card").is_visible()
        if confirmed:
            page.evaluate("() => { currentId='70000001'; confirmId(); }")
        page.evaluate("""async () => {
          CURRENT_SITE_ID='C151'; IS_DEMO=false; SCRIPT_URL='';
          saveYangjiPostSelection('70000001','C151','東哨D2');
          fetchClientIP=async()=>null; uploadToFirebase=()=>{};
          await doPunch('上班');
        }""")
        page.wait_for_timeout(3400)
        assert page.evaluate("localRecs.length") == 3, "恢復上次編號仍可成功 QR 打卡"
        assert page.evaluate("_myDutyEmpId") == ("70000001" if confirmed else "")
        assert page.locator("#my-duty-card").is_visible() == confirmed
        assert page.locator("#handover-reminder-modal").is_visible() == confirmed
        if confirmed:
            assert page.locator("#my-duty-status").inner_text() == "已儲存待同步"
            assert page.evaluate("document.querySelector('#my-duty-in').textContent.endsWith(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(localRecs[0].timestamp)))")
        else:
            for field in ("my-duty-in", "my-duty-out", "my-duty-status"):
                assert page.locator(f"#{field}").text_content() == ""
            assert page.evaluate("localStorage.getItem('smart_attendance_v4_handover_seen')") is None
        page.close()

def verify_local_makeup_draft(browser):
    page = new_test_page(browser, {"width": 320, "height": 568})
    page_errors = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.add_init_script("""
      localStorage.setItem('guide_done','1');
      localStorage.setItem('last_emp_id','70000001');
      localStorage.setItem('employees',JSON.stringify([{id:'70000001',name:'本人同仁'}]));
      localStorage.setItem('sites_catalog_version','2026-09-10');
      localStorage.setItem('sites',JSON.stringify([{id:'A001',name:'一般案場',active:true}]));
      const prior = new Date(Date.now()-30*60*60*1000);
      localStorage.setItem('local_records',JSON.stringify([{empId:'70000001',siteId:'A001',postName:null,type:'上班',timestamp:prior.toISOString(),date:prior.toISOString().slice(0,10),time:'20:00:00',synced:true,fbSynced:true}]));
    """)
    page.goto(BASE_URL, wait_until="domcontentloaded")
    assert page.locator('#makeup-modal').count() == 1
    assert not page.locator('#makeup-modal').is_visible(), '還原編號不得顯示補卡資料'
    page.evaluate("() => { currentId='70000001'; confirmId(); }")
    page.evaluate("""async () => {
      CURRENT_SITE_ID='A001';IS_DEMO=false;SCRIPT_URL='';
      fetchClientIP=async()=>null;uploadToFirebase=()=>{};
      window.originalPrior = JSON.stringify(localRecs[0]);
      await doPunch('上班');
    }""")
    page.locator('#makeup-modal.show').wait_for()
    box = page.locator('#makeup-modal .modal-box').bounding_box()
    assert box['y'] >= 0 and box['y'] + box['height'] <= 568, '短手機補卡視窗須完整顯示並可捲動'
    assert '前次出勤待確認' in page.locator('#makeup-modal').inner_text()
    assert page.evaluate('localRecs.length') == 2
    page.get_by_role('button', name='稍後處理', exact=True).click()
    assert not page.locator('#makeup-modal').is_visible()
    page.evaluate("() => { openDrawer();currentId='70000001';confirmId(); }")
    page.locator('#makeup-modal.show').wait_for()
    assert page.evaluate("JSON.parse(localStorage.getItem('smart_attendance_v4_makeup_cases')).length") == 2
    page.locator('#makeup-date').fill('2000-01-01')
    page.locator('#makeup-time').fill('08:00')
    page.get_by_role('button', name='儲存本機補卡申請', exact=True).click()
    assert '不得早於' in page.locator('#makeup-error').inner_text()
    date, time = page.evaluate("""() => {
      const end = new Date(Date.parse(localRecs[1].timestamp)+12*60*60*1000);
      const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(end);
      const p=type=>parts.find(item=>item.type===type).value;
      return [`${p('year')}-${p('month')}-${p('day')}`,`${p('hour')}:${p('minute')}`];
    }""")
    page.locator('#makeup-date').fill(date)
    page.locator('#makeup-time').fill(time)
    page.evaluate("""() => {
      window.beforeFailureLedger=localStorage.getItem('smart_attendance_v4_makeup_cases');
      window.beforeFailureRecords=JSON.stringify(localRecs);
      window.originalStorageSetItem=Storage.prototype.setItem;
      Storage.prototype.setItem=function(key,value){
        if(key==='smart_attendance_v4_makeup_cases') throw new DOMException('Storage full','QuotaExceededError');
        return window.originalStorageSetItem.call(this,key,value);
      };
    }""")
    for action in ('儲存本機補卡申請', '稍後處理'):
        page.get_by_role('button', name=action, exact=True).click()
        assert '尚未儲存' in page.locator('#makeup-error').inner_text()
        assert page.locator('#makeup-modal').is_visible()
        page.get_by_role('button', name='取消（不儲存）', exact=True).click()
        assert not page.locator('#makeup-modal').is_visible()
        assert page.evaluate("localStorage.getItem('smart_attendance_v4_makeup_cases')===beforeFailureLedger")
        assert page.evaluate('JSON.stringify(localRecs)===beforeFailureRecords')
        page.evaluate("() => { openDrawer();currentId='70000001';confirmId(); }")
        page.locator('#makeup-modal.show').wait_for()
        page.locator('#makeup-date').fill(date)
        page.locator('#makeup-time').fill(time)
    page.get_by_role('button', name='取消（不儲存）', exact=True).click()
    page.evaluate("""async () => {
      CURRENT_SITE_ID='A001';
      await doPunch('下班');
      employees.push({id:'70000002',name:'換班同仁'});
      openDrawer();currentId='70000002';confirmId();
      CURRENT_SITE_ID='A001';
      await doPunch('上班');
    }""")
    assert page.evaluate('localRecs.length') == 4, '補卡額滿取消後仍可QR打卡及換人打卡'
    assert page.evaluate("localRecs[0].empId") == '70000002'
    assert page.evaluate("localStorage.getItem('smart_attendance_v4_makeup_cases')===beforeFailureLedger")
    page.evaluate("() => { openDrawer();currentId='70000001';confirmId(); }")
    page.locator('#makeup-modal.show').wait_for()
    page.locator('#makeup-date').fill(date)
    page.locator('#makeup-time').fill(time)
    page.evaluate('() => { Storage.prototype.setItem=window.originalStorageSetItem; }')
    page.get_by_role('button', name='儲存本機補卡申請', exact=True).click()
    assert page.locator('#makeup-message').inner_text() == '已儲存待主管核實，本裝置尚未送至雲端'
    assert page.evaluate('JSON.stringify(localRecs[3]) === originalPrior')
    assert page.evaluate('localRecs.length') == 4
    assert page.evaluate("JSON.parse(localStorage.getItem('smart_attendance_v4_makeup_cases')).at(-1).status") == 'requested'
    page.get_by_role('button', name='關閉', exact=True).click()
    page.reload(wait_until='domcontentloaded')
    assert not page.locator('#makeup-modal').is_visible()
    assert not page_errors, f'補卡頁面 JavaScript 錯誤：{page_errors}'
    page.close()


with sync_playwright() as playwright:
    import shutil
    browser = playwright.chromium.launch(headless=True, executable_path=shutil.which("chromium"))
    verify_local_makeup_draft(browser)
    verify_admin_cloud_confirmation(browser)
    verify_admin_entry_over_overlays(browser)
    verify_login_layout_on_short_phone(browser)
    verify_supervisor_home(browser)
    verify_yangji_post_selection(browser)
    verify_collapsed_announcement(browser)
    verify_restored_identity_punch_privacy(browser)
    verify_local_duty_status_and_handover(browser)
    verify_viewport(browser, {"width": 390, "height": 844})
    verify_viewport(browser, {"width": 1440, "height": 900})
    browser.close()

print("ui smoke passed: mobile + desktop")
