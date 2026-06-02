"""
国家 CMA 滑块缺口定位 PoC
对每个样本用两种方法算缺口 X 偏移，交叉验证一致性：
  1) 模板匹配 (cv2.matchTemplate) —— 用 slider 块在 bg 上滑动找峰值
  2) 边缘检测 (Canny) —— 找缺口轮廓
用法: python detect_gap.py <bg.png> <slider.png>
输出 JSON: {"tpl_x":.., "edge_x":.., "agree":bool, "diff":..}
"""
import sys, json
import cv2
import numpy as np


def load_rgba(path):
    data = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    return data


def gap_by_template(bg_path, slider_path):
    """用滑块块做模板匹配。滑块 PNG 通常带透明通道，取其非透明包围盒做模板。"""
    bg = cv2.imread(bg_path)
    sld = cv2.imread(slider_path, cv2.IMREAD_UNCHANGED)
    if sld is None or bg is None:
        return None
    # 若滑块有 alpha，裁出非透明区域作为模板
    if sld.shape[2] == 4:
        alpha = sld[:, :, 3]
        ys, xs = np.where(alpha > 10)
        if len(xs) == 0:
            tpl = sld[:, :, :3]
            mask = None
        else:
            x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
            tpl = sld[y0:y1 + 1, x0:x1 + 1, :3]
            mask = alpha[y0:y1 + 1, x0:x1 + 1]
    else:
        tpl = sld
        mask = None
    # 边缘化后匹配对光照更鲁棒
    bg_e = cv2.Canny(bg, 100, 200)
    tpl_e = cv2.Canny(tpl, 100, 200)
    try:
        res = cv2.matchTemplate(bg_e, tpl_e, cv2.TM_CCOEFF_NORMED)
        _, maxv, _, maxloc = cv2.minMaxLoc(res)
        return {"x": int(maxloc[0]), "score": float(maxv)}
    except cv2.error:
        return None


def gap_by_edge(bg_path):
    """边缘检测找缺口：缺口边界是高对比竖直边。
    扫描每一列的边缘强度，缺口左边界通常是从左往右第一个显著的竖直边簇（跳过最左 padding）。"""
    bg = cv2.imread(bg_path)
    gray = cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 100, 200)
    h, w = edges.shape
    col_sum = edges.sum(axis=0).astype(np.float64)
    # 跳过最左/最右 边缘 padding 区
    margin = max(8, w // 12)
    candidates = []
    for x in range(margin, w - margin):
        candidates.append((col_sum[x], x))
    candidates.sort(reverse=True)
    # 取竖直边最强的若干列，选最靠左的作为缺口左界
    top = sorted({x for _, x in candidates[:6]})
    return {"x": int(top[0]) if top else -1, "topcols": top}


def main():
    bg_path, slider_path = sys.argv[1], sys.argv[2]
    tpl = gap_by_template(bg_path, slider_path)
    edge = gap_by_edge(bg_path)
    tpl_x = tpl["x"] if tpl else -1
    edge_x = edge["x"] if edge else -1
    diff = abs(tpl_x - edge_x) if tpl_x >= 0 and edge_x >= 0 else -1
    out = {
        "tpl_x": tpl_x,
        "tpl_score": round(tpl["score"], 3) if tpl else None,
        "edge_x": edge_x,
        "edge_topcols": edge["topcols"] if edge else None,
        "diff": diff,
        "agree": (0 <= diff <= 8),
    }
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
