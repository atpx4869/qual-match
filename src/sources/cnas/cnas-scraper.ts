import type { Browser, Page } from 'playwright';

/**
 * CNAS 抓取器（playwright）。移植自 bzxz src/services/cnas-scraper.ts。
 *
 * 为何必须 playwright：CNAS 站点（las.cnas.org.cn）有 JSL（加速乐）JS 反爬挑战，
 * 直接 HTTP 拿到的是混淆 JS 页，需在真实浏览器执行才能拿到有效 cookie。拿到 cookie 后，
 * 能力数据靠**页内 page.evaluate fetch 同源请求**取 JSON（自动带 JSL cookie）。
 *
 * 移植改动：
 *   - launch 去掉 channel:'chrome'，用 playwright 自带 chromium（首次需 npx playwright install chromium）。
 *   - 删 checkForUpdate / fetchLabInfo（查新，单用户不需要）。
 *   - 无验证码、不依赖 captcha-ocr。
 *
 * 浏览器退路：若设了环境变量 CNAS_CHROME_PATH，则用它作 executablePath（指向现成
 * chrome / chrome-headless-shell），免去 playwright 下载匹配版本浏览器。用于下载受限的环境。
 */

const CNAS_BASE = 'https://las.cnas.org.cn/LAS/publish';

/** 抓取运行参数（来自 settings，全可选，缺省时与改造前行为一致）。 */
export interface CnasScrapeOpts {
  /** 浏览器 executablePath，仅首次 launch 生效。 */
  chromePath?: string;
  /** 翻页节流下限（ms），实际等待 = throttleMs + random(0~2000)。默认 1500。 */
  throttleMs?: number;
}

export interface CnasCapability {
  num: number;
  objCh: string;
  paramNum: number;
  paramCh: string;
  paramEn: string;
  stdDescAndClause: string;
  stdDescAndClauseEn: string;
  stdCode: string;
  stdCodeEn: string;
  stdAllDesc: string;
  stdAllDescEn: string;
  limitCh: string;
  limitEn: string;
  stdStatus: number;
  bigTypeName: string;
  bigTypeNameE: string;
  typeName: string;
  typeNameE: string;
  startDate: string;
  branchId: string;
  objId: string;
  paramId: string;
  objStdId: string;
}

interface CnasApiResponse {
  totalSize: number;
  startIndex: number;
  sizePerPage: number;
  data: CnasCapability[];
}

export interface CnasLabInfo {
  baseInfoId: string;
  labNo: string;
  labName: string;
  certUpdateTs: string;
  validate: string;
  /** CNAS 站点要求的额外 URL 参数（id / labType / scopeStr / orgEnOrCh 等） */
  urlParams: Record<string, string>;
}

export interface CnasOrgInfo {
  regNo: string;
  otherNames: string;
  address: string;
  validityPeriod: string;
  certTasks: CnasCertTask[];
}

export interface CnasCertTask {
  taskNo: string;
  reviewType: string;
  signDate: string;
  scopeStatus: string;
}

export class CnasScraper {
  /** 共享 headless Chromium。每个抓取任务独立 context + page，互不干扰。 */
  private browser: Browser | null = null;
  private browserLaunch: Promise<Browser> | null = null;

  /** 并发上限，避免触发 CNAS 反爬。 */
  private maxConcurrent = 3;
  private activePages = 0;
  private waiters: Array<() => void> = [];

  /** 启动（或返回）共享 Chromium。并发去重。
   *  chromePath 优先用传入值（来自 settings），否则回退环境变量。仅首次 launch 生效。 */
  private async ensureBrowser(chromePath?: string): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (!this.browserLaunch) {
      this.browserLaunch = (async () => {
        const pw = await import('playwright');
        const execPath = chromePath?.trim() || process.env.CNAS_CHROME_PATH?.trim();
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

  /** 取一个并发 slot；满了就等。 */
  private async acquireSlot(): Promise<void> {
    if (this.activePages < this.maxConcurrent) { this.activePages++; return; }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.activePages++;
  }

  private releaseSlot(): void {
    this.activePages = Math.max(0, this.activePages - 1);
    const w = this.waiters.shift();
    if (w) w();
  }

  /** 开一个独立 page（独立 context）。调用方必须在 finally 里 release()。 */
  private async openPage(chromePath?: string): Promise<{ page: Page; release: () => Promise<void> }> {
    await this.acquireSlot();
    let context: import('playwright').BrowserContext | null = null;
    try {
      const browser = await this.ensureBrowser(chromePath);
      context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      });
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });
      const page = await context.newPage();
      const ownedContext = context;
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        try { await ownedContext.close(); } catch { /* best effort */ }
        this.releaseSlot();
      };
      return { page, release };
    } catch (err) {
      if (context) await context.close().catch(() => {});
      this.releaseSlot();
      throw err;
    }
  }

  /** 关闭共享浏览器（app shutdown 时调）。 */
  async close(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    this.browserLaunch = null;
    if (b) await b.close().catch(() => {});
  }

  /** 导航到 lab 页并等反爬挑战结算。 */
  private async navigateToLab(page: Page, labInfo: CnasLabInfo): Promise<void> {
    const params = new URLSearchParams({
      baseInfoId: labInfo.baseInfoId,
      licNo: labInfo.labNo,
      ...labInfo.urlParams,
    });
    const labUrl = `${CNAS_BASE}/orgBaseInfoScopePart.jsp?${params}`;
    await page.goto(labUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

    const title = await page.title();
    if (!title || title.includes('__jsl')) {
      throw new Error('CNAS anti-bot challenge not resolved');
    }
  }

  /** 取机构名。 */
  async fetchLabName(labInfo: CnasLabInfo): Promise<string> {
    const { page, release } = await this.openPage();
    try {
      await this.navigateToLab(page, labInfo);
      return await page.evaluate(() => {
        const el = document.querySelector('.orgName, .lab-name, h2, h3, .title');
        if (el) return el.textContent?.trim() ?? '';
        const t = document.title;
        if (t && !t.includes('__jsl')) return t;
        return '';
      });
    } catch {
      return '';
    } finally {
      await release();
    }
  }

  /** 取机构信息（注册编号/地址/有效期/认可任务）。 */
  async fetchOrgInfo(labInfo: CnasLabInfo): Promise<CnasOrgInfo> {
    const orgId = labInfo.urlParams?.id;
    if (!orgId) return { regNo: labInfo.labNo, otherNames: '', address: '', validityPeriod: '', certTasks: [] };

    const { page, release } = await this.openPage();
    try {
      const orgUrl = `${CNAS_BASE}/queryOrgInfo.action?id=${orgId}&orgEnOrCh=Ch`;
      await page.goto(orgUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(5000);

      const title = await page.title();
      if (!title || title.includes('__jsl')) {
        throw new Error('CNAS anti-bot challenge not resolved on org info page');
      }

      return await page.evaluate(() => {
        const getText = (el: Element | null) => el?.textContent?.trim() ?? '';

        const findValue = (labelText: string): string => {
          const tds = Array.from(document.querySelectorAll('td'));
          for (let i = 0; i < tds.length - 1; i++) {
            if (getText(tds[i]).includes(labelText)) return getText(tds[i + 1]);
          }
          return '';
        };

        const certTasks: Array<{ taskNo: string; reviewType: string; signDate: string; scopeStatus: string }> = [];
        const tables = Array.from(document.querySelectorAll('table'));
        for (const table of tables) {
          const headers = Array.from(table.querySelectorAll('th, td')).map(getText);
          const taskNoIdx = headers.findIndex((h) => h.includes('任务编号'));
          const reviewIdx = headers.findIndex((h) => h.includes('评审类型'));
          const signIdx = headers.findIndex((h) => h.includes('签发日期'));
          const statusIdx = headers.findIndex((h) => h.includes('公布状态'));
          if (taskNoIdx < 0) continue;
          const rows = Array.from(table.querySelectorAll('tr')).slice(1);
          for (const row of rows) {
            const cells = Array.from(row.querySelectorAll('td'));
            if (cells.length <= taskNoIdx) continue;
            certTasks.push({
              taskNo: getText(cells[taskNoIdx]),
              reviewType: reviewIdx >= 0 && cells[reviewIdx] ? getText(cells[reviewIdx]) : '',
              signDate: signIdx >= 0 && cells[signIdx] ? getText(cells[signIdx]) : '',
              scopeStatus: statusIdx >= 0 && cells[statusIdx] ? getText(cells[statusIdx]) : '',
            });
          }
          if (certTasks.length) break;
        }

        return {
          regNo: findValue('注册编号'),
          otherNames: findValue('其他名称'),
          address: findValue('单位地址') || findValue('地址'),
          validityPeriod: findValue('认可有效期限') || findValue('有效期'),
          certTasks,
        };
      });
    } finally {
      await release();
    }
  }

  /** 取一页能力数据，反爬触发返回 null。 */
  private async fetchPage(
    page: Page,
    baseinfoId: string,
    start: number,
    pageSize: number,
  ): Promise<CnasApiResponse | null> {
    const result = await page.evaluate(async (params: { baseinfoId: string; start: number; pageSize: number }) => {
      try {
        const body = new URLSearchParams({
          baseinfoId: params.baseinfoId,
          type: 'L1',
          enstart: '0',
          startIndex: String(params.start),
          sizePerPage: String(params.pageSize),
        });
        const resp = await fetch('/LAS/publish/queryPublishLCheckObj.action?', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });
        const text = await resp.text();
        if (text.startsWith('{') || text.startsWith('[')) {
          return { ok: true, text };
        }
        return { ok: false, error: `Non-JSON response (${resp.status}): ${text.substring(0, 100)}` };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }, { baseinfoId, start, pageSize });

    if (!result.ok) {
      console.log(`fetchPage failed: ${result.error}`);
      return null;
    }
    try {
      return JSON.parse(result.text!) as CnasApiResponse;
    } catch {
      return null;
    }
  }

  /** 抓单个实验室全部能力行。 */
  async fetchCapabilities(
    labInfo: CnasLabInfo,
    onProgress?: (fetched: number, total: number) => void,
    opts?: CnasScrapeOpts,
  ): Promise<CnasCapability[]> {
    const { page, release } = await this.openPage(opts?.chromePath);
    const throttleMs = opts?.throttleMs ?? 1500;

    const all: CnasCapability[] = [];
    let start = 0;
    const pageSize = 200;
    let total = Infinity;
    const maxRetries = 5;
    let requestCount = 0;

    try {
      await this.navigateToLab(page, labInfo);
      while (all.length < total) {
        let json: CnasApiResponse | null = null;
        let retries = 0;

        while (!json && retries < maxRetries) {
          json = await this.fetchPage(page, labInfo.baseInfoId, start, pageSize);
          if (!json) {
            retries++;
            requestCount = 0;
            const waitSec = 15 + retries * 20;
            console.log(`CNAS anti-bot at offset ${start}, waiting ${waitSec}s then re-navigating (retry ${retries}/${maxRetries})...`);
            await sleep(waitSec * 1000);
            await this.navigateToLab(page, labInfo);
          }
        }

        if (!json) throw new Error(`CNAS fetch failed at offset ${start} after ${maxRetries} retries`);

        total = json.totalSize;
        const records = json.data ?? [];
        if (records.length === 0) break;

        all.push(...records);
        onProgress?.(all.length, total);
        start += pageSize;
        requestCount++;

        if (requestCount >= 8 && start < total) {
          console.log(`Proactive re-navigation after ${requestCount} requests...`);
          await sleep(5000);
          await this.navigateToLab(page, labInfo);
          requestCount = 0;
          await sleep(3000 + Math.random() * 2000);
        } else if (start < total) {
          await sleep(throttleMs + Math.random() * 2000);
        }
      }
    } finally {
      await release();
    }

    return all;
  }

  /** 从 CNAS 详情页 URL 解析出 labInfo。 */
  static parseUrl(url: string): CnasLabInfo | null {
    try {
      const u = new URL(url);
      const params = u.searchParams;
      const baseInfoId = params.get('baseInfoId');
      const licNo = params.get('licNo');
      if (!baseInfoId || !licNo) return null;

      const extraKeys = ['id', 'labType', 'scopeStr', 'orgEnOrCh', 'attactdate'];
      const urlParams: Record<string, string> = {};
      for (const key of extraKeys) {
        const val = params.get(key);
        if (val) urlParams[key] = val;
      }

      return {
        baseInfoId,
        labNo: licNo,
        labName: '',
        certUpdateTs: params.get('certUpdateTs') ?? '',
        validate: params.get('validate') ?? '',
        urlParams,
      };
    } catch {
      return null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
