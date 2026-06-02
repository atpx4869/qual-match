"""鲁棒缺口定位：仅用模板匹配，多策略对比，输出标注图供肉眼核验。
策略:
  A) 灰度Canny模板匹配（全图）
  B) 灰度Canny模板匹配（限制x>=slider_w，缺口不会在最左滑块起始区）
  C) 彩色模板匹配 TM_CCOEFF_NORMED（全图）
输出每样本三策略x值+score，并画三色竖线。
"""
import cv2, numpy as np, json, os, sys

SLW = 45  # slider 宽度

def canny_match(bg, tpl, x_min=0):
    bg_e = cv2.Canny(bg, 100, 200)
    tpl_e = cv2.Canny(tpl, 100, 200)
    res = cv2.matchTemplate(bg_e, tpl_e, cv2.TM_CCOEFF_NORMED)
    if x_min > 0:
        res[:, :x_min] = -1  # 屏蔽最左区
    _, maxv, _, loc = cv2.minMaxLoc(res)
    return loc[0], float(maxv)

def color_match(bg, tpl, x_min=0):
    res = cv2.matchTemplate(bg, tpl, cv2.TM_CCOEFF_NORMED)
    if x_min > 0:
        res[:, :x_min] = -1
    _, maxv, _, loc = cv2.minMaxLoc(res)
    return loc[0], float(maxv)

n = int(sys.argv[1]) if len(sys.argv) > 1 else 10
os.makedirs('annotated2', exist_ok=True)
rows = []
for i in range(n):
    bg = cv2.imread(f'samples/bg_{i}.png')
    sl = cv2.imread(f'samples/sl_{i}.png', cv2.IMREAD_UNCHANGED)
    tpl = sl[:, :, :3]
    ax, asc = canny_match(bg, tpl, 0)
    bx, bsc = canny_match(bg, tpl, SLW)
    cx, csc = color_match(bg, tpl, SLW)
    rows.append({"i": i, "A_full": [ax, round(asc,3)],
                 "B_canny_xmin": [bx, round(bsc,3)],
                 "C_color_xmin": [cx, round(csc,3)]})
    vis = bg.copy()
    cv2.line(vis, (ax,0),(ax,150),(0,0,255),1)    # 红 A
    cv2.line(vis, (bx,0),(bx,150),(0,255,0),1)    # 绿 B
    cv2.line(vis, (cx,0),(cx,150),(255,0,0),1)    # 蓝 C
    cv2.imwrite(f'annotated2/ann_{i}.png', vis)
print(json.dumps(rows, ensure_ascii=False, indent=1))
