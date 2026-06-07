import type { Browser, Page } from 'playwright';

/**
 * 国家 CMA 抓取器（cma.cnca.cn，playwright + 页内 fetch/canvas）。
 *
 * 2026-06-08 攻克（原阶段 5「滑块止损」结论已翻案）。关键事实：
 *
 * 1. 滑块缺口直检（非模板匹配）：GET getSliderCaptcha 返回 {bg,slider,y}(base64)，
 *    对背景图缺口行带(y..y+45)做垂直 Sobel，找相距一个滑块宽(45px)的两条竖边，
 *    左边那条 = 缺口左缘 = moveX。POST captchaVerify body `moveX=<int>` → success/fail。
 *    实测 20/20 稳定（远比当年判断的「不稳」可靠）。
 * 2. 验证态绑 session cookie，但 list/formAbility 提交 body 还要再带 finalX=<moveX>。
 * 3. 三层下钻，每层各过一次滑块：
 *      list(机构,含 placeId/applyId) → formAbility 场所表(每场所 placeId)
 *      → formAbility(按场所 placeId 抓资质明细，支持分页)。
 *    一个机构遍历所有场所，各自抓全量明细。
 *
 * 为何用 playwright：滑块/查询全程同源 cookie 由浏览器管理，canvas 解码 PNG 算 Sobel
 * 缺口（Node 无内置 PNG 解码），page.evaluate 里 fetch 自动带 cookie。复用 CNAS 同款
 * 浏览器基础设施（自带 chromium / NAT_CMA_CHROME_PATH 退路）。
 */

const NAT_CMA_BASE = 'http://cma.cnca.cn/cma';

/** 抓取运行参数（来自 settings，全可选）。 */
export interface NatCmaScrapeOpts {
  /** 浏览器 executablePath，仅首次 launch 生效。 */
  chromePath?: string;
  /** 翻页/下钻节流下限（ms），实际等待 = throttleMs + random(0~800)。默认 600。 */
  throttleMs?: number;
  /** 每个场所最多抓几页（0=全量）。用于测试/限量抓取。默认 0。 */
  maxPagesPerPlace?: number;
}

/** list 命中的机构行。 */
export interface NatCmaOrg {
  certCode: string;
  orgName: string;
  address: string;
  placeId: string;
  applyId: string;
}

/** 机构下的一个场所。 */
export interface NatCmaPlace {
  placeAttr: string;   // 主场所 / 分场所
  placeName: string;
  placeAddress: string;
  placeId: string;
}

/** 一条资质能力明细（场所维度）。 */
export interface NatCmaCapability {
  category: string;     // 大类
  subCategory: string;  // 类别
  testParam: string;    // 产品/项目/参数
  stdName: string;      // 标准名称
  stdCodeRaw: string;   // 标准编号（末尾可能粘连「是否食品」列，交由 cleanStdCode 归一）
  isFood: string;
  placeName: string;
  placeAddress: string;
}

export class NatCmaScraper {
  /** 共享 headless Chromium。 */
  private browser: Browser | null = null;
  private browserLaunch: Promise<Browser> | null = null;

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    this.browserLaunch = null;
    if (b) { try { await b.close(); } catch { /* best effort */ } }
  }

  /** 启动（或返回）共享 Chromium。chromePath 优先用传入值，否则回退环境变量。 */
  private async ensureBrowser(chromePath?: string): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (!this.browserLaunch) {
      this.browserLaunch = (async () => {
        const pw = await import('playwright');
        const execPath = chromePath?.trim()
          || process.env.NAT_CMA_CHROME_PATH?.trim()
          || process.env.CNAS_CHROME_PATH?.trim();
        const b = await pw.chromium.launch({
          headless: true,
          ...(execPath ? { executablePath: execPath } : {}),
          args: ['--disable-blink-features=AutomationControlled'],
        });
        b.on('disconnected', () => { this.browser = null; this.browserLaunch = null; });
        this.browser = b;
        return b;
      })().catch((err) => { this.browserLaunch = null; throw err; });
    }
    return this.browserLaunch;
  }

  /** 开一个独立 page（独立 context），预热 list 页拿 session cookie。 */
  private async openPage(chromePath?: string): Promise<{ page: Page; release: () => Promise<void> }> {
    const browser = await this.ensureBrowser(chromePath);
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });
    const page = await context.newPage();
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      try { await context.close(); } catch { /* best effort */ }
    };
    try {
      await page.goto(`${NAT_CMA_BASE}/solr/tBzAbilitySearch/list`, { timeout: 30_000, waitUntil: 'domcontentloaded' });
      return { page, release };
    } catch (err) {
      await release();
      throw err;
    }
  }

  /** 按机构名搜候选机构（过一次滑块）。 */
  async searchOrgs(orgName: string, opts: NatCmaScrapeOpts = {}): Promise<NatCmaOrg[]> {
    const { page, release } = await this.openPage(opts.chromePath);
    try {
      await page.addScriptTag({ content: PAGE_HELPERS });
      const orgs = await page.evaluate(async (name) => {
        // @ts-expect-error 注入的页内 helper
        return await window.__natcma_searchOrgs(name);
      }, orgName);
      return orgs as NatCmaOrg[];
    } finally {
      await release();
    }
  }

  /**
   * 抓一个机构所有场所的资质明细。每个场所、每页各过一次滑块。
   * onProgress(fetched,total) 汇报合计进度（total 为各场所声明条数之和，首场所拿到后才已知）。
   */
  async scrapeOrg(
    org: NatCmaOrg,
    onProgress?: (fetched: number, total: number, placeName: string) => void,
    opts: NatCmaScrapeOpts = {},
  ): Promise<{ places: NatCmaPlace[]; capabilities: NatCmaCapability[] }> {
    const throttle = Math.max(0, opts.throttleMs ?? 600);
    const maxPages = Math.max(0, opts.maxPagesPerPlace ?? 0);
    const { page, release } = await this.openPage(opts.chromePath);
    try {
      await page.addScriptTag({ content: PAGE_HELPERS });

      // 1) 先列出所有场所
      const places = (await page.evaluate(async (args) => {
        // @ts-expect-error 注入的页内 helper
        return await window.__natcma_listPlaces(args.placeId, args.applyId);
      }, { placeId: org.placeId, applyId: org.applyId })) as NatCmaPlace[];

      // 2) 逐场所、逐页抓明细
      const capabilities: NatCmaCapability[] = [];
      let grandTotal = 0;
      const placeTotals: number[] = [];

      // 先探每个场所总数（第 1 页），累加为 grandTotal
      for (const p of places) {
        const first = (await page.evaluate(async (args) => {
          // @ts-expect-error 注入的页内 helper
          return await window.__natcma_fetchPlacePage(args.placeId, args.applyId, args.pageNo, args.pageSize);
        }, { placeId: p.placeId, applyId: org.applyId, pageNo: 1, pageSize: 50 })) as {
          total: number; rows: Array<Omit<NatCmaCapability, 'placeName' | 'placeAddress'>>;
        };
        placeTotals.push(first.total || 0);
        grandTotal += first.total || 0;
        for (const r of first.rows) {
          capabilities.push({ ...r, placeName: p.placeName, placeAddress: p.placeAddress });
        }
        onProgress?.(capabilities.length, grandTotal, p.placeName);
        await sleep(throttle + Math.random() * 800);

        // 剩余页
        const total = first.total || 0;
        const pageSize = 50;
        let pages = Math.ceil(total / pageSize);
        if (maxPages > 0) pages = Math.min(pages, maxPages);
        for (let pageNo = 2; pageNo <= pages; pageNo++) {
          const more = (await page.evaluate(async (args) => {
            // @ts-expect-error 注入的页内 helper
            return await window.__natcma_fetchPlacePage(args.placeId, args.applyId, args.pageNo, args.pageSize);
          }, { placeId: p.placeId, applyId: org.applyId, pageNo, pageSize })) as {
            total: number; rows: Array<Omit<NatCmaCapability, 'placeName' | 'placeAddress'>>;
          };
          if (!more.rows.length) break;
          for (const r of more.rows) {
            capabilities.push({ ...r, placeName: p.placeName, placeAddress: p.placeAddress });
          }
          onProgress?.(capabilities.length, grandTotal, p.placeName);
          await sleep(throttle + Math.random() * 800);
        }
      }

      return { places, capabilities };
    } finally {
      await release();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 注入到页面的 helper（在 cma.cnca.cn 同源上下文里跑，fetch 自带 session cookie）。
 * 暴露 window.__natcma_searchOrgs / __natcma_listPlaces / __natcma_fetchPlacePage。
 * 滑块缺口直检 + 三层查询逻辑，已联网验证 20/20 稳定。
 */
const PAGE_HELPERS = `
(function () {
  var ctx = '/cma';
  var W = 45;

  function gapLeft(bgB64, y) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var cw = img.naturalWidth, ch = img.naturalHeight;
        var cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
        var g = cv.getContext('2d'); g.drawImage(img, 0, 0);
        var top = Math.max(0, Math.min(y, ch - W));
        var data = g.getImageData(0, top, cw, W).data;
        var gray = new Float32Array(cw * W);
        for (var i = 0; i < cw * W; i++) {
          gray[i] = 0.299 * data[i*4] + 0.587 * data[i*4+1] + 0.114 * data[i*4+2];
        }
        var col = new Float32Array(cw);
        for (var x = 1; x < cw - 1; x++) {
          var s = 0;
          for (var yy = 1; yy < W - 1; yy++) {
            var gx = (gray[(yy-1)*cw+(x+1)] + 2*gray[yy*cw+(x+1)] + gray[(yy+1)*cw+(x+1)])
                   - (gray[(yy-1)*cw+(x-1)] + 2*gray[yy*cw+(x-1)] + gray[(yy+1)*cw+(x-1)]);
            s += Math.abs(gx);
          }
          col[x] = s;
        }
        var best = -1, bx = 0;
        for (var x2 = 8; x2 < cw - W; x2++) {
          var sc = col[x2] + col[x2 + W - 1];
          if (sc > best) { best = sc; bx = x2; }
        }
        resolve(bx);
      };
      img.src = 'data:image/png;base64,' + bgB64;
    });
  }

  // 过一次滑块，返回成功的 moveX（用作 finalX）；失败返回 null
  async function passSlider() {
    for (var t = 0; t < 8; t++) {
      var j = await (await fetch(ctx + '/base/tBaRegistered/getSliderCaptcha', {
        headers: { 'X-Requested-With': 'XMLHttpRequest' } })).json();
      var mv = await gapLeft(j.bg, j.y | 0);
      var res = (await (await fetch(ctx + '/base/tBaRegistered/captchaVerify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
        body: 'moveX=' + mv })).text()).trim();
      if (res === 'success') return mv;
      await new Promise(function (r) { setTimeout(r, 400); });
    }
    return null;
  }

  function clean(s) {
    var t = document.createElement('div'); t.innerHTML = s;
    return (t.textContent || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
  }
  function firstTbody(html, idx) {
    var re = /<tbody[^>]*>([\\s\\S]*?)<\\/tbody>/gi, m, arr = [];
    while ((m = re.exec(html)) !== null) arr.push(m[1]);
    return arr[idx] || '';
  }
  function rowsOf(tb) {
    var re = /<tr[^>]*>([\\s\\S]*?)<\\/tr>/gi, m, arr = [];
    while ((m = re.exec(tb)) !== null) arr.push(m[1]);
    return arr;
  }
  function cellsOf(tr) {
    var re = /<td[^>]*>([\\s\\S]*?)<\\/td>/gi, m, arr = [];
    while ((m = re.exec(tr)) !== null) arr.push(m[1]);
    return arr;
  }

  // 第 1 层：按机构名查 list
  window.__natcma_searchOrgs = async function (orgName) {
    var fx = await passSlider();
    if (fx === null) throw new Error('list 滑块未通过');
    var fields = {
      pageNo: '1', pageSize: '-1', applyId: '', placeId: '', flag: '',
      applyOrgName: orgName, placeAddressDetail: '', applyFieldCode: '', applySectorBoard: '',
      abilityParentName: '', abilityTypeName: '', abilityItemName: '',
      abilityStandardName: '', abilityStandardCode: '', certCode: '', finalX: String(fx),
    };
    var body = Object.keys(fields).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(fields[k]);
    }).join('&');
    var html = await (await fetch(ctx + '/solr/tBzAbilitySearch/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body })).text();
    var tb = firstTbody(html, 0);
    var out = [];
    rowsOf(tb).forEach(function (tr) {
      var cells = cellsOf(tr);
      var m = tr.match(/data-placeid="([^"]+)"\\s+data-applyid="([^"]+)"/);
      if (cells.length >= 3 && m) {
        out.push({
          certCode: clean(cells[1]), orgName: clean(cells[2]),
          address: cells[3] ? clean(cells[3]) : '',
          placeId: m[1], applyId: m[2],
        });
      }
    });
    return out;
  };

  // 第 2 层：列出机构所有场所（GET formAbility，取场所表 tbody[0]）
  window.__natcma_listPlaces = async function (placeId, applyId) {
    var fx = await passSlider();
    if (fx === null) throw new Error('formAbility 场所表滑块未通过');
    var qs = new URLSearchParams({
      placeId: placeId, applyId: applyId, applyOrgName: '',
      abilityParentName: '', abilityTypeName: '', abilityItemName: '',
      abilityStandardName: '', abilityStandardCode: '', placeAddressDetail: '',
      flag: '1', finalX: String(fx),
    });
    var html = await (await fetch(ctx + '/solr/tBzAbilitySearch/formAbility?' + qs)).text();
    var tb = firstTbody(html, 0);
    var out = [];
    rowsOf(tb).forEach(function (tr) {
      var cells = cellsOf(tr);
      var m = tr.match(/<input[^>]+value="([0-9A-Fa-f]{20,})"[^>]+type="hidden"/)
           || tr.match(/<input[^>]+type="hidden"[^>]+value="([0-9A-Fa-f]{20,})"/);
      if (cells.length >= 3 && m) {
        out.push({
          placeAttr: clean(cells[0]), placeName: clean(cells[1]),
          placeAddress: clean(cells[2]), placeId: m[1],
        });
      }
    });
    return out;
  };

  // 第 3 层：按场所 placeId 抓一页资质明细（明细在 tbody[1]）
  window.__natcma_fetchPlacePage = async function (placeId, applyId, pageNo, pageSize) {
    var fx = await passSlider();
    if (fx === null) throw new Error('formAbility 明细页滑块未通过');
    var fields = {
      pageNo: String(pageNo), pageSize: String(pageSize),
      placeId: placeId, applyId: applyId, applyOrgName: '',
      abilityParentName: '', abilityTypeName: '', abilityItemName: '',
      abilityStandardName: '', abilityStandardCode: '', placeAddressDetail: '',
      flag: '1', finalX: String(fx),
    };
    var body = Object.keys(fields).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(fields[k]);
    }).join('&');
    var html = await (await fetch(ctx + '/solr/tBzAbilitySearch/formAbility', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body })).text();
    var totalM = html.match(/共\\s*(\\d+)\\s*条/);
    var total = totalM ? parseInt(totalM[1], 10) : 0;
    var tb = firstTbody(html, 1);
    var rows = [];
    rowsOf(tb).forEach(function (tr) {
      var c = cellsOf(tr).map(clean);
      if (c.length >= 6) {
        rows.push({
          category: c[1], subCategory: c[2], testParam: c[3],
          stdName: c[4], stdCodeRaw: c[5], isFood: c[6] || '',
        });
      }
    });
    return { total: total, rows: rows };
  };
})();
`;


