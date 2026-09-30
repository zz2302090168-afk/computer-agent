"""汇总冻结的 v2 样本；不调用模型，不将无效评分补零。"""
import json
import sys
import hashlib
import statistics
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent
directory, support_dir = map(Path, sys.argv[1:3])
def read(path):
    return json.loads(path.read_text(encoding='utf-8'))
def rows(path):
    return [json.loads(s) for s in path.read_text(encoding='utf-8').splitlines()] if path.exists() else []
def average(values):
    values = [v for v in values if v is not None]
    return {'n':len(values),'mean':statistics.mean(values) if values else None}
def times(values):
    values = [v for v in values if v is not None]
    return {'n':len(values),'median':statistics.median(values) if values else None,'min':min(values) if values else None,'max':max(values) if values else None}
def usage(records):
    result = {}
    for r in records:
        b = result.setdefault(r.get('model','unknown'),{'calls':0,'missingUsage':0,'inputTokens':0,'outputTokens':0,'estimatedCost':None})
        b['calls'] += 1
        u = r.get('usage') or {}
        if u.get('prompt_tokens') is None:
            b['missingUsage'] += 1
        else:
            b['inputTokens'] += u['prompt_tokens']
            b['outputTokens'] += u.get('completion_tokens',0)
    return result

applications = rows(directory/'applications.jsonl')
scores = rows(directory/'assessment-v4/scores.jsonl')
dataset = read(directory/'dataset.v2.json')
selection = read(directory/'selection.json')
assert len(applications) == 2*len(dataset['test'])
assert {(r['caseId'],r['variant']) for r in applications} == {(r['caseId'],r['variant']) for r in scores}
assert len(scores) == len(applications), '重复/缺少评分'
lookup = {(r['caseId'],r['variant']):r for r in scores}
result = {'version':'rag-baseline-v2','humanVerified':False,'runDirectory':str(directory),'supportDirectory':str(support_dir),'selection':selection,'test':{},'latency':{},'usage':{},'limitations':['small synthetic test set','no independent human labels','same application and judge model','one generation per case/variant; no significance claim','cost unknown; no contract pricing','support production path differs from free answer replay']}
for variant in sorted({r['variant'] for r in applications}):
    group = [r for r in applications if r['variant']==variant]
    judges = [lookup[(r['caseId'],variant)] for r in group]
    valid = [s['business']['result'] for s in judges if s['business']['status']=='success']
    result['test'][variant] = {
        'n':len(group),'applicationFailures':sum(r['status']!='success' for r in group),
        'claimCoverage':average(r.get('program',{}).get('claimCoverage') for r in group),
        'mrr':average(r.get('program',{}).get('reciprocalRank') for r in group),
        'labelledPrecision':average(r.get('program',{}).get('labelledPrecision') for r in group),
        'contextCodepoints':average(r.get('contextCodepoints') for r in group),
        'applicationMs':times(r.get('applicationMs') for r in group),
        'firstTextMs':times(r.get('firstTextMs') for r in group),
        'judgeStatus':dict(Counter(s['business']['status'] for s in judges)),
        'businessScores':{metric:average(s['metrics'][metric]['score'] for s in valid) for metric in ['relevance','correctness','business_safety']},
        'criticalFailures':[s['critical_failures'] for s in valid if s['critical_failures']],
        'ragasStatus':dict(Counter(s['ragasFaithfulness']['status'] for s in judges)),
        'faithfulness':average(s['ragasFaithfulness'].get('result',{}).get('value') for s in judges if s['ragasFaithfulness']['status']=='success'),
        'usage':usage([u for r in group for u in r.get('usage',[])]),
    }
latency = rows(directory/'retrieval-latency.jsonl')
variants = sorted(result['test'])
paired_ids = [q['id'] for q in dataset['test'] if all(lookup[(q['id'],v)]['ragasFaithfulness']['status']=='success' and lookup[(q['id'],v)]['ragasFaithfulness']['result']['value'] is not None for v in variants)]
result['pairedFaithfulness'] = {'caseIds':paired_ids,'byVariant':{v:average(lookup[(case,v)]['ragasFaithfulness']['result']['value'] for case in paired_ids) for v in variants}}
for variant in sorted({r['variant'] for r in latency}):
    result['latency'][variant] = {phase:times(r['durationMs'] for r in latency if r['variant']==variant and r['phase']==phase) for phase in ['cold','hot']}
support = rows(support_dir/'applications.jsonl')
support_scores = rows(support_dir/'assessment-v4/scores.jsonl')
assert len(support)==len(support_scores)==4
assert {(r['caseId'],r['variant']) for r in support} == {(r['caseId'],r['variant']) for r in support_scores}
result['support'] = {'n':len(support),'applicationFailures':sum(r['status']!='success' for r in support),'cases':[{'caseId':r['caseId'],'program':r['program'],'retrievalSuccessful':any(s['stage']=='rag.retrieve.result' for s in r['spans']),'retrievalErrors':sum(s['stage']=='rag.retrieve.error' for s in r['spans'])} for r in support],'applicationMs':times(r['applicationMs'] for r in support),'judgeStatus':dict(Counter(r['business']['status'] for r in support_scores)),'ragasStatus':dict(Counter(r['ragasFaithfulness']['status'] for r in support_scores))}
result['usage'] = {
    'developmentEmbedding':usage([u for r in rows(directory/'development.jsonl') for u in r['usage']]),
    'latencyEmbedding':usage([u for r in latency for u in r['usage']]),
    'productionSupport':usage([u for r in support for u in r['usage']]),
    'testJudgeAndCalibration':usage(rows(directory/'assessment-v4/judge-calls.jsonl')),
    'supportJudgeAndCalibration':usage(rows(support_dir/'assessment-v4/judge-calls.jsonl')),
    'failedV3Calibration':usage(rows(directory/'assessment-v3/judge-calls.jsonl')),
}
result['cases'] = [{'caseId':r['caseId'],'variant':r['variant'],'retrievedIds':r.get('retrievedIds'),'program':r.get('program'),'judgeStatus':lookup[(r['caseId'],r['variant'])]['business']['status']} for r in applications]
frozen = {}
for file in ['backend/rag/retrieve.ts','backend/agent/chat-model.ts','backend/rules/budget.ts','knowledge/library.ts','knowledge/support.ts','eval/rag/experiment.mjs','eval/rag/score.py','eval/rag/config.v2.json','eval/rag/dataset.v2.json','eval/rag/judge-prompt.v4.txt']:
    p=Path(file)
    if not p.is_file(): continue
    data=p.read_bytes()
    dest=directory/'source'/file
    dest.parent.mkdir(parents=True,exist_ok=True)
    dest.write_bytes(data)
    frozen[file]=hashlib.sha256(data).hexdigest()
result['finalSourceHashes']=frozen
result['sourceFreezeNote']='运行前manifest已冻结语料、数据、配置和核心代码指纹；运行后源码快照含格式化及评分协议v4。检索算法和生成参数未在测试期间调整。'
(directory/'summary.v2.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
if not (ROOT/'results.v2.json').exists():
    (ROOT/'results.v2.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({k:result[k] for k in ['test','latency','support','usage']},ensure_ascii=False,indent=2))
