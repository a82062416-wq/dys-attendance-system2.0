import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("DYS_TEST_URL", Path(__file__).resolve().parents[1].joinpath("index.html").as_uri())


def verify_viewport(browser, viewport):
    page = browser.new_page(viewport=viewport)
    page.set_default_timeout(5000)
    page_errors = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.goto(BASE_URL, wait_until="domcontentloaded")
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
    page.locator("#role-supervisor").click()
    assert page.locator("#login-role-title").inner_text() == "幹部登入"
    assert page.locator("#sup-id-wrap").is_visible()
    assert not page_errors, f"頁面 JavaScript 錯誤：{page_errors}"
    page.close()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    verify_viewport(browser, {"width": 390, "height": 844})
    verify_viewport(browser, {"width": 1440, "height": 900})
    browser.close()

print("ui smoke passed: mobile + desktop")
