"""用 ddddocr 的 slide_match 对已存的 10 个样本做缺口识别，与 OpenCV 法对照。"""
import os, cv2, numpy as np
import ddddocr

det = ddddocr.DdddOcr(det=False, ocr=False, show_ad=False)

def opencv_match(bg_path, sl_path):
    bg = cv2.imread(bg_path); sl = cv2.imread(sl_path, cv2.IMREAD_UNCHANGED)
    tpl = sl[:, :, :3]
    res = cv2.matchTemplate(cv2.Canny(bg,100,200), cv2.Canny(tpl,100,200), cv2.TM_CCOEFF_NORMED)
    _, v, _, loc = cv2.minMaxLoc(res)
    return loc[0], round(float(v),3)

print(f"{'i':>2} | {'ddddocr_x':>9} | {'opencv_x':>8} | {'diff':>4}")
print("-"*40)
for i in range(10):
    bgp, slp = f'samples/bg_{i}.png', f'samples/sl_{i}.png'
    with open(bgp,'rb') as f: bgb = f.read()
    with open(slp,'rb') as f: slb = f.read()
    try:
        r = det.slide_match(slb, bgb, simple_target=True)
        dx = r['target'][0]
    except Exception as e:
        dx = -1; print('err', e)
    ox, _ = opencv_match(bgp, slp)
    print(f"{i:>2} | {dx:>9} | {ox:>8} | {abs(dx-ox):>4}")
