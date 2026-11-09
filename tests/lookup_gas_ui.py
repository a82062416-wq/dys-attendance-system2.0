"""Synthetic browser smoke: no production Firebase or personal data."""
from pathlib import Path
from playwright.sync_api import sync_playwright

URL=(Path(__file__).resolve().parents[1]/'lookup-gas'/'Lookup.html').as_uri()
INIT="""
window.__testRequests=[];window.__testCallbacks={};
window.google={script:{run:{
 withSuccessHandler:function(fn){window.__testCallbacks.ok=fn;return this;},
 withFailureHandler:function(fn){window.__testCallbacks.fail=fn;return this;},
 lookupEmployee:function(data){window.__testRequests.push({action:'lookup',data:data});},
 issuePairCode:function(data){window.__testRequests.push({action:'issue',data:data});},
 revokePairings:function(data){window.__testRequests.push({action:'revoke',data:data});}
}}};
"""
def run(browser,width):
    page=browser.new_page(viewport={'width':width,'height':844},service_workers='block')
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.route('**/*',lambda r:r.continue_() if r.request.url.startswith('file:') else r.abort())
    page.add_init_script(INIT);page.goto(URL,wait_until='domcontentloaded')
    page.locator('#name').fill('測試同仁');page.locator('#suffix').fill('0042');page.locator('#code').fill('123456')
    page.locator('#lookup-btn').click()
    assert page.locator('#lookup-btn').is_disabled()
    assert page.evaluate('__testRequests.length')==1
    assert page.evaluate('!location.search')
    page.evaluate('__testCallbacks.ok({ok:false})')
    assert page.locator('#suffix').input_value()=='0042'
    assert page.locator('#code').input_value()=='123456'
    assert not page.locator('#lookup-btn').is_disabled()
    page.locator('#lookup-btn').click()
    page.evaluate("__testCallbacks.ok({ok:true,employeeId:'00000001',deviceToken:'a'.repeat(64)})")
    assert '00000001' in page.locator('#result').inner_text()
    assert page.locator('#suffix').input_value()==''
    assert not page.locator('#code-wrap').is_visible()
    assert page.evaluate("localStorage.getItem('dys_lookup_device_v1')==='a'.repeat(64)")
    page.locator('#forget').click()
    assert page.locator('#code-wrap').is_visible()
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    assert not errors,errors
    page.close()

with sync_playwright() as p:
    for kind in ('chromium','webkit'):
        browser=getattr(p,kind).launch(headless=True)
        for width in (320,390,1440):run(browser,width)
        browser.close();print(kind+': synthetic lookup form checks passed')
