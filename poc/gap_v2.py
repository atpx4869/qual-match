"""v2 检测器：缺口=被半透明遮罩覆盖的45x45暗块。
用2D滑窗找"最像缺口"的45x45区域：
  - 缺口被遮罩盖暗：块内均值低于周边
  - 缺口有明显左右竖直边界（遮罩边缘）
综合打分。slider块本身用不上(全实心，是抠出的原图内容)。
"""
import cv2, numpy as np

SLW = 45

def detect_gap_v2(bg, y=None, debug=False):
    gray = cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY).astype(np.float32)
    H, W = gray.shape
    # y 已知则只在该行带内找；否则全图行扫描取最优
    y0 = 0 if y is None else max(0, min(y, H - SLW))
    y1 = H - SLW if y is None else y0
    # 列方向积分图加速块均值
    best = None
    # Sobel 竖直边缘（缺口左右边界强）
    sobelx = np.abs(cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3))
    for yy in range(y0, y1 + 1, 3):
        band = gray[yy:yy+SLW]              # SLW 高
        bandedge = sobelx[yy:yy+SLW]
        col_mean = band.mean(axis=0)         # 每列均值
        col_edge = bandedge.mean(axis=0)
        # 块均值 = 连续SLW列均值
        blk = np.convolve(col_mean, np.ones(SLW)/SLW, mode='valid')  # len W-SLW+1
        # 块左右边界处的竖直边缘强度
        for x in range(SLW, len(blk)):       # 跳过最左滑块起始
            darkness = (col_mean.mean() - blk[x])           # 越暗越正
            left_e = col_edge[x] if x < W else 0
            right_e = col_edge[min(x+SLW-1, W-1)]
            edge_score = (left_e + right_e) / 2
            score = darkness * 1.0 + edge_score * 0.15
            if best is None or score > best[0]:
                best = (score, x, yy, darkness, edge_score)
    _, gx, gy, dark, edge = best
    if debug:
        return gx, gy, round(dark,1), round(edge,1)
    return gx
