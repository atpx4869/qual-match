"""解码24样本 + 跑融合检测器 + 标注图。"""
import json, base64, os, sys
import cv2, numpy as np
from gap_detector import detect_gap, SLW, m1_alpha_template, m2_dark_band, m3_edge_template

p = sys.argv[1]
outer = json.load(open(p, encoding='utf-8'))
body = outer[0]['text'].split('### Result', 1)[1].strip()
dec = json.JSONDecoder()
inner, _ = dec.raw_decode(body)
arr = json.loads(inner)

os.makedirs('s2', exist_ok=True)
os.makedirs('ann', exist_ok=True)
rows = []
for o in arr:
    if 'bg' not in o:
        print('skip', o.get('i'), o.get('err')); continue
    i = o['i']
    bgp, slp = f's2/bg_{i}.png', f's2/sl_{i}.png'
    open(bgp, 'wb').write(base64.b64decode(o['bg']))
    open(slp, 'wb').write(base64.b64decode(o['slider']))
    bg = cv2.imread(bgp); sl = cv2.imread(slp, cv2.IMREAD_UNCHANGED)
    gap, votes, cluster = detect_gap(bg, sl, debug=True)
    x1, c1 = m1_alpha_template(bg, sl)
    x2, c2 = m2_dark_band(bg)
    x3, c3 = m3_edge_template(bg, sl)
    rows.append({"i": i, "gap": gap, "votes": len(cluster),
                 "alpha": [x1, round(c1, 2)], "dark": [x2, round(c2, 2)], "edge": [x3, round(c3, 2)]})
    vis = bg.copy()
    cv2.line(vis, (gap, 0), (gap, 150), (0, 0, 255), 2)            # 红=共识
    cv2.line(vis, (x2, 0), (x2, 150), (0, 255, 255), 1)           # 黄=dark
    cv2.imwrite(f'ann/{i}.png', vis)

print(json.dumps(rows, ensure_ascii=False, indent=0))
