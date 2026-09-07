"""One-time catalog authoring from researched manufacturer pages. Prices are our own.

Requires the ignored outputs/research snapshots. The committed JSON is canonical;
normal startup and merchant edits never run this script.
"""
import json, re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
research = root / 'outputs/research'
labels = dict(cpu='CPU', gpu='GPU', memory='内存', motherboard='主板', psu='电源', case='机箱', storage='硬盘', cooler='散热')
parts = []
def add(category, brand, name, price, source, specs=None, color='不适用'):
    index = sum(p['category'] == category for p in parts)
    p = dict(id=f'real-{category}-{index}', category=category, categoryLabel=labels[category], brand=brand, name=name, color=color, price=price, demo=False,
             specs=dict(specs or {}, source=source, checkedAt='2026-09-07', priceBasis='merchant-authored'))
    parts.append(p)

cpus = ['5 5600','5 5600X','7 5700X','7 5700X3D','7 5800X','7 5800X3D','9 5900X','9 5950X','5 7500F','5 7600','5 7600X','7 7700','7 7700X','7 7800X3D','9 7900','9 7900X','9 7950X','5 9600X','7 9700X','7 9800X3D']
cpu_prices = [650,750,950,1350,1150,1750,1500,2100,850,1050,1150,1500,1650,2400,2200,2400,3200,1400,2100,3500]
tdps = [65,65,65,105,105,105,105,105,65,65,105,65,105,120,65,170,170,65,65,120]
for i, name in enumerate(cpus):
    generation = '5000' if i < 8 else '7000' if i < 17 else '9000'
    source = f'https://www.amd.com/en/products/processors/desktops/ryzen/{generation}-series/amd-ryzen-{name.replace(" ", "-").lower()}.html'
    if i in [0,2]: source = 'https://www.amd.com/en/newsroom/press-releases/2022-3-15-amd-launches-the-ultimate-gaming-processor-brings.html'
    if i == 3: source = 'https://www.amd.com/en/newsroom/press-releases/2024-1-8-amd-reveals-next-gen-desktop-processors-for-extrem.html'
    add('cpu','AMD','Ryzen '+name,cpu_prices[i],source,dict(socket='AM4' if i<8 else 'AM5', ddr='DDR4' if i<8 else 'DDR5', tdp=tdps[i]))

pages = json.loads((research/'pages.json').read_text(encoding='utf-8'))
gpu_prices = [1100,1700,1900,2400,2800,3300,3900,4900,6800,13000,2300,2700,3300,4300,5700,8500,19000,2100,7000,9300]
# Manufacturer power, recommended system PSU, dimensions, connector. Missing values stay unknown.
gpu_specs = [(70,300,189,42,'none'),(170,550,235,42,'8pin'),(120,550,199,41,'8pin'),(160,550,199,42,'8pin'),(165,550,199,42,'8pin'),(200,650,242,43,'8pin'),(220,650,242,43,'16pin'),(285,700,308,50,'16pin'),(320,750,322,62,'16pin'),None,None,None,(180,600,227,41,'8pin'),(250,650,236,50,'16pin'),(300,750,303,49,'16pin'),(360,850,303,49,'16pin'),(575,1000,325,67,'16pin'),(120,550,199,41,'8pin'),(250,650,236,50,'16pin'),(360,850,303,49,'16pin')]
for i,page in enumerate(pages[:20]):
    name=page['url'].split('/')[-2].replace('-',' ')
    spec = {}
    if gpu_specs[i]:
        power,minimum,length,thickness,connector = gpu_specs[i]
        spec=dict(power=power,recommendedPsu=minimum,length=length,thickness=thickness,connector=connector,connectors=0 if connector=='none' else 1)
    add('gpu','MSI 微星',name,gpu_prices[i],page['url'],spec,'白色' if 'WHITE' in name else '黑色' if 'BLACK' in name else '银黑色')

codes=['KF432C16BBK2_16','KF432C16BBK2_32','KF432C16BBK2_64','KF436C18BBK2_32','KF436C18BBK2_64','KF432C16BBAK2_16','KF432C16BBAK2_32','KF436C18BBAK2_32','KF552C36BBEK2-16','KF552C36BBEK2-32','KF556C36BBEK2-16','KF556C36BBEK2-32','KF560C36BBEK2-16','KF560C36BBEK2-32','KF560C36BBEK2-64','KF560C36BBEAK2-32','KF560C36BWEK2-32','KF560C36BWEAK2-32','KF432C16BB_8','KF432C16BB_16']
ram_prices=[230,390,690,430,750,270,450,490,320,520,350,550,380,580,1050,650,630,690,100,190]
for i,code in enumerate(codes):
    capacity=int(re.split('[_-]',code)[-1]);ddr='DDR4' if code[2]=='4' else 'DDR5'
    add('memory','Kingston 金士顿','FURY Beast '+code.replace('_','/'),ram_prices[i],f'https://www.kingston.com/datasheets/{code}.pdf',dict(ddr=ddr,capacity=capacity,sticks=2 if 'K2' in code else 1),'白色' if 'BWE' in code else '黑色')

board_prices=[550,650,850,750,750,850,950,950,1050,1350,1250,1650,1800,2100,2900,1400,1500,2000,1800,2300]
for i,page in enumerate(pages[20:40]):
    slug=page['url'].split('/')[-2]
    add('motherboard','MSI 微星',slug.replace('-',' '),board_prices[i],page['url'],dict(socket='AM4' if i<6 else 'AM5',ddr='DDR4' if i<6 else 'DDR5',ramSlots=4,form='mATX' if '550M' in slug or '650M' in slug else 'ATX',m2=True,biosVerified=False),'银黑色')

rme='https://www.corsair.com/ca/en/explorer/diy-builder/power-supply-units/corsair-rme-series-2025/'
psu_families=[('RMx',2021,[550,650,750,850,1000],'https://assets.corsair.com/image/upload/corsairmedia/sys_master/productcontent/WW_RMx_Series_2021_QSG_Web_AD.pdf'),('RMe',2025,[650,750,850,1000],rme),('CXM',2021,[550,650,750],'https://assets.corsair.com/image/upload/corsairmedia/sys_master/productcontent/WW_CXM_Series_2021_QSG_AA.pdf'),('SF',2024,[750,850,1000],'https://www.corsair.com/us/en/explorer/diy-builder/power-supply-units/sf750sf850sf1000-platinum-atx-31-everything-you-need-to-know/'),('RM',2021,[650,750,850],'https://assets.corsair.com/image/upload/corsairmedia/sys_master/productcontent/WW_RM_Series_2021_QSG_Web_AA.pdf'),('HX',2022,[1000,1500],'https://help.corsair.com/hc/en-us/articles/45351527323793-CORSAIR-Spare-Parts-List')]
for family,year,watts_list,source in psu_families:
    for watts in watts_list:
        name={'RMx':f'RM{watts}x','RMe':f'RM{watts}e','CXM':f'CX{watts}M','SF':f'SF{watts}','RM':f'RM{watts}','HX':f'HX{watts}i'}[family]
        spec=dict(watts=watts,form='SFX' if family=='SF' else 'ATX')
        if family=='RMe':spec.update(length=140,connectorCounts={'8pin':1 if watts==650 else 2,'16pin':1})
        price=round(watts*({'RMx':1.1,'RMe':.9,'CXM':.6,'SF':1.5,'RM':.9,'HX':1.8}[family]))
        add('psu','CORSAIR 美商海盗船',f'{name} ({year})',price,source,spec,'黑色')

deepcool=json.loads((research/'deepcool.json').read_text(encoding='utf-8'))
case_prices=[299,329,259,289,299,329,399,429,249,279,199,229,249,279,399,429,549,579,449,479]
cooler_prices=[159,179,129,149,229,249,99,119,79,99,199,219,349,379,279,299,179,199,699,749]
for item in deepcool:
    category=item['category'];text=item['text'];tech=text[text.index('Technical Spec'):];name=item['name']
    if category=='case':
        motherboard=re.search(r'Motherboard Support (.*?) Front I/O',tech).group(1)
        forms=[f for raw,f in [('Mini-ITX','ITX'),('Micro-ATX','mATX'),(' / ATX','ATX'),('E-ATX','EATX')] if raw in motherboard]
        height=int(re.search(r'CPU Cooler Height Limit (\d+)',tech).group(1))
        length=re.search(r'GPU Length Limit (\d+)',tech)
        spec=dict(forms=forms,coolerHeight=height,psuForm='ATX',psuLength=int(re.search(r'maximum length:\s*(\d+)',tech).group(1)))
        if length:spec['gpuLength']=int(length.group(1))
        else:spec['gpuLength']=230;spec['gpuLengthNote']='使用 ATX 电源；SFX 方案另行核对'
        price=case_prices[sum(p['category']=='case' for p in parts)]
    else:
        height=int(re.search(r'Product Dimensions \d+×\d+×(\d+)',tech).group(1))
        spec=dict(height=height,sockets=[s for s in ['AM4','AM5'] if s in text])
        price=cooler_prices[sum(p['category']=='cooler' for p in parts)]
    add(category,'DeepCool 九州风神',name,price,item['url'],spec,'白色' if 'WH' in name else '黑色')

ssd_source='https://semiconductor.samsung.com/consumer-storage/magician/'
families=[('970 EVO Plus','V7S',[250,500,1000,2000],[150,220,350,650]),('980','V8V',[250,500,1000],[140,200,320]),('980 PRO','V8P',[250,500,1000,2000],[190,280,450,750]),('990 PRO','V9P',[1000,2000,4000],[550,900,1750]),('990 EVO','V9E',[1000,2000],[420,720]),('990 EVO Plus','V9S',[1000,2000,4000],[490,850,1550]),('9100 PRO','VAP',[2000],[1400])]
for family,code,capacities,prices in families:
    for capacity,price in zip(capacities,prices):
        size=f'{capacity}GB' if capacity<1000 else f'{capacity//1000}TB'
        sku=f'MZ-{code}{capacity if capacity<1000 else str(capacity//1000)+"T0"}BW'
        add('storage','Samsung 三星',f'{family} {size} ({sku})',price,ssd_source,dict(capacity=capacity,interface='M.2 NVMe'))

pcs=[]
for i in range(20):
    tier=i//2;white=i%2
    indices=dict(cpu=[0,1,2,8,9,11,13,18,19,16][tier],gpu=[0,2,10,12,13,6,14,8,15,16][tier],memory=[0,1,3,9,11,13,13,14,14,14][tier],motherboard=0 if tier<3 else 7,psu=5 if tier<5 else 6 if tier<8 else 7 if tier==8 else 8,case=4+white,cooler=(8 if tier<3 else 10 if tier<6 else 12)+white,storage=[2,2,3,9,10,11,12,12,13,13][tier])
    chosen=[next(p for p in parts if p['id']==f'real-{c}-{indices[c]}') for c in labels]
    pcs.append(dict(id=f'real-pc-{i}',name=f'商家组装套餐 {tier+1:02d} · '+('白色机箱' if white else '黑色机箱'),brand='装机研究所',color='白色' if white else '黑色',price=sum(p['price'] for p in chosen)+150,partIds=[p['id'] for p in chosen],demo=False))
assert len(parts)==160 and len(pcs)==20
for category in labels: assert sum(p['category']==category for p in parts)==20
for filename,data in [('products.json',parts),('prebuilts.json',pcs)]:
    (root/'data/seed'/filename).write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print('Authored 160 real-model products and 20 merchant builds; all prices are assigned catalog prices.')
