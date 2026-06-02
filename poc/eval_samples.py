"""批量评估 10 个样本的缺口定位。
方法A 模板匹配: 用 slider(45x45) 的 Canny 边缘在 bg 的 Canny 边缘上滑动找峰值。
方法B 缺口边缘扫描: 缺口是高对比竖直边，按列累加边缘强度找显著峰。
对每个样本输出两法结果 + 在 bg 上画出竖线存图，供肉眼核验。
"""
import cv2, numpy as np, json, os

def tpl_match(bg, sl):
    tpl = sl[:, :, :3]
    bg_e = cv2.Canny(bg, 100, 200)
    tpl_e = cv2.Canny(tpl, 100, 200)
    res = cv2.matchTemplate(bg_e, tpl_e, cv2.TM_CCOEFF_NORMED)
    _, maxv, _, maxloc = cv2.minMaxLoc(res)
    return maxloc[0], float(maxv)

def edge_scan(bg, slider_w=45):
    gray = cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 100, 200)
    h, w = edges.shape
    col = edges.sum(axis=0).astype(float)
    # 缺口左界一般不在最左 slider_w 内（那是滑块起始位），从 slider_w 起找
    start = slider_w
    best_x, best_v = -1, -1
    for x in range(start, w - 5):
        # 用窗口聚合，缺口边是连续竖直边
        v = col[x]
        if v > best_v:
            best_v, best_x = v, x
    return best_x, best_v

os.makedirs('annotated', exist_ok=True)
rows = []
for i in range(10):
    bg = cv2.imread(f'samples/bg_{i}.png')
    sl = cv2.imread(f'samples/sl_{i}.png', cv2.IMREAD_UNCHANGED)
    tx, tscore = tpl_match(bg, sl)
    ex, ev = edge_scan(bg)
    diff = abs(tx - ex)
    rows.append({"i": i, "tpl_x": int(tx), "tpl_score": round(tscore, 3),
                 "edge_x": int(ex), "diff": int(diff), "agree": bool(diff <= 8)})
    vis = bg.copy()
    cv2.line(vis, (tx, 0), (tx, 150), (0, 0, 255), 1)      # 红=模板匹配
    cv2.line(vis, (ex, 0), (ex, 150), (0, 255, 0), 1)      # 绿=边缘扫描
    cv2.imwrite(f'annotated/ann_{i}.png', vis)

agree = sum(1 for r in rows if r["agree"])
print(json.dumps({"rows": rows, "agree_count": agree, "n": len(rows)}, ensure_ascii=False, indent=1))
