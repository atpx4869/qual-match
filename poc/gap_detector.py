"""统一缺口检测器：融合三种方法 + 投票。
m1: slider的alpha轮廓做模板匹配（去背景，只匹拼图形状边缘）
m2: 暗区检测（缺口被半透明遮罩盖暗，找最暗的slider_w宽竖直带）
m3: bg整体Canny + slider前景Canny模板匹配
返回共识gap_x。
"""
import cv2, numpy as np

SLW = 45  # slider 宽度

def _slider_fg(sl):
    """提取 slider 的前景(拼图块本身)的灰度图 + mask。"""
    if sl.shape[2] == 4:
        alpha = sl[:, :, 3]
        bgr = sl[:, :, :3]
    else:
        bgr = sl
        alpha = np.full(sl.shape[:2], 255, np.uint8)
    return bgr, alpha

def m1_alpha_template(bg, sl):
    """用 slider 非透明区的 Canny 边缘做模板匹配（带 mask）。"""
    bgr, alpha = _slider_fg(sl)
    bg_e = cv2.Canny(bg, 80, 160)
    sl_e = cv2.Canny(bgr, 80, 160)
    # 只保留 alpha 内的边缘
    sl_e = cv2.bitwise_and(sl_e, sl_e, mask=(alpha > 30).astype(np.uint8) * 255)
    res = cv2.matchTemplate(bg_e, sl_e, cv2.TM_CCOEFF_NORMED)
    res[:, :SLW] = -1
    _, v, _, loc = cv2.minMaxLoc(res)
    return loc[0], float(v)

def m2_dark_band(bg):
    """缺口区被遮罩盖暗：找 slider_w 宽的最暗竖直带。"""
    gray = cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY)
    col = gray.mean(axis=0).astype(float)
    win = np.convolve(col, np.ones(SLW) / SLW, mode='valid')
    win[:SLW] = 1e9  # 跳过滑块起始区
    x = int(np.argmin(win))
    # 反映"暗"的强度作为置信度（越暗于全局均值越可信）
    conf = max(0.0, (col.mean() - win[x]) / (col.mean() + 1e-6))
    return x, conf

def m3_edge_template(bg, sl):
    bgr, _ = _slider_fg(sl)
    res = cv2.matchTemplate(cv2.Canny(bg, 50, 150), cv2.Canny(bgr, 50, 150), cv2.TM_CCOEFF_NORMED)
    res[:, :SLW] = -1
    _, v, _, loc = cv2.minMaxLoc(res)
    return loc[0], float(v)

def detect_gap(bg, sl, debug=False):
    x1, c1 = m1_alpha_template(bg, sl)
    x2, c2 = m2_dark_band(bg)
    x3, c3 = m3_edge_template(bg, sl)
    cands = [('alpha', x1, c1), ('dark', x2, c2), ('edge', x3, c3)]
    # 投票：找彼此距离<=10的最大簇，取簇内置信度加权均值
    best_cluster, best_score = None, -1
    for i, (_, xi, _) in enumerate(cands):
        cluster = [(n, x, c) for (n, x, c) in cands if abs(x - xi) <= 10]
        score = sum(c for _, _, c in cluster) + (len(cluster) - 1) * 0.5  # 共识加成
        if score > best_score:
            best_score, best_cluster = score, cluster
    xs = [x for _, x, c in best_cluster]
    cs = [c for _, x, c in best_cluster]
    gap_x = int(round(np.average(xs, weights=[c + 0.01 for c in cs])))
    if debug:
        return gap_x, cands, best_cluster
    return gap_x, len(best_cluster)
