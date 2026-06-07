"""
国家 CMA 在线抓取——完整可行性验证脚本（2026-06-08 已打通）。

原阶段 5「止损」结论已翻案。关键突破：
  1. 滑块不是「拼图模板匹配」难题，而是缺口直检：对背景图缺口行带做垂直 Sobel
     边缘，找相距一个滑块宽(45px)的两条竖边，左边那条 = 缺口左缘 = moveX。
     实测 20/20 稳定，平均 1.1 次尝试。
  2. 验证态绑 session cookie，但 list / form 提交 body 还要再带 finalX=<moveX>。
  3. 三层下钻，每层各需过一次滑块：
       list(机构) -> form(场所+iframe) -> formAbility(资质明细，支持分页)
     实测「湖北省产品质量监督检验研究院」主场所共 3093 条明细。
  4. 资质按「场所」分：formAbility 返回页第 1 个 tbody 是场所表，每行操作列的
     hidden input 存该场所 placeId；「查看场所」= 用该 placeId 重新 POST formAbility。
     一个机构遍历所有场所，各自抓全量明细。

依赖：pip install requests opencv-python numpy
"""

from __future__ import annotations

import argparse
import base64
import re
import sys
import time
from html import unescape
from typing import Iterable
from urllib.parse import quote

import requests

try:
    import cv2
    import numpy as np
except Exception as exc:  # pragma: no cover
    raise SystemExit("缺少 opencv-python / numpy：pip install opencv-python numpy") from exc


BASE = "http://cma.cnca.cn/cma"
LIST_URL = f"{BASE}/solr/tBzAbilitySearch/list"
FORM_URL = f"{BASE}/solr/tBzAbilitySearch/form"
ABILITY_URL = f"{BASE}/solr/tBzAbilitySearch/formAbility"
CAPTCHA_URL = f"{BASE}/base/tBaRegistered/getSliderCaptcha"
VERIFY_URL = f"{BASE}/base/tBaRegistered/captchaVerify"

SLIDER_WIDTH = 45  # 滑块/缺口宽度，前端硬编码 300-45=255 上限
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
)


def make_session() -> requests.Session:
    session = requests.Session()
    session.headers.update({"User-Agent": UA, "Referer": LIST_URL})
    session.get(LIST_URL, timeout=30)  # 预热，拿 session cookie
    return session


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", value)).replace("\xa0", " ")).strip()


def gap_left_x(bg_bytes: bytes, y: int) -> int:
    """缺口直检：返回缺口左边缘 x（= 前端 moveX）。

    在缺口所在行带 (y .. y+45) 内，对灰度图做垂直 Sobel；缺口由相距一个滑块宽的
    两条竖直边缘围成，col[x]+col[x+44] 取最大处即缺口左缘。比模板匹配鲁棒得多。
    """
    bg = cv2.imdecode(np.frombuffer(bg_bytes, np.uint8), cv2.IMREAD_COLOR)
    gray = cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY)
    height, width = gray.shape
    top = max(0, min(y, height - SLIDER_WIDTH))
    band = gray[top : top + SLIDER_WIDTH].astype(np.float32)
    col = np.abs(cv2.Sobel(band, cv2.CV_32F, 1, 0, ksize=3)).sum(axis=0)
    best_score, best_x = -1.0, 0
    # 从 8 起跳，避开最左侧滑块起始区的固有竖边
    for x in range(8, width - SLIDER_WIDTH):
        score = float(col[x] + col[x + SLIDER_WIDTH - 1])
        if score > best_score:
            best_score, best_x = score, x
    return best_x


def pass_slider(session: requests.Session, max_tries: int = 8) -> int | None:
    """过一次滑块，返回成功的 moveX（用作后续请求的 finalX）；失败返回 None。"""
    xhr = {"X-Requested-With": "XMLHttpRequest"}
    for _ in range(max_tries):
        payload = session.get(CAPTCHA_URL, headers=xhr, timeout=30).json()
        move_x = gap_left_x(base64.b64decode(payload["bg"]), int(payload.get("y", 0)))
        result = session.post(VERIFY_URL, data={"moveX": str(move_x)}, headers=xhr, timeout=30).text.strip()
        if result == "success":
            return move_x
        time.sleep(0.5)
    return None


def search_orgs(session: requests.Session, org_name: str) -> list[dict]:
    """第 1 层：按机构名查 list，返回机构行（含 placeId/applyId）。"""
    final_x = pass_slider(session)
    if final_x is None:
        raise RuntimeError("list 步骤滑块未通过")
    fields = [
        ("pageNo", "1"), ("pageSize", "-1"),
        ("applyId", ""), ("placeId", ""), ("flag", ""),
        ("applyOrgName", quote(org_name.encode("utf-8"))),
        ("placeAddressDetail", ""), ("applyFieldCode", ""), ("applySectorBoard", ""),
        ("abilityParentName", ""), ("abilityTypeName", ""), ("abilityItemName", ""),
        ("abilityStandardName", ""), ("abilityStandardCode", ""), ("certCode", ""),
        ("finalX", str(final_x)),  # 关键：list 表单也要带 finalX
    ]
    body = "&".join(f"{k}={v}" for k, v in fields).encode("ascii")
    html = session.post(
        LIST_URL, data=body, timeout=40,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    ).text

    orgs: list[dict] = []
    tbody = re.search(r"<tbody>(.*?)</tbody>", html, re.S | re.I)
    if not tbody:
        return orgs
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", tbody.group(1), re.S | re.I):
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S | re.I)
        m = re.search(r'data-placeid="([^"]+)"\s+data-applyid="([^"]+)"', row)
        if len(cells) >= 3 and m:
            orgs.append({
                "certCode": clean_text(cells[1]),
                "orgName": clean_text(cells[2]),
                "address": clean_text(cells[3]) if len(cells) > 3 else "",
                "placeId": m.group(1),
                "applyId": m.group(2),
            })
    return orgs


def _parse_places(detail_html: str) -> list[dict]:
    """从 formAbility 返回页的场所表(tbody[0])解析每个场所及其 placeId。"""
    places: list[dict] = []
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", detail_html, re.S | re.I):
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S | re.I)
        m = re.search(r'<input[^>]+value="([0-9A-Fa-f]{20,})"[^>]+type="hidden"', row)
        if not m:
            m = re.search(r'<input[^>]+type="hidden"[^>]+value="([0-9A-Fa-f]{20,})"', row)
        if len(cells) >= 3 and m:
            places.append({
                "placeAttr": clean_text(cells[0]),   # 主场所/分场所
                "placeName": clean_text(cells[1]),
                "placeAddress": clean_text(cells[2]),
                "placeId": m.group(1),
            })
    return places


def fetch_place_abilities(session: requests.Session, place_id: str, apply_id: str,
                          page_size: int = 50, max_pages: int = 0) -> tuple[list[dict], int | None]:
    """抓单个场所(place_id)的资质明细（含分页）。max_pages=0 抓全量。
    返回 (明细行, 该场所总条数)。"""
    rows: list[dict] = []
    page_no, total = 1, None
    while True:
        final_x = pass_slider(session)
        if final_x is None:
            raise RuntimeError(f"formAbility place={place_id} 第 {page_no} 页滑块未通过")
        data = {
            "pageNo": str(page_no), "pageSize": str(page_size),
            "placeId": place_id, "applyId": apply_id, "applyOrgName": "",
            "abilityParentName": "", "abilityTypeName": "", "abilityItemName": "",
            "abilityStandardName": "", "abilityStandardCode": "", "placeAddressDetail": "",
            "flag": "1", "finalX": str(final_x),
        }
        html = session.post(
            ABILITY_URL, data=data, timeout=60,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        ).text
        if total is None:
            m = re.search(r"共\s*(\d+)\s*条", html)
            total = int(m.group(1)) if m else None

        # 明细在第二个 tbody（第一个是场所表）
        tbodies = re.findall(r"<tbody[^>]*>(.*?)</tbody>", html, re.S | re.I)
        detail = tbodies[1] if len(tbodies) >= 2 else (tbodies[0] if tbodies else "")
        page_rows = re.findall(r"<tr[^>]*>(.*?)</tr>", detail, re.S | re.I)
        if not page_rows:
            break
        for row in page_rows:
            cells = [clean_text(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S | re.I)]
            if len(cells) >= 6:
                rows.append({
                    "category": cells[1], "type": cells[2], "item": cells[3],
                    "stdName": cells[4],
                    # 末尾粘连「是否食品」列数字，交由项目 cleanStdCode 归一
                    "stdCodeRaw": cells[5],
                    "isFood": cells[6] if len(cells) > 6 else "",
                })
        if total is not None and len(rows) >= total:
            break
        if max_pages and page_no >= max_pages:
            break
        page_no += 1
        time.sleep(0.4)
    return rows, total


def list_places(session: requests.Session, place_id: str, apply_id: str) -> list[dict]:
    """先取一次 formAbility，从场所表解析该机构的所有场所。"""
    final_x = pass_slider(session)
    if final_x is None:
        raise RuntimeError("formAbility 场所表滑块未通过")
    params = {
        "placeId": place_id, "applyId": apply_id, "applyOrgName": "",
        "abilityParentName": "", "abilityTypeName": "", "abilityItemName": "",
        "abilityStandardName": "", "abilityStandardCode": "", "placeAddressDetail": "",
        "flag": "1", "finalX": str(final_x),
    }
    html = session.get(ABILITY_URL, params=params, timeout=60).text
    tbodies = re.findall(r"<tbody[^>]*>(.*?)</tbody>", html, re.S | re.I)
    return _parse_places(tbodies[0]) if tbodies else []


def fetch_org_all_places(session: requests.Session, org: dict,
                         page_size: int = 50, max_pages: int = 0) -> list[dict]:
    """抓一个机构下所有场所的资质明细，每条明细带场所信息。"""
    places = list_places(session, org["placeId"], org["applyId"])
    print(f"    机构有 {len(places)} 个场所")
    all_rows: list[dict] = []
    for p in places:
        rows, total = fetch_place_abilities(
            session, p["placeId"], org["applyId"], page_size=page_size, max_pages=max_pages,
        )
        print(f"    - [{p['placeAttr']}] {p['placeName']}: 共{total}条, 抓到{len(rows)}条")
        for r in rows:
            r["placeName"] = p["placeName"]
            r["placeAddress"] = p["placeAddress"]
            all_rows.append(r)
        time.sleep(0.3)
    return all_rows



def print_rows(rows: Iterable[dict], limit: int) -> None:
    for i, r in enumerate(rows):
        if i >= limit:
            break
        place = r.get("placeName", "")[:18]
        print(f"  - [{place}] {r['item']} | {r['stdName'][:24]} | {r['stdCodeRaw']}")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="国家 CMA 在线抓取（已打通）")
    parser.add_argument("--org", default="湖北省产品质量监督检验研究院", help="机构名称")
    parser.add_argument("--max-pages", type=int, default=1, help="最多抓几页明细(0=全量)")
    parser.add_argument("--page-size", type=int, default=50)
    parser.add_argument("--limit", type=int, default=8, help="打印前 N 条")
    parser.add_argument("--self-test", action="store_true", help="只测滑块稳定性")
    args = parser.parse_args(argv)

    session = make_session()

    if args.self_test:
        ok = sum(1 for _ in range(20) if pass_slider(session) is not None)
        print(f"[滑块] 稳定性 {ok}/20")
        return 0

    print(f"[1] 查机构：{args.org}")
    orgs = search_orgs(session, args.org)
    print(f"    命中 {len(orgs)} 个机构")
    for o in orgs[:3]:
        print(f"    - {o['certCode']} | {o['orgName']} | {o['address']}")
    if not orgs:
        return 1

    org = orgs[0]
    print(f"[2/3] 抓机构所有场所资质明细 placeId={org['placeId']}")
    rows = fetch_org_all_places(session, org, page_size=args.page_size, max_pages=args.max_pages)
    print(f"    合计 {len(rows)} 条明细")
    print_rows(rows, args.limit)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
