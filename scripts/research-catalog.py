"""Read official product pages. Research output stays outside the published source."""
import json,re,urllib.request,concurrent.futures
from pathlib import Path
from html import unescape
OUT=Path('outputs/research');OUT.mkdir(parents=True,exist_ok=True)
def fetch(url):
 try:
  req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0'})
  with urllib.request.urlopen(req,timeout=25) as r: raw=r.read();status=r.status
  html=raw.decode('utf-8','ignore')
  title=re.search(r'<title[^>]*>(.*?)</title>',html,re.S|re.I)
  text=unescape(re.sub('<[^>]+>',' ',re.sub(r'<(script|style)\b[^>]*>.*?</\1>','',html,flags=re.S|re.I)))
  text=re.sub(r'\s+',' ',text)
  return {'url':url,'status':status,'title':unescape(title.group(1)) if title else '', 'text':text,'html':html}
 except Exception as e:return {'url':url,'error':type(e).__name__}
if __name__=='__main__':
 gpu=['GeForce-RTX-3050-VENTUS-2X-6G-OC','GeForce-RTX-3060-VENTUS-2X-12G-OC','GeForce-RTX-4060-VENTUS-2X-BLACK-8G-OC','GeForce-RTX-4060-Ti-VENTUS-2X-BLACK-8G-OC','GeForce-RTX-4060-Ti-VENTUS-2X-BLACK-16G-OC','GeForce-RTX-4070-VENTUS-2X-12G-OC','GeForce-RTX-4070-SUPER-12G-VENTUS-2X-OC','GeForce-RTX-4070-Ti-SUPER-16G-VENTUS-3X-OC','GeForce-RTX-4080-SUPER-16G-VENTUS-3X-OC','GeForce-RTX-4090-VENTUS-3X-24G-OC','GeForce-RTX-5060-8G-VENTUS-2X-OC','GeForce-RTX-5060-Ti-8G-VENTUS-2X-OC-PLUS','GeForce-RTX-5060-Ti-16G-VENTUS-2X-OC-PLUS','GeForce-RTX-5070-12G-VENTUS-2X-OC','GeForce-RTX-5070-Ti-16G-VENTUS-3X-OC','GeForce-RTX-5080-16G-VENTUS-3X-OC','GeForce-RTX-5090-32G-VENTUS-3X-OC','GeForce-RTX-4060-VENTUS-2X-WHITE-8G-OC','GeForce-RTX-5070-12G-VENTUS-2X-OC-WHITE','GeForce-RTX-5080-16G-VENTUS-3X-OC-WHITE']
 boards=['B550M-PRO-VDH-WIFI','B550-A-PRO','MAG-B550-TOMAHAWK','MPG-B550-GAMING-PLUS','MAG-B550M-MORTAR','MAG-B550M-MORTAR-WIFI','PRO-B650M-A-WIFI','PRO-B650-S-WIFI','B650-GAMING-PLUS-WIFI','MAG-B650-TOMAHAWK-WIFI','MAG-B650M-MORTAR-WIFI','MPG-B650-EDGE-WIFI','PRO-X670-P-WIFI','MAG-X670E-TOMAHAWK-WIFI','MPG-X670E-CARBON-WIFI','PRO-B850-P-WIFI','B850-GAMING-PLUS-WIFI','MAG-B850-TOMAHAWK-MAX-WIFI','PRO-X870-P-WIFI','MAG-X870-TOMAHAWK-WIFI']
 urls=[f'https://www.msi.com/Graphics-Card/{n}/Specification' for n in gpu]+[f'https://www.msi.com/Motherboard/{n}/Specification' for n in boards]+['https://www.deepcool.com/products/Cases/index.shtml','https://www.deepcool.com/products/Cooling/cpuaircoolers/index.shtml','https://www.corsair.com/ca/en/explorer/diy-builder/power-supply-units/corsair-rme-series-2025/','https://semiconductor.samsung.com/consumer-storage/magician/']
 with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:results=list(pool.map(fetch,urls))
 (OUT/'pages.json').write_text(json.dumps(results,ensure_ascii=False),encoding='utf-8')
 for r in results:print(json.dumps({k:r.get(k) for k in ['url','status','title','error']},ensure_ascii=False))
