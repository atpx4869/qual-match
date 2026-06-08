import { describe, it, expect } from 'vitest';
import { getDb, resetDbForTesting } from './db';
import { deleteLocalSourceData } from './scrape-service';
import { CmaScraper } from '../sources/prov-cma/cma-scraper';
import { CnasScraper, type CnasLabInfo } from '../sources/cnas/cnas-scraper';
import { SELF_ORG_ID } from '../shared/constants';

/**
 * 抓取器解析逻辑单测（不打网络）。用固定 HTML / URL 验证移植后的 cheerio 选择器、
 * parseUrl 正则仍有效。抓取链路本身（网络/playwright）走联网冒烟，不在单测覆盖。
 */

describe('CmaScraper 解析（固定 HTML）', () => {
  const s = new CmaScraper();

  it('parseSearchResults：从 #content 行抠 publicDetailId + 机构名', () => {
    const html = `
      <table id="content">
        <tr><th>序</th><th>机构</th><th>地区</th><th>大类</th><th>状态</th><th>操作</th></tr>
        <tr>
          <td>1</td><td>湖北省产品质量监督检验研究院</td><td>湖北</td><td>产品</td><td>有效</td>
          <td><a onclick="seeMore('ABC123')">查看</a></td>
        </tr>
      </table>`;
    const rows = s.parseSearchResults(html);
    expect(rows).toHaveLength(1);
    expect(rows[0].publicDetailId).toBe('ABC123');
    expect(rows[0].sysName).toBe('湖北省产品质量监督检验研究院');
    expect(rows[0].areaName).toBe('湖北');
  });

  it('parseCapabilities：定位能力大表，按列映射，暂无→空，非数字序号行跳过', () => {
    const html = `
      <table>
        <tr><td>序号</td><td>产品/项目编号</td><td>类别</td><td>产品/项目/参数</td><td>标准(方法)名称</td><td>标准号</td><td>限制范围</td></tr>
        <tr><td>1</td><td>P1</td><td>金属</td><td>甲醛释放量</td><td>金属家具</td><td>GB/T 3325-2024</td><td>无</td></tr>
        <tr><td>2</td><td>P2</td><td>食品</td><td>水分</td><td>食品水分</td><td>暂无</td><td>限</td></tr>
        <tr><td>合计</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
      </table>`;
    const caps = s.parseCapabilities(html, 'CERT001');
    expect(caps).toHaveLength(2);
    expect(caps[0].yjbzNumber).toBe('GB/T 3325-2024');
    expect(caps[0].cpName).toBe('甲醛释放量');
    expect(caps[0].parentName).toBe('金属');
    expect(caps[1].yjbzNumber).toBe('');   // 暂无 → 空
    expect(caps[0].jcnlId).toBe('CERT001-1');
  });
});

describe('CnasScraper.parseUrl（静态）', () => {
  it('从 CNAS 详情页 URL 解析 baseInfoId / labNo / 额外参数', () => {
    const url = 'https://las.cnas.org.cn/LAS/publish/orgBaseInfoScopePart.jsp?baseInfoId=BID9&licNo=L0290&id=ORG1&labType=L&orgEnOrCh=Ch';
    const info = CnasScraper.parseUrl(url);
    expect(info).not.toBeNull();
    const i = info as CnasLabInfo;
    expect(i.baseInfoId).toBe('BID9');
    expect(i.labNo).toBe('L0290');
    expect(i.urlParams.id).toBe('ORG1');
    expect(i.urlParams.labType).toBe('L');
  });

  it('缺 baseInfoId 或 licNo → null', () => {
    expect(CnasScraper.parseUrl('https://x.com/a.jsp?licNo=L1')).toBeNull();
    expect(CnasScraper.parseUrl('not a url')).toBeNull();
  });
});

describe('deleteLocalSourceData', () => {
  it('删除指定机构型源的本地明细和订阅占位', () => {
    resetDbForTesting();
    const db = getDb(':memory:');
    db.prepare(
      `INSERT INTO cnas_labs (lab_no, lab_name, source_ref, record_count, data_origin)
       VALUES (?, '本机构', 'L0290', 1, 'scraped')`,
    ).run(SELF_ORG_ID);
    db.prepare(
      `INSERT INTO cnas_qualifications
       (lab_no, std_code, std_code_norm, std_code_base, std_name)
       VALUES (?, 'GB 1-2020', 'GB1-2020', 'GB1', '测试')`,
    ).run(SELF_ORG_ID);

    const res = deleteLocalSourceData(db, 'cnas');
    expect(res).toEqual({ deletedRows: 1, deletedLab: true });
    expect((db.prepare('SELECT COUNT(*) AS c FROM cnas_qualifications').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM cnas_labs').get() as { c: number }).c).toBe(0);
  });
});
