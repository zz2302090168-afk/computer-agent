import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  existsSync,
  copyFileSync,
  readdirSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'dotenv';
import { runConversation } from '../../backend/agent/conversation.ts';
import { completeRequirements } from '../../backend/agent/conversation-state.ts';
import { recommendDetailed } from '../../backend/services/recommend.ts';
import { auditDelivery } from '../../backend/services/delivery-audit.ts';
import { selectPlan } from '../../backend/services/select-plan.ts';
import { createChatTrace } from '../../backend/diagnostics/chat-trace.ts';
import { retrieveKnowledgeTool } from '../../backend/tools/knowledge/retrieve.ts';
import { installCompactContext } from './compact-plan-context.mjs';
import { installPerformanceCandidate } from './performance-candidates.mjs';

if (process.env.EVAL_PERFORMANCE_CANDIDATE)
  installPerformanceCandidate(process.env.EVAL_PERFORMANCE_CANDIDATE);

if (process.env.EVAL_COMPACT_PLAN_CONTEXT === '1') installCompactContext();

if (process.env.EVAL_TOPIC_CANDIDATE === '1')
  retrieveKnowledgeTool.definition.function.parameters.properties.topicId.description =
    JSON.parse(
      readFileSync('eval/system/topic-candidate.json', 'utf8'),
    ).description;

const directory = process.argv[2];
const runLabel = process.argv[3] ?? 'baseline';
const selectedIds = process.argv.slice(4);
const output = `${directory}/${runLabel}`;
if (existsSync(`${output}/applications.jsonl`))
  throw Error('结果已存在，不能覆盖');
mkdirSync(output, { recursive: true });
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const settings = {
  ...parse(
    readFileSync(
      process.env.EVAL_ENV_FILE ?? 'C:/Users/User/Desktop/电脑agent/.env.local',
    ),
  ),
  ...process.env,
};
for (const [key, value] of Object.entries(settings))
  if (/^(MODEL_|EMBEDDING_)/.test(key)) process.env[key] = value;
const model = {
  key: settings.MODEL_API_KEY,
  base: settings.MODEL_BASE_URL,
  model: settings.MODEL_NAME,
};
const embedding = {
  key: settings.EMBEDDING_API_KEY,
  base: settings.EMBEDDING_BASE_URL,
  model: settings.EMBEDDING_MODEL,
};
const catalog = read(`${directory}/catalog.json`),
  monitors = read(`${directory}/monitors.json`);
// 使用真实目录快照的只读适配器；生产监视器工具仍正常执行，但不能写入数据库。
globalThis.mysqlPool = {
  execute: async (sql) => {
    if (sql.startsWith('SELECT value FROM metadata'))
      return [[{ value: 'initialized' }], []];
    if (sql.startsWith('SELECT * FROM monitors'))
      return [
        monitors.map((m) => ({ ...m, specs: JSON.stringify(m.specs) })),
        [],
      ];
    throw Error('评测数据库适配器禁止未声明查询或写操作');
  },
};
const dataset = read(
  process.env.EVAL_CASES_FILE ?? 'eval/system/pilot.v1.json',
);
const cases = dataset.cases.filter(
  (c) => !selectedIds.length || selectedIds.includes(c.id),
);
const digest = (data) => createHash('sha256').update(data).digest('hex');
const frozen = {
  dataset,
  model: model.model,
  embeddingModel: embedding.model,
  topicCandidate: process.env.EVAL_TOPIC_CANDIDATE === '1',
  compactPlanContext: process.env.EVAL_COMPACT_PLAN_CONTEXT === '1',
  performanceCandidate: process.env.EVAL_PERFORMANCE_CANDIDATE ?? null,
  catalogHash: digest(JSON.stringify(catalog)),
  scope:
    'real_model_real_tools_frozen_MySQL_catalog_memory_state; monitor_SQL_snapshot_adapter; no_browser',
  sourceHashes: {},
};
for (const file of new Set([
  ...readdirSync('backend', { recursive: true })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => `backend/${file.replaceAll('\\', '/')}`),
  'backend/agent/conversation.ts',
  'backend/agent/prompts.ts',
  'backend/agent/sales-reply.ts',
  'backend/tools/build/recommend.ts',
  'backend/tools/build/explain.ts',
  'backend/tools/build/evaluate.ts',
  'backend/tools/support.ts',
  'backend/rag/retrieve.ts',
  'backend/tools/requirements/action.ts',
  'backend/tools/requirements/schema.ts',
  'backend/services/find-replacements.ts',
  'backend/tools/knowledge/retrieve.ts',
  'backend/tools/catalog/search.ts',
  'eval/system/pilot.mjs',
  'knowledge/library.ts',
  'eval/system/compact-plan-context.mjs',
  'eval/system/performance-candidates.mjs',
])) {
  frozen.sourceHashes[file] = digest(readFileSync(file));
  const archived = `${output}/source/${file}.txt`;
  mkdirSync(dirname(archived), { recursive: true });
  copyFileSync(file, archived);
}
writeFileSync(`${output}/manifest.json`, JSON.stringify(frozen, null, 2));
const requirements = completeRequirements({
  budget: 8000,
  purpose: '游戏',
  mode: 'diy',
  color: '黑色',
});
const plans = auditDelivery(
  recommendDetailed(requirements, catalog.parts, catalog.prebuilts).plans,
  requirements,
  catalog,
);
const signature = (result) =>
  JSON.stringify(
    result?.plans.map((p) => ({
      id: p.id,
      total: p.total,
      parts: p.parts.map((x) => [x.category, x.id]),
    })) ?? [],
  );
function initialState(c) {
  let task = {
    id: crypto.randomUUID(),
    name: '隔离评测',
    draft: {},
    result: null,
    issues: [],
    version: 1,
    updatedAt: Date.now(),
  };
  if (['selected', 'unselected'].includes(c.initial)) {
    task.draft = structuredClone(requirements);
    task.result = {
      requirements: task.draft,
      plans: structuredClone(plans),
      summary: '依据冻结真实目录建立的初始方案',
    };
    if (c.initial === 'selected')
      task = selectPlan(
        task,
        plans[1].id,
        catalog,
        { source: 'user_message', messageId: 'initial-selection' },
        false,
      );
  }
  if (c.initial === 'stopped')
    task.draft.support = {
      status: 'stopped',
      selfServiceStopped: true,
      symptom: '此前冒烟，已停止自查',
      history: [{ messageId: 'initial-stop', report: '停止自行排查' }],
    };
  return task;
}
function checks(turn, before, task, facts) {
  const failures = [],
    observations = [];
  const require = (ok, code, hard = false) => {
    if (!ok) failures.push({ code, hard });
  };
  const successful = facts.filter((f) => !f.failed).map((f) => f.tool);
  const ps = task.result?.plans ?? [];
  const action = turn.expect;
  if (turn.selectionUnchanged) {
    const selectionState = (value) => JSON.stringify({
      selection: value.result?.selection ?? null,
      parts: value.draft.partSelections ?? {},
      sources: value.draft.selectionSources ?? {},
      confirmations: value.draft.selectionConfirmationMessageIds ?? {},
    });
    require(selectionState(before) === selectionState(task), 'unrequested_selection_change', true);
  }
  if (turn.expectedPlanIndex !== undefined) {
    const actual = task.result?.selection?.planId;
    require(!!actual, 'selection_not_completed');
    require(!actual || actual === before.result?.plans[turn.expectedPlanIndex]?.id, 'wrong_selected_plan', true);
  }
  for (const [key, value] of Object.entries(turn.draftFields ?? {}))
    require(JSON.stringify(task.draft[key]) ===
      JSON.stringify(value), `draft_${key}`);
  if (turn.noPlans) require(!ps.length, 'unexpected_plan', true);
  if (turn.mustRemainActive)
    require(task.draft.support?.status ===
      'active', 'unrequested_support_stop', true);
  if (turn.noSupportMutation)
    require(JSON.stringify(task.draft.support) ===
      JSON.stringify(
        before.draft.support,
      ), 'unrequested_support_mutation', true);
  if (turn.budget !== undefined)
    require(task.draft.budget === turn.budget, 'budget_extraction');
  if (turn.hardCap)
    require(task.draft.hardCap === true, 'hard_cap_extraction', true);
  if (['generate', 'prebuilt'].includes(action)) {
    require(successful.includes('recommend_pc'), 'recommend_not_executed');
    const noPrebuiltInRange =
      action === 'prebuilt' &&
      !catalog.prebuilts.some((p) => Math.abs(p.price - turn.budget) <= 500);
    if (noPrebuiltInRange)
      require(ps.length === 0 &&
        task.result?.budgetDiagnostic?.searchComplete === true &&
        task.result?.budgetDiagnostic?.kind ===
          'budget_gap', 'unsat_not_explained');
    else require(ps.length > 0, 'no_plan');
    if (action === 'prebuilt')
      require(ps.every((p) => p.kind === 'prebuilt'), 'purchase_mode', true);
    for (const p of ps) {
      require(p.parts.length === 8 &&
        new Set(p.parts.map((x) => x.category)).size ===
          8, 'eight_categories', true);
      require(p.parts.every((x) =>
        catalog.parts.some((k) => k.id === x.id),
      ), 'unknown_product', true);
      require(p.deliveryAudit?.status ===
        'passed', 'delivery_not_passed', true);
      require(p.validation.status !== 'fail', 'known_incompatibility', true);
      if (p.kind === 'diy')
        require(p.total ===
          p.parts.reduce(
            (n, x) => n + catalog.parts.find((k) => k.id === x.id).price,
            0,
          ), 'quote', true);
      else {
        const pc = catalog.prebuilts.find((x) => x.id === p.id);
        require(!!pc && pc.price === p.total, 'prebuilt_price', true);
        require(p.validation.status ===
          'not_applicable', 'prebuilt_compatibility_claim', true);
      }
      require(Math.abs(p.total - turn.budget) <= 500 &&
        (!turn.hardCap || p.total <= turn.budget), 'pilot_budget', true);
      if (turn.color)
        require(p.parts
          .filter((x) => !['cpu', 'storage'].includes(x.category))
          .every((x) => x.color === turn.color), 'color', true);
    }
  }
  if (
    ['save_only', 'clarify', 'consult', 'no_monitor', 'catalog_only'].includes(
      action,
    )
  )
    require(!facts.some((f) =>
      [
        'recommend_pc',
        'assemble_build',
        'select_prebuilt',
        'replace_parts',
        'confirm_selections',
      ].includes(f.tool),
    ), 'unrequested_mutation', true);
  if (action === 'save_only')
    require(successful.includes(
      'update_requirements',
    ), 'requirements_not_saved');
  if (action === 'catalog_only')
    require(successful.includes('search_catalog'), 'catalog_not_queried');
  for (const tool of turn.requiredTools ?? [])
    require(successful.includes(tool), `required_tool_missing:${tool}`);
  if (
    ['find_replacements', 'explain_selection', 'evaluate_plan', 'retrieve_knowledge'].includes(action)
  )
    require(successful.includes(action), 'required_tool_missing');
  if (turn.preserve)
    require(signature(before.result) ===
      signature(task.result), 'unrequested_plan_change', true);
  if (action === 'replace_storage') {
    require(successful.includes('replace_parts'), 'replacement_not_executed');
    const old = before.result.plans.find(
      (p) => p.id === before.result.selection.planId,
    );
    const next =
      ps.find((p) => p.id === task.result.selection?.planId) ?? ps[0];
    require(!!next, 'replacement_no_plan');
    if (next) {
      for (const x of old.parts.filter((p) => p.category !== 'storage'))
        require(next.parts.some(
          (p) => p.category === x.category && p.id === x.id,
        ), 'replacement_scope', true);
      require(next.parts.find((p) => p.category === 'storage').price <
        old.parts.find((p) => p.category === 'storage')
          .price, 'replacement_not_cheaper');
    }
  }
  if (action === 'confirm')
    require(task.result?.selection?.status === 'confirmed', 'not_confirmed');
  if (action === 'select') {
    require(!!task.result?.selection, 'selection_not_completed');
    require(task.result?.selection?.status !== 'confirmed', 'selection_confirmation_confusion', true);
  }
  if (action === 'no_monitor')
    require(!facts.some(
      (f) => f.tool === 'recommend_monitor',
    ), 'monitor_before_host', true);
  if (action === 'monitor') {
    require(successful.includes('recommend_monitor'), 'monitor_not_executed');
    require(task.result?.monitorRecommendation?.monitors?.length >
      0, 'no_monitor_result');
  }
  if (action === 'stopped') {
    const s = task.draft.support;
    require(s?.selfServiceStopped === true ||
      s?.status === 'stopped', 'unsafe_not_stopped', true);
    require(!s?.currentStepId, 'step_after_stop', true);
  }
  if (action === 'support') {
    require(successful.includes('update_support'), 'support_not_updated');
    const s = task.draft.support;
    if (s?.currentStepId)
      require(turn.acceptableSteps.includes(
        s.currentStepId,
      ), 'inappropriate_step');
    else observations.push('clarification_requires_semantic_review');
  }
  if (turn.semanticReview) observations.push('answer_requires_semantic_review');
  return {
    failures,
    observations,
    programPassed: !failures.length,
    semanticVerified: false,
  };
}
for (const c of cases) {
  let task = initialState(c),
    messages = [];
  const seenReplacementCandidates = new Set();
  for (const [index, turn] of c.turns.entries()) {
    const before = structuredClone(task),
      messageId = crypto.randomUUID();
    const trace = createChatTrace({
      experiment: 'system-pilot-v1',
      variant: runLabel,
      caseId: c.id,
      turn: index,
    });
    const row = {
      caseId: c.id,
      group: c.group,
      turn: index,
      query: turn.query,
      traceId: trace.traceId,
      status: 'success',
      checks: null,
    };
    const started = performance.now();
    await trace.run(async () => {
      try {
        const result = await runConversation(
          model,
          {
            task,
            draft: task.draft,
            result: task.result,
            currentTaskId: task.id,
            messages,
          },
          turn.query,
          messageId,
          catalog,
          async () => catalog,
          async (_type, draft, result) => {
            task = { ...task, draft, result, version: task.version + 1 };
            return task.version;
          },
          'isolated-eval',
          async () => {},
          () => {
            row.firstProgressMs ??= performance.now() - started;
          },
          AbortSignal.timeout(300000),
          embedding,
          c.consult ? catalog.prebuilts[2].id : undefined,
          () => {
            row.firstTextMs ??= performance.now() - started;
          },
        );
        messages = result.messages;
        task = { ...task, draft: result.draft, result: result.result };
        row.answer = messages.at(-1)?.content;
        row.facts = result.facts;
        row.finalState = task;
        row.checks = checks(turn, before, task, result.facts);
      } catch (error) {
        row.status = 'failed';
        row.error = { type: error.name, message: error.message };
      }
      row.durationMs = performance.now() - started;
      trace.record('end', { status: row.status, durationMs: row.durationMs });
    });
    const events = readFileSync(trace.file, 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    if (row.checks && (turn.strictCheaper || turn.minReplacementCandidates !== undefined || turn.noReplacementCandidates || turn.expectedReplacementIds)) {
      const results = events.filter((event) => event.event === 'tool.result')
        .map((event) => event.data.result)
        .filter((result) => result?.operation?.tool === 'find_replacements' && !result.operation.failed);
      const candidates = results.flatMap((result) => result.data.candidates ?? []);
      const failure = (code, hard = false) => row.checks.failures.push({ code, hard });
      if (!results.length) failure('replacement_query_missing');
      if (turn.expectedReplacementPage) {
        const calls = new Map(events.filter((event) => event.event === 'tool.start')
          .map((event) => [event.data.callId, event.data.input]));
        const successful = events.filter((event) => event.event === 'tool.result'
          && event.data.result?.operation?.tool === 'find_replacements'
          && event.data.result.operation.failed === false);
        for (const event of successful) {
          const args = calls.get(event.data.callId)?.arguments;
          if (!args || args.searchScope !== 'page'
            || args.offset !== turn.expectedReplacementPage.offset
            || args.limit !== turn.expectedReplacementPage.limit)
            failure('explicit_page_scope_not_honored', true);
        }
      }
      if (turn.minReplacementCandidates !== undefined && candidates.length < turn.minReplacementCandidates)
        failure('replacement_candidates_missing');
      if (turn.maxReplacementCandidates !== undefined && results.some((result) => result.data.candidates.length > turn.maxReplacementCandidates))
        failure('replacement_page_too_large');
      if (turn.requireNonCheaperCandidate && !candidates.some((candidate) => candidate.difference >= 0))
        failure('price_limit_not_observably_canceled');
      if (turn.noReplacementCandidates && candidates.length) failure('unexpected_replacement_candidates');
      const delivered = results.findLast((result) => typeof result.data.displayReply === 'string'
        && row.answer?.includes(result.data.displayReply));
      if (turn.expectedReplacementIds) {
        if (!delivered?.data.candidates?.length) failure('requested_replacement_delivery_missing');
        for (const candidate of candidates) {
          for (const [category, id] of Object.entries(turn.expectedReplacementIds)) {
            if (!candidate.replacements.some(({ newId }) => newId === id)
              || catalog.parts.find((part) => part.id === id)?.category !== category)
              failure(`replacement_requested_product_mismatch:${category}`, true);
          }
        }
      }
      if (turn.nextReplacementPage && !delivered) failure('replacement_delivery_not_identified');
      const currentKeys = new Set((delivered?.data.candidates ?? []).map((candidate) => candidate.replacements
        .map(({ oldId, newId }) => `${oldId}->${newId}`).sort().join('|')));
      if (turn.nextReplacementPage && [...currentKeys].some((key) => seenReplacementCandidates.has(key)))
        failure('replacement_page_repeats_prior_candidate');
      for (const key of currentKeys) seenReplacementCandidates.add(key);
      if (turn.strictCheaper) {
        for (const candidate of candidates) {
          const changes = candidate.replacements.map(({ oldId, newId }) => ({
            old: catalog.parts.find((part) => part.id === oldId),
            next: catalog.parts.find((part) => part.id === newId),
          }));
          if (changes.some((change) => !change.old || !change.next)) {
            failure('unknown_replacement_product', true);
            continue;
          }
          const delta = changes.reduce((sum, change) => sum + change.next.price - change.old.price, 0);
          if (delta >= 0) failure('replacement_not_strictly_cheaper');
          if (delta !== candidate.difference) failure('replacement_difference_incorrect', true);
        }
      }
      row.checks.programPassed = !row.checks.failures.length;
    }
    row.usage = events
      .filter((e) => ['model.usage', 'embedding.usage'].includes(e.event))
      .map((e) => ({ ...e.data.data, kind: e.event.split('.')[0] }));
    row.spans = events
      .filter((e) => /\.(result|error)$/.test(e.event))
      .map((e) => ({
        stage: e.event,
        durationMs: e.data.durationMs,
        status: e.data.status,
      }));
    copyFileSync(trace.file, `${output}/${c.id}-${index}.trace.jsonl`);
    appendFileSync(`${output}/applications.jsonl`, JSON.stringify(row) + '\n');
    console.log(
      JSON.stringify({
        caseId: c.id,
        turn: index,
        status: row.status,
        checks: row.checks,
        seconds: Math.round(row.durationMs / 1000),
      }),
    );
    if (row.status !== 'success') break;
  }
}
console.log(`RESULT_DIR=${output}`);
