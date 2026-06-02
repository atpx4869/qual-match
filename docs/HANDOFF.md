# qual-match 开发交接 / 续接指南

> **下次继续开发先读这份。** 它让你（或新的开发会话）快速恢复上下文、跑起项目、接着干。
> 单一真相源是 [`DESIGN.md`](DESIGN.md)（完整设计 6 节）；本文件是「当前到哪了 + 怎么接着走」。
> 最后更新：2026-06-02（阶段 1 完成）。

---

## 一、项目是什么

`qual-match`：某检测机构的「资质自查」工具。导入一份标准清单（Excel），查清单里的标准
**本机构能做哪些、不能做哪些** —— 即每个标准是否被本机构的资质（省级 CMA / CNAS /
国家 CMA / 一单一库）覆盖。**仅 Web，无桌面客户端。** 是 bzxz 资质模块的独立缩小版。

**⚠️ 单一机构定位**（贯穿全项目，别做成跨机构对比）：导入的资质全部视作「本机构持有」，
用固定占位标识 `SELF_ORG_ID='_self'` 承载在明细表 cert_number/lab_no 列。匹配结果回答
「本机构某类资质有没有这个标准」（✓有/—无/~仅其他年版），**不是**「哪些机构能做」。

---

## 二、当前进度（按 DESIGN §6.1 路线图）

| 阶段 | 状态 | 内容 |
|------|------|------|
| 0 脚手架 | ✅ 完成 | 前后端骨架 + shared 共享层 + 12 表建库 + health |
| 1 主链路 | ✅ 完成 | 导入资质/清单 → 匹配 → 导出，**已可用** |
| **2 综合查询** | ⏭ **下一步** | 独立于清单，对本地资质库做关键词/标准号查询 |
| 3 一单一库同步 | 待做 | 移植 bzxz cap-lib（最低风险抓取源）+ 5 档比对状态 |
| 4 省级CMA+CNAS抓取 | 待做 | 移植 bzxz cma-scraper / cnas-scraper |
| 5 国家CMA | 待做 | 滑块破解**已止损**→走 Excel 导入降级（见 DESIGN §3.5 / poc/） |
| 6 打磨 | 待做 | 设置页、错误提示、部署说明 |

---

## 三、怎么跑起来

```bash
# 首次：装依赖
npm install                 # 后端（better-sqlite3 原生编译，需 Node ≥20）
npm --prefix web install    # 前端

# 日常开发：两个终端
npm run dev                 # 后端，固定 3000（前端 proxy 写死指向它）
npm run web:dev             # 前端，5173，/api 经 Vite proxy 转发到 3000
# 浏览器开 http://localhost:5173

# 验证
npm test                    # 后端单测（vitest，23 个）
npm run web:typecheck       # 前端类型检查
npx tsc -p tsconfig.json --noEmit   # 后端类型检查
```

> ⚠️ **tsx 子进程在 Windows 下 Ctrl-C/kill 可能杀不净**，残留占用 3000。重启前若报端口占用：
> `netstat -ano | grep ":3000.*LISTENING"` 找 PID → `taskkill //F //PID <pid>`。

测试数据生成：`node poc/gen_test_xlsx.cjs <输出目录>` 生成资质明细 + 清单 Excel 各一份。

---

## 四、代码地图

```
src/                        后端（CommonJS，tsx 跑 / tsc 编译）
├── shared/                 共享层（多数从 bzxz 零改移植）
│   ├── std-code.ts         ★ 三层归一化地基 cleanStdCode/extractFullCode/extractBaseCode
│   ├── constants.ts        ★ SELF_ORG_ID + ORG_SOURCES + ORG_SOURCE_TABLE（源→表名映射）
│   ├── response.ts         Result 壳 ok/err/respond/respondError
│   ├── errors.ts           AppError + 子类 + normalizeError
│   ├── case.ts             toCamelCase/toSnakeCase
│   ├── http.ts             undici 连接池 pooledFetch（阶段4/5抓取用）
│   ├── fs.ts               getRootDir/ensureDataDirs
│   └── env-loader.ts       loadDotEnvLocal（凭据走 .env.local）
├── services/
│   ├── db.ts               ★ 12 表 schema + 三层归一列 + STD_CODE_ALGO_VERSION 回填 + 11领域种子
│   ├── import-service.ts   parseExcelBuffer + importWatchlist + importQualifications
│   ├── match-service.ts    ★ matchWatchlist 批量IN查询，保年优先剥年兜底
│   ├── match-service.test.ts
│   └── export-service.ts   exportMatchResult → xlsx buffer
├── api/
│   ├── app.ts              Express 装配 + 全局错误中间件（4参!）+ SPA fallback + multer错误
│   ├── health-routes.ts    GET /api/health
│   ├── watchlist-routes.ts 清单：创建/列表/详情/删除/match/export
│   └── import-routes.ts    POST /api/import/qualifications
└── index.ts                启动入口

web/src/                    前端（Vue3 + Vite + Element Plus，ESM）
├── api/client.ts           ★ fetch 封装解 Result 壳 + apiDownload
├── api/watchlist.ts        类型(MatchResult等) + API 函数
├── pages/MatchPage.vue     ★ 清单匹配主页（已实做）
├── pages/PlaceholderPage.vue  综合查询/资质管理/设置占位（阶段2/3起替换）
├── components/CoverageTag.vue / QualImportDialog.vue
├── App.vue / router.ts / main.ts
```

★ = 关键文件。

---

## 五、必守的工程约定（改代码前看）

1. **std_code 三层归一化契约**：任何资质/清单 INSERT 都要
   `cleanStdCode(raw) → std_code_norm=extractFullCode → std_code_base=extractBaseCode`。
   单一真相源 `shared/std-code.ts`。**改这三个函数后必须 +1 `db.ts` 的 `STD_CODE_ALGO_VERSION`**
   （启动时全量回填），新 case 加进 `std-code.test.ts`。
2. **保年优先、剥年兜底**：主匹配走 `std_code_norm`（同号同年才算覆盖）；`std_code_base`
   仅作跨年提示（seriesHint），**不能当覆盖**。同号不同年是不同资质。
3. **Result 壳 + 命名边界**：API 出口 `respond/respondError`，DB snake_case ↔ API camelCase
   （`toCamelCase`），请求体 zod camelCase。
4. **凭据走 `.env.local`**（gitignored），键名 `<SOURCE>_USERNAME/_PASSWORD`，绝不写进代码。
5. **Express 5 两个坑**：错误中间件必须 4 参 `(err,_req,res,_next)`；SPA fallback 不能用裸
   `app.get('*')`，用无路径 `app.use` 兜底（已在 app.ts 处理）。
6. **入库大批量走分块事务**（每 ~2000 行，批次间 setImmediate），防 better-sqlite3 同步事务
   锁死事件循环（阶段 3/4 抓取入库时注意）。

---

## 六、下一步：阶段 2 综合查询

**目标**（DESIGN §4.2）：独立于清单，直接对本地资质库做关键词/标准号查询。

**要做**：
- 新写 `src/services/qualification-service.ts`：
  - 行级搜索：关键词命中标准号/标准名/检测项目，跨 3 个机构型源 UNION，分页
  - 按标准号聚合：同号下全部资质行聚合成一组
  - 带年/不带年分流：输入带 4 位年份 → 严格保年；不带年 → 保年+剥年双路径
  - 源过滤：可只查某一类
- 新写 `src/api/qualification-routes.ts`：`GET /api/qualifications/search`、`by-standard`，挂进 app.ts
- 前端：把 `pages/PlaceholderPage`（/search 路由）换成实做的 `SearchPage.vue`
- 参照 bzxz `searchQualifications` / `searchByStandard`（在 bzxz src/services 下）

**注意**：阶段 2 仍只查 3 个机构型源（一单一库 cap_lib 是空表，阶段 3 才同步）。

---

## 七、踩过的坑（避免重犯）

- **粘贴标准号 split 不能含 `\s`**：会把 `GB/T 3325-2024` 拆开。用 `/[\r\n,，;；\t]+/`。
- **curl `-F` 传中文 multipart 字段在 Windows 乱码**（本地代码页非 UTF-8）；前端 FormData 传中文
  是对的。**验证中文务必走真实 UI 或读 xlsx 内容，别信 curl/终端显示。**
- **playwright MCP 的 browser_click 传 `target` 参数**（不是 ref）；el-radio-button 的 input 被
  label 遮挡，点 label 文字。
- **tsx 子进程 Windows 杀不净**（见上文端口清理）。

---

## 八、参考

- `DESIGN.md` —— 完整设计（架构/数据模型/数据源/匹配引擎/前端/路线图），单一真相源
- `README.md` —— 项目总览 + 起步
- `poc/` —— 国家 CMA 滑块破解 PoC（已止损，结论见 DESIGN §3.5；`gen_test_xlsx.cjs` 可生成测试数据）
- bzxz 项目（`../bzxz`）—— 移植来源，阶段 3/4 抓取器在其 `src/services` 下
