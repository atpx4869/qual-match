// 内置 CNAS 资质订阅候选列表。移植自 bzxz src/services/preset-cnas-labs.ts。
//
// 数据来源于 CNAS 官网公开页面的 URL 参数（las.cnas.org.cn/.../orgBaseInfoScopePart.jsp）。
// qual-match 单一机构定位：这里的机构即「本机构」，抓取后入 cnas_qualifications（cert/lab 列用 SELF_ORG_ID）。
//
// 添加新内置项时，直接从对应机构的 CNAS 详情页 URL 复制参数即可。

export interface PresetCnasLab {
  /** 显示用机构名称 */
  labName: string;
  /** licNo / labNo（如 "L0290"） */
  labNo: string;
  /** URL 中的 baseInfoId */
  baseInfoId: string;
  /** URL 中的 certUpdateTs（认可状态更新日期，YYYY-MM-DD） */
  certUpdateTs?: string;
  /** URL 中的 validate（认可有效期，YYYY-MM-DD） */
  validate?: string;
  /** 其他 URL 参数（orgId / labType / scopeStr / attactdate 等）。注意键 "id" 是 orgId */
  urlParams?: Record<string, string>;
  /** 备注，可选，UI 显示 */
  note?: string;
}

export const PRESET_CNAS_LABS: PresetCnasLab[] = [
  {
    labName: '湖北省质检院',
    labNo: 'L0290',
    baseInfoId: 'd0afae34c5f6426b99d8704072763256',
    certUpdateTs: '2026-03-13',
    validate: '2029-10-30',
    urlParams: {
      id: '34e24dc0bb2b42528f676f3ac5fccf6d',
      baseInfoId: 'd0afae34c5f6426b99d8704072763256',
      labType: 'L',
      scopeStr: 'decideStd_abilityL1Engry_abilityL1_signPerson_keyBranch_',
      orgEnOrCh: 'Ch',
      licNo: 'L0290',
      certUpdateTs: '2026-03-13',
      validate: '2029-10-30',
      attactdate: '2026-03-13',
    },
    note: '湖北省产品质量监督检验研究院 (CNAS L0290)',
  },
];
