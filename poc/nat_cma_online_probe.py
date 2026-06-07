"""
国家 CMA 在线抓取复探脚本（实验性）。

用途：
  1. 验证 http://cma.cnca.cn/cma 的滑块验证码是否还能自动通过。
  2. 复刻 searchCondition / list 两个老式表单入口，观察它们是否返回可解析数据。

结论提示：
  当前入口更像“按能力条件反查机构”，不是“按证书号导出某机构全部能力明细”。
  因此这个脚本只作为复探/取证工具，不接入生产同步主线。

依赖：
  pip install requests ddddocr
"""

from __future__ import annotations

import argparse
import base64
import re
import sys
import time
from dataclasses import dataclass
from html import unescape
from typing import Iterable

import requests

try:
    import ddddocr
except Exception as exc:  # pragma: no cover - 只给人工运行时友好提示
    raise SystemExit("缺少 ddddocr：请先 pip install ddddocr") from exc

try:
    import cv2
    import numpy as np
except Exception:  # pragma: no cover - cv2 只用于提高滑块命中率
    cv2 = None
    np = None


BASE = "http://cma.cnca.cn/cma"
LIST_URL = f"{BASE}/solr/tBzAbilitySearch/list"
CONDITION_URL = f"{BASE}/solr/tBzAbilitySearch/searchCondition?flag=1"
CAPTCHA_URL = f"{BASE}/base/tBaRegistered/getSliderCaptcha"
VERIFY_URL = f"{BASE}/base/tBaRegistered/captchaVerify"
SLIDER_WIDTH = 45


@dataclass
class ListRow:
    cert_code: str
    org_name: str
    address: str
    contact: str
    phone: str
    action_html: str


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", unescape(value).replace("\xa0", " ")).strip()


def strip_tags(value: str) -> str:
    return clean_text(re.sub(r"<[^>]+>", " ", value))


def make_session() -> requests.Session:
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
            ),
            "Referer": LIST_URL,
        }
    )
    return session


def parse_total(html: str) -> int | None:
    match = re.search(r"共\s*(\d+)\s*条", html)
    return int(match.group(1)) if match else None


def parse_condition_options(html: str) -> list[str]:
    out: list[str] = []
    for row_html in re.findall(r"<tr[^>]*>(.*?)</tr>", html, flags=re.S | re.I):
        if "download" not in row_html and "确认选择" not in row_html:
            continue
        span = re.search(r"<span[^>]*>(.*?)</span>", row_html, flags=re.S | re.I)
        text = strip_tags(span.group(1) if span else row_html)
        if text and text not in out:
            out.append(text)
    return out


def parse_list_rows(html: str) -> list[ListRow]:
    tbody_match = re.search(r"<tbody>(.*?)</tbody>", html, flags=re.S | re.I)
    if not tbody_match:
        return []

    rows: list[ListRow] = []
    for row_html in re.findall(r"<tr[^>]*>(.*?)</tr>", tbody_match.group(1), flags=re.S | re.I):
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row_html, flags=re.S | re.I)
        if len(cells) < 7:
            continue
        rows.append(
            ListRow(
                cert_code=strip_tags(cells[1]),
                org_name=strip_tags(cells[2]),
                address=strip_tags(cells[3]),
                contact=strip_tags(cells[4]),
                phone=strip_tags(cells[5]),
                action_html=clean_text(cells[6]),
            )
        )
    return rows


def post_list(session: requests.Session, **fields: str) -> str:
    data = {
        "pageNo": fields.get("pageNo", "1"),
        "pageSize": fields.get("pageSize", "10"),
        "applyId": "",
        "placeId": "",
        "flag": "",
        "applyOrgName": fields.get("applyOrgName", ""),
        "placeAddressDetail": "",
        "applyFieldCode": "",
        "applySectorBoard": "",
        "abilityParentName": fields.get("abilityParentName", ""),
        "abilityTypeName": fields.get("abilityTypeName", ""),
        "abilityItemName": fields.get("abilityItemName", ""),
        "abilityStandardName": fields.get("abilityStandardName", ""),
        "abilityStandardCode": fields.get("abilityStandardCode", ""),
        "certCode": fields.get("certCode", ""),
    }
    resp = session.post(LIST_URL, data=data, timeout=40)
    resp.raise_for_status()
    return resp.text


def post_condition(
    session: requests.Session,
    index: int,
    keyword: str,
    *,
    parent: str = "",
    ability_type: str = "",
    item: str = "",
    standard_name: str = "",
) -> str:
    data = {
        "pageNo": "1",
        "pageSize": "10",
        "index": str(index),
        "placeId": "",
        "parentName": parent,
        "abilityParentName": keyword if index == 1 else parent,
        "abilityTypeName": keyword if index == 2 else ability_type,
        "abilityItemName": keyword if index == 3 else item,
        "abilityStandardName": keyword if index == 4 else standard_name,
        "abilityStandardCode": keyword if index == 5 else "",
    }
    resp = session.post(CONDITION_URL, data=data, timeout=40)
    resp.raise_for_status()
    return resp.text


def solve_slider(session: requests.Session, max_tries: int) -> bool:
    ocr = ddddocr.DdddOcr(det=False, ocr=False, show_ad=False)
    session.get(LIST_URL, timeout=30)
    for attempt in range(1, max_tries + 1):
        captcha_resp = session.get(CAPTCHA_URL, timeout=30)
        captcha_resp.raise_for_status()
        payload = captcha_resp.json()
        slider = base64.b64decode(payload["slider"])
        bg = base64.b64decode(payload["bg"])
        match = ocr.slide_match(slider, bg, simple_target=True)
        candidates = slider_candidates(bg, slider, int(payload.get("y", 0)), int(match["target"][0]))
        for move_x in candidates[:5]:
            verify_resp = session.post(VERIFY_URL, data={"moveX": str(move_x)}, timeout=30)
            result = verify_resp.text.strip()
            print(f"[captcha] try={attempt} moveX={move_x} result={result!r}")
            if result == "success":
                return True
        time.sleep(0.6)
    return False


def slider_candidates(bg_bytes: bytes, slider_bytes: bytes, y: int, ocr_x: int) -> list[int]:
    raw = [ocr_x, ocr_x - 1, ocr_x + 1, ocr_x - 2, ocr_x + 2]
    if cv2 is not None and np is not None:
        try:
            bg = cv2.imdecode(np.frombuffer(bg_bytes, np.uint8), cv2.IMREAD_COLOR)
            slider = cv2.imdecode(np.frombuffer(slider_bytes, np.uint8), cv2.IMREAD_UNCHANGED)
            raw.extend([detect_gap_ncc(bg, slider, y), detect_dark_band(bg)])
        except Exception:
            pass

    out: list[int] = []
    for x in raw:
        clamped = max(0, min(255, int(x)))
        if clamped not in out:
            out.append(clamped)
    return out


def detect_gap_ncc(bg, slider, y: int) -> int:
    gray_bg = cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY).astype(np.float32)
    gray_slider = cv2.cvtColor(slider[:, :, :3], cv2.COLOR_BGR2GRAY).astype(np.float32)
    height, width = gray_bg.shape
    top = max(0, min(y, height - SLIDER_WIDTH))
    tpl = gray_slider
    tpl_z = tpl - tpl.mean()
    tpl_norm = np.sqrt((tpl_z**2).sum()) + 1e-6
    best_score = -2.0
    best_x = SLIDER_WIDTH
    band = gray_bg[top : top + SLIDER_WIDTH]
    for x in range(SLIDER_WIDTH, width - SLIDER_WIDTH + 1):
        win = band[:, x : x + SLIDER_WIDTH]
        win_z = win - win.mean()
        score = (win_z * tpl_z).sum() / (np.sqrt((win_z**2).sum()) + 1e-6) / tpl_norm
        if score > best_score:
            best_score = float(score)
            best_x = x
    return best_x


def detect_dark_band(bg) -> int:
    gray = cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY)
    col_mean = gray.mean(axis=0).astype(float)
    window = np.convolve(col_mean, np.ones(SLIDER_WIDTH) / SLIDER_WIDTH, mode="valid")
    window[:SLIDER_WIDTH] = 1e9
    return int(np.argmin(window))


def print_rows(rows: Iterable[ListRow], limit: int) -> None:
    for idx, row in enumerate(rows):
        if idx >= limit:
            break
        print(f"  - {row.cert_code} | {row.org_name} | {row.address}")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="国家 CMA 在线入口复探（实验性）")
    parser.add_argument("--cert", default="230020349767", help="用于 list 表单的证书号")
    parser.add_argument("--parent-keyword", default="家具", help="searchCondition 大类关键词")
    parser.add_argument("--ability-item", default="", help="可选：直接按产品/项目/参数查询 list")
    parser.add_argument("--standard-code", default="", help="可选：直接按标准编号查询 list")
    parser.add_argument("--verify-slider", action="store_true", help="先尝试自动通过滑块")
    parser.add_argument("--max-captcha-tries", type=int, default=8)
    parser.add_argument("--limit", type=int, default=5)
    args = parser.parse_args(argv)

    session = make_session()

    if args.verify_slider:
        ok = solve_slider(session, args.max_captcha_tries)
        print(f"[captcha] verified={ok}")

    print(f"[list] certCode={args.cert!r}")
    try:
        cert_html = post_list(session, certCode=args.cert)
    except requests.HTTPError as exc:
        print(f"[list] cert query failed: HTTP {exc.response.status_code}")
    else:
        cert_rows = parse_list_rows(cert_html)
        print(f"[list] total={parse_total(cert_html)} rows={len(cert_rows)}")
        print_rows(cert_rows, args.limit)

    print(f"[condition] index=1 keyword={args.parent_keyword!r}")
    try:
        cond_html = post_condition(session, 1, args.parent_keyword)
    except requests.HTTPError as exc:
        print(f"[condition] failed: HTTP {exc.response.status_code}")
    else:
        options = parse_condition_options(cond_html)
        print(f"[condition] total={parse_total(cond_html)} options={len(options)}")
        for item in options[: args.limit]:
            print(f"  - {item}")

    if args.ability_item or args.standard_code:
        print("[list] ability criteria")
        html = post_list(
            session,
            abilityItemName=args.ability_item,
            abilityStandardCode=args.standard_code,
        )
        rows = parse_list_rows(html)
        print(f"[list] total={parse_total(html)} rows={len(rows)}")
        print_rows(rows, args.limit)

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
