/**
 * 跨服务共享的常量。
 *
 * 单一机构定位（DESIGN §1.1）：本工具服务「本机构自查」，导入的资质明细全部视作本机构持有，
 * 用固定占位标识 SELF_ORG_ID 承载在明细表的 cert_number / lab_no 列上，结构不变。
 */

/** 本机构占位标识。导入/手填的资质行的机构外键列统一用它。 */
export const SELF_ORG_ID = '_self';

/** 机构型资质源（阶段 1 匹配引擎覆盖这三类；一单一库 cap_lib 阶段 3 接入）。 */
export const ORG_SOURCES = ['prov_cma', 'cnas', 'nat_cma'] as const;
export type OrgSource = (typeof ORG_SOURCES)[number];

/** 全部资质源（含能力库）。 */
export const ALL_SOURCES = ['prov_cma', 'cnas', 'nat_cma', 'cap_lib'] as const;
export type Source = (typeof ALL_SOURCES)[number];

/** 各机构型源的明细表名 + 机构外键列名。匹配引擎与导入服务共用。 */
export const ORG_SOURCE_TABLE: Record<OrgSource, { qualTable: string; labTable: string; orgCol: string; label: string }> = {
  prov_cma: { qualTable: 'prov_cma_qualifications', labTable: 'prov_cma_labs', orgCol: 'cert_number', label: '省级 CMA' },
  cnas:     { qualTable: 'cnas_qualifications',     labTable: 'cnas_labs',     orgCol: 'lab_no',      label: 'CNAS' },
  nat_cma:  { qualTable: 'nat_cma_qualifications',  labTable: 'nat_cma_labs',  orgCol: 'cert_number', label: '国家 CMA' },
};

export function isOrgSource(s: string): s is OrgSource {
  return (ORG_SOURCES as readonly string[]).includes(s);
}
