"""
国家CMA滑块端到端PoC：探查滑块DOM结构 + 截图，搞清楚拖拽换算关系。
第一阶段：只探查，不拖拽。打印滑块容器、背景图、滑块手柄的尺寸和位置。
"""
import asyncio, base64, json, re
from playwright.async_api import async_playwright

URL = "http://cma.cnca.cn/cma/solr/tBzAbilitySearch/list"
CERT = "230020349767"

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width":1400,"height":1000})
        page = await ctx.new_page()

        captcha_payload = {}
        async def on_resp(resp):
            if "getSliderCaptcha" in resp.url:
                try:
                    j = await resp.json()
                    captcha_payload.update(j)
                    print("[captcha接口] y=", j.get("y"), "bg_len=", len(j.get("bg","")), "slider_len=", len(j.get("slider","")))
                except Exception as e:
                    print("captcha resp parse err", e)
        page.on("response", on_resp)

        await page.goto(URL, wait_until="domcontentloaded")
        await page.fill('input[name="certCode"]', CERT)
        # 点查询触发滑块
        await page.click('#btnSubmit')
        await page.wait_for_timeout(2500)

        # 探查滑块相关DOM：常见的滑块库类名
        info = await page.evaluate("""() => {
          const out = {};
          // 把所有可能跟滑块相关的元素抓出来
          const cands = document.querySelectorAll('div,img,canvas,span');
          const hits = [];
          for (const el of cands) {
            const cls = (el.className && el.className.toString()) || '';
            const id = el.id || '';
            const txt = (el.textContent||'').slice(0,20);
            if (/slid|captcha|verify|drag|gap|puzzle|block|滑动|验证/i.test(cls+' '+id+' '+txt)) {
              const r = el.getBoundingClientRect();
              if (r.width>0 && r.height>0)
                hits.push({tag:el.tagName, cls, id, txt, x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height), src:(el.src||'').slice(0,40)});
            }
          }
          out.hits = hits.slice(0,30);
          return out;
        }""")
        print(json.dumps(info, ensure_ascii=False, indent=1))

        await page.screenshot(path="cma_slider_dom.png")
        if captcha_payload.get("bg"):
            open("live_bg.png","wb").write(base64.b64decode(captcha_payload["bg"]))
            open("live_sl.png","wb").write(base64.b64decode(captcha_payload["slider"]))
            print("saved live_bg.png / live_sl.png, y=", captcha_payload.get("y"))
        await browser.close()

asyncio.run(main())
