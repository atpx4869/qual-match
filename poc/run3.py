"""解码带y的20样本，跑 v3(NCC) + v2(暗块) 对比。"""
import json, base64, os, sys, cv2
from gap_v2 import detect_gap_v2
from gap_v3 import detect_gap_v3

p = sys.argv[1]
outer = json.load(open(p, encoding='utf-8'))
body = outer[0]['text'].split('### Result', 1)[1].strip()
inner, _ = json.JSONDecoder().raw_decode(body)
arr = json.loads(inner)

os.makedirs('s3', exist_ok=True)
print(f'{"i":>2} {"y":>3} {"v3_ncc":>14} {"v2_dark":>7} {"agree":>5}')
ag = 0; tot = 0
rows = []
for o in arr:
    if 'bg' not in o: continue
    i, y = o['i'], o['y']
    bgp, slp = f's3/bg_{i}.png', f's3/sl_{i}.png'
    open(bgp,'wb').write(base64.b64decode(o['bg']))
    open(slp,'wb').write(base64.b64decode(o['slider']))
    bg = cv2.imread(bgp); sl = cv2.imread(slp, cv2.IMREAD_UNCHANGED)
    x3, ncc = detect_gap_v3(bg, sl, y, debug=True)
    x2 = detect_gap_v2(bg, y=y)
    agree = abs(x3-x2) <= 12
    ag += agree; tot += 1
    rows.append((i,y,x3,ncc,x2,agree))
    print(f'{i:>2} {y:>3} {str([x3,ncc]):>14} {x2:>7} {str(agree):>5}')
print(f'v3-v2 agree: {ag}/{tot}')
