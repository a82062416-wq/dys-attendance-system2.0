"""Synthetic homepage test; no production attendance, lookup or QR requests."""
from playwright.sync_api import sync_playwright
URL='http://127.0.0.1:18767/'
with sync_playwright() as p:
    for kind in ('chromium','webkit'):
        browser=getattr(p,kind).launch(headless=True)
        for width in (320,390,1440):
            page=browser.new_page(viewport={'width':width,'height':844},service_workers='block')
            page.route('**/*',lambda r:r.continue_() if r.request.url.startswith(URL) else r.abort())
            errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
            page.add_init_script("localStorage.setItem('guide_done','1');localStorage.setItem('local_records','[]')")
            page.goto(URL,wait_until='domcontentloaded')
            page.evaluate('openEmployeeLookup()')
            assert page.locator('#employee-lookup-modal').is_visible()
            assert page.locator('#secure-id-lookup-link').is_hidden()
            page.locator('#lookup-name').fill('虛構同仁')
            page.locator('#lookup-value').fill('1234')
            page.evaluate("configureSecureLookupEntry('https://script.google.com/macros/s/TEST_ONLY/exec')")
            link=page.locator('#secure-id-lookup-link')
            assert link.is_visible()
            assert link.get_attribute('href')=='https://script.google.com/macros/s/TEST_ONLY/exec'
            assert link.get_attribute('rel')=='noopener noreferrer'
            assert page.locator('#lookup-name').input_value()=='虛構同仁'
            assert page.locator('#lookup-value').input_value()=='1234'
            assert page.evaluate("localStorage.getItem('local_records')==='[]'")
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            assert not errors,errors
            page.close()
        browser.close();print(kind+': secure lookup entry and attendance queue smoke passed')
