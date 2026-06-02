"""v3：利用slider是"缺口处抠出的原图块"这一事实。
真缺口处：bg的45x45区域 = slider块整体变暗(+遮罩)。
所以 bg区域 与 slider块 的【归一化互相关 NCC】在真缺口处最高
（变暗是线性/近线性变换，NCC对亮度偏移和缩放鲁棒）。
对每个x算 NCC(bg[y:y+45, x:x+45], slider)，取峰值。
"""
import cv2, numpy as np

SLW = 45

def detect_gap_v3(bg, sl, y, debug=False):
    g_bg = cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY).astype(np.float32)
    g_sl = cv2.cvtColor(sl[:, :, :3], cv2.COLOR_BGR2GRAY).astype(np.float32)
    H, W = g_bg.shape
    y = max(0, min(y, H - SLW))
    tpl = g_sl
    tpl_z = tpl - tpl.mean()
    tpl_n = np.sqrt((tpl_z ** 2).sum()) + 1e-6
    best = (-2, SLW)
    band = g_bg[y:y+SLW]
    for x in range(SLW, W - SLW + 1):
        win = band[:, x:x+SLW]
        win_z = win - win.mean()
        ncc = (win_z * tpl_z).sum() / (np.sqrt((win_z ** 2).sum()) + 1e-6) / tpl_n
        if ncc > best[0]:
            best = (ncc, x)
    if debug:
        return best[1], round(best[0], 3)
    return best[1]
