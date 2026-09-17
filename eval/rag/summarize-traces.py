"""服务端诊断日志与浏览器性能条目的离线汇总；不恢复页面会话。"""
import argparse
import json
from collections import defaultdict
from pathlib import Path
from summarize import distribution

parser = argparse.ArgumentParser()
parser.add_argument('--logs',type=Path,default=Path('logs/chat'))
parser.add_argument('--client',type=Path)
parser.add_argument('--output',type=Path,default=Path('eval/results/traces-summary.json'))
args=parser.parse_args()
spans=defaultdict(list)
requests=[]
for path in sorted(args.logs.glob('*.jsonl')):
    records=[json.loads(line) for line in path.read_text(encoding='utf-8').splitlines()]
    row={'traceId':next((r.get('traceId') for r in records if r.get('traceId')),None),'truncated':any(r['event']=='truncated' for r in records),'usage':[]}
    for event in records:
        data=event.get('data')
        if not isinstance(data,dict):
            continue
        if 'durationMs' in data and event['event'].endswith(('.result','.error')):
            spans[event['event']+'/'+data.get('status','unknown')].append(data['durationMs'])
        if event['event'] in ['request.first_event_sent','request.first_text_sent','end']:
            row[event['event']]=data
        if event['event'] in ['model.usage','embedding.usage']:
            row['usage'].append({'kind':event['event'],**data.get('data',{})})
    requests.append(row)
client=[]
if args.client:
    for entry in json.loads(args.client.read_text(encoding='utf-8')):
        if entry.get('name')=='chat.request':
            client.append({'durationMs':entry['duration'],'detail':entry['detail']})
args.output.parent.mkdir(parents=True,exist_ok=True)
args.output.write_text(json.dumps({'requests':requests,'spanDistributions':{key:distribution(values) for key,values in spans.items()},'client':client,'note':'并行span不相加；浏览器与服务器的时钟原点不同，按traceId关联，不能相减。dom_committed不等于像素绘制。'},ensure_ascii=False,indent=2),encoding='utf-8')
print(f'已汇总 {len(requests)} 轮日志、{len(client)} 条浏览器性能记录')
