"""对真实抓取的 live_bg/live_sl 跑 ddddocr，并把缺口位置画线到图上核验。"""
import cv2, ddddocr

det = ddddocr.DdddOcr(det=False, ocr=False, show_ad=False)
with open('live_bg.png','rb') as f: bgb = f.read()
with open('live_sl.png','rb') as f: slb = f.read()

r = det.slide_match(slb, bgb, simple_target=True)
print("ddddocr slide_match:", r)
gap_x = r['target'][0]

bg = cv2.imread('live_bg.png')
cv2.line(bg, (gap_x,0), (gap_x,bg.shape[0]), (0,0,255), 2)
# 也画 target 的右边界
if len(r['target']) >= 3:
    cv2.line(bg, (r['target'][2],0), (r['target'][2],bg.shape[0]), (0,255,0), 1)
cv2.imwrite('live_annotated.png', bg)
print("bg size:", bg.shape, "gap_x:", gap_x)
