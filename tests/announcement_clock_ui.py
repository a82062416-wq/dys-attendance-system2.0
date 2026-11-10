"""Clock announcement entry; synthetic data, all production traffic blocked."""
import json
import os
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

BASE = os.environ.get('DYS_TEST_URL', 'http://127.0.0.1:18775/')
UNPUBLISHED = {'fields': {'published': {'booleanValue': False}}, 'updateTime': '2026-11-10T00:00:00Z'}
PUBLISHED = {'fields': {'published': {'booleanValue': True}, 'text': {'stringValue': '虛構公告 <img src=x>'},
    'level': {'stringValue': 'urgent'}, 'expiresAt': {'timestampValue': '2099-01-01T00:00:00Z'}},
    'updateTime': '2026-11-10T01:00:00Z'}
LONG_NOTICE = {'fields': {'published': {'booleanValue': True}, 'text': {'stringValue': '虛構長公告' + '測試' * 450},
    'level': {'stringValue': 'normal'}, 'expiresAt': {'timestampValue': '2099-01-01T00:00:00Z'}},
    'updateTime': '2026-11-10T02:00:00Z'}


def check(browser, width, state, cached=None):
    page = browser.new_page(viewport={'width': width, 'height': 844}, service_workers='block')
    errors = []
    page.on('pageerror', lambda err: errors.append(str(err)))

    def route(r):
        if '/__mock_firestore__/' in r.request.url:
            if state == 'offline':
                r.abort()
            else:
                r.fulfill(json=UNPUBLISHED if state == 'empty' else LONG_NOTICE if state == 'long' else PUBLISHED,
                          headers={'Access-Control-Allow-Origin': '*'})
        elif urlsplit(r.request.url).netloc == urlsplit(BASE).netloc:
            r.continue_()
        else:
            r.abort()

    page.route('**/*', route)
    init = """const realFetch=window.fetch.bind(window);
      window.fetch=(url,opts)=>realFetch(String(url).replace('https://firestore.googleapis.com/',location.origin+'/__mock_firestore__/'),opts);
      localStorage.setItem('guide_done','1');
      localStorage.setItem('local_records','[]');"""
    if cached:
        init += "localStorage.setItem('dys_shared_announcement_v1'," + json.dumps(json.dumps(cached, ensure_ascii=False)) + ");"
    page.add_init_script(init)
    page.goto(BASE, wait_until='domcontentloaded')
    page.wait_for_function('window.DysAnnouncement')
    page.locator('#keyboard-overlay.show').wait_for()
    page.evaluate("currentId='7';document.getElementById('id-display-text').textContent='7'")

    button = page.locator('#announcement-toggle')
    assert button.is_visible(), '入口應在沒有公告與離線時可見'
    assert page.locator('.time-card #announcement-toggle').count() == 1, '入口應位於時間卡片中'
    assert button.get_attribute('aria-expanded') == 'false'
    assert not page.locator('#announce-bar').is_visible()
    clock = page.locator('#tc-clock').bounding_box()
    entry = button.bounding_box()
    assert entry['height'] >= 40, '手機應有足夠的點按範圍'
    assert not (clock['x'] < entry['x'] + entry['width'] and clock['x'] + clock['width'] > entry['x']
                and clock['y'] < entry['y'] + entry['height'] and clock['y'] + clock['height'] > entry['y']), '公告入口不得遮住時鐘'
    before = page.locator('.main-card').bounding_box()['y']
    button.click()
    expected = '目前沒有公告' if state == 'empty' else '暫時無法載入' if state == 'offline' and not cached else '虛構長公告' if state == 'long' else '虛構公告'
    page.wait_for_function('(message) => document.getElementById("announce-bar").textContent.includes(message)', arg=expected)
    bar = page.locator('#announce-bar')
    assert bar.is_visible() and button.get_attribute('aria-expanded') == 'true'
    if cached:
        assert '離線副本' in bar.inner_text()
    assert bar.locator('img').count() == 0, '公告不得解讀成 HTML'
    if state == 'long':
        assert bar.evaluate('el => el.scrollHeight > el.clientHeight'), '長公告應能捲動'
        bar.evaluate('el => el.scrollTop = el.scrollHeight')
        assert bar.get_by_role('button', name='收合公告').is_visible()
    assert abs(page.locator('.main-card').bounding_box()['y'] - before) < 1, '浮層不得推動打卡卡片'
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    if width == 390 and state == 'published' and os.environ.get('DYS_ANNOUNCEMENT_SCREENSHOT'):
        page.screenshot(path=os.environ['DYS_ANNOUNCEMENT_SCREENSHOT'])
    assert page.evaluate('closeTopOverlay()') is True
    assert not bar.is_visible() and page.locator('#keyboard-overlay.show').count() == 1
    assert page.evaluate('currentId') == '7', '返回應先收合公告而不清除工號'
    button.click()
    close = bar.get_by_role('button', name='收合公告')
    assert page.evaluate("""async () => {
      const e=document.querySelector('#announce-bar .announce-dismiss');e.focus();
      try { await window.DysAnnouncement.refresh(true); } catch (_) {}
      return document.activeElement===e;
    }"""), '公告更新時須保留關閉按鈕與焦點'
    assert close.bounding_box()['height'] >= 40
    close.click()
    assert not bar.is_visible() and button.get_attribute('aria-expanded') == 'false'
    assert button.evaluate('el => document.activeElement === el')
    assert page.locator('#keyboard-overlay').evaluate("el => el.classList.contains('show')")
    assert page.evaluate('currentId') == '7', '不得清除正在輸入的工號'
    assert page.evaluate("localStorage.getItem('local_records')") == '[]'
    assert not errors, errors
    page.close()


def check_modal_and_pwa(browser):
    context = browser.new_context(viewport={'width': 390, 'height': 844})
    context.route('**/*', lambda r: r.continue_() if urlsplit(r.request.url).netloc == urlsplit(BASE).netloc else r.abort())
    page = context.new_page()
    page.add_init_script("localStorage.setItem('guide_done','1')")
    page.goto(BASE + 'index.html', wait_until='load')
    page.locator('#keyboard-overlay.show').wait_for()
    page.locator('#announcement-toggle').click()
    page.evaluate('openEmployeeLookup()')
    page.locator('#employee-lookup-modal.show').wait_for()
    assert page.evaluate("""() => {
      const r=document.getElementById('announcement-toggle').getBoundingClientRect();
      return !!document.elementFromPoint(r.x+r.width/2,r.y+r.height/2).closest('#employee-lookup-modal');
    }"""), '工號查詢視窗必須在公告入口之上'
    page.evaluate('closeEmployeeLookup();toggleAnnouncement(false)')
    page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
    page.evaluate("""async () => {
      await caches.open('synthetic-unrelated-cache');await caches.open('attendance-v0-synthetic');
      await navigator.serviceWorker.register('./sw.js?synthetic-update');
    }""")
    page.wait_for_function("navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL.includes('synthetic-update')", timeout=15000)
    assert page.evaluate("""async () => {
      for(let n=0;n<150;n++){
        if(!(await caches.has('attendance-v0-synthetic')))return true;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      return false;
    }"""), '舊版打卡快取未在期限內清理'
    assert page.evaluate("caches.has('synthetic-unrelated-cache')"), '更新不得刪除其他系統的快取'
    assert not page.evaluate("caches.has('attendance-v0-synthetic')"), '只清除舊版打卡系統快取'
    queued = '[{"empId":"70000001","type":"上班","timestamp":"2026-11-10T01:00:00Z","synced":false,"fbSynced":false}]'
    page.evaluate('(value) => localStorage.setItem("local_records",value)', queued)
    context.set_offline(True)
    page.reload(wait_until='domcontentloaded')
    page.wait_for_function('window.DysAnnouncement')
    assert page.evaluate("localStorage.getItem('local_records')") == queued, '離線重新開啟不得清除待補傳紀錄'
    assert page.locator('#announcement-toggle').is_visible()
    context.close()


def check_short_screen(browser):
    page = browser.new_page(viewport={'width': 320, 'height': 568}, service_workers='block')
    page.route('**/*', lambda r: r.continue_() if urlsplit(r.request.url).netloc == urlsplit(BASE).netloc else r.abort())
    page.add_init_script("localStorage.setItem('guide_done','1')")
    page.goto(BASE, wait_until='domcontentloaded')
    page.locator('#keyboard-overlay.show').wait_for()
    page.wait_for_timeout(500)  # Allow the keyboard opening transition to finish.
    close = page.locator('#keyboard-overlay .ko-close')
    assert page.evaluate("""() => {
      const e=document.querySelector('#keyboard-overlay .ko-close'),r=e.getBoundingClientRect();
      return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
    }"""), '小螢幕公告不得遮住鍵盤關閉鍵'
    close.click()
    page.locator('#announcement-toggle').click()
    assert page.locator('#announce-bar').is_visible()
    page.evaluate('openDrawer()')
    assert not page.locator('#announce-bar').is_visible(), '開啟鍵盤時應先收合公告'
    assert page.locator('#keyboard-overlay.show').count() == 1
    page.close()


with sync_playwright() as p:
    for kind in os.environ.get('DYS_BROWSERS', 'chromium,webkit').split(','):
        browser = getattr(p, kind).launch(headless=True)
        for width in (320, 390, 1440):
            check(browser, width, 'empty')
            check(browser, width, 'published')
            check(browser, width, 'offline')
            check(browser, width, 'offline', {'text': '虛構公告', 'level': 'urgent', 'expiresAt': 4070908800000})
        check(browser, 390, 'long')
        check_modal_and_pwa(browser)
        check_short_screen(browser)
        browser.close()
        print(kind + ': entry, empty, published, offline, cached, layout and queue PASS')
