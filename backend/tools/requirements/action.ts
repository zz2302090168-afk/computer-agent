import { assertCurrentTaskUserMessage } from './message';
import {
  advanceExecutionPlan,
  executionNodesSchema,
  parseExecutionPlan,
  requestActions,
} from '../../agent/execution-plan';
import {
  objectSchema,
  parseObject,
  rejectUnknownKeys,
  supportActions,
  type RegisteredTool,
} from '../types';

const actions = requestActions;

export const setRequestActionTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'set_request_action',
      description:
        '先规划再执行：必须检查整条消息的全部意图并提供非空nodes。用task1、task2、task3命名，单意图提供一个节点，多意图一次列全并声明DAG依赖。action、invocation、expected全部填写在各节点内，顶层只有sourceMessageId和nodes。参数齐全时在节点内提供invocation的tool和arguments，无需再调用模型选工具；依赖查询结果的未知参数不要编造。用expected记录用户明确的目标参数供程序核验。查询显卡且保存预算必须两个节点，不能只选查询。禁止遗漏第二个要求或以口头承诺代替工具。' +
        '每条用户消息先明确本轮动作，仅依据用户原话和当前任务：recommend=请求主机配机且可从当前或历史用户消息补齐预算用途；clarify=主机购机需求缺少预算或用途，先保存已提供字段并追问缺失项；save_requirements=明确只在本次对话临时记录需求、暂不生成。纯整机商品咨询、按条件查询整机或配件目录用search_catalog，无需预算用途，不生成或选定方案；只要全部整机浏览入口可用other。已有方案的选定或整单确认用select_plan；用户选一套作为后续讨论对象也必须select_plan(confirm=false)，明确“不是最终确认”只禁止confirm=true，不能省略选定操作；局部确认用confirm_selections；换件用replace_parts；接受改进用apply_suggestion；解释配置选择用explain_selection；评估用evaluate_plan；只查换件候选用find_replacements；硬件知识查询用retrieve_knowledge；只有明确请求显示器推荐且已有完整主机方案时才用recommend_monitor。显示器请求中，仅浏览商品或尚无主机方案时用other，分别引导商品目录或说明推荐前置条件，不启动主机推荐；售后记录用update_support并填写supportAction；只询问转人工的方式、入口、能否提供人工服务时用other，例如“怎么转人工”只解释申请方式，不记录人工请求。只有要求现在请客服接手（包括礼貌、委婉请求）才用update_support且supportAction=handoff。具体工具动作必须执行对应工具后才能回复。other用于无需工具的普通回答、澄清、页面入口指引或暂不操作，不可用于口头承诺选定、修改、查询或解释。本工具不修改任务，也不授予配件替换或确认权限。',
      parameters: objectSchema(
        {
          nodes: { ...executionNodesSchema, minItems: 1 },
          sourceMessageId: { type: 'string' },
        },
        ['sourceMessageId', 'nodes'],
      ),
    },
  },
  async execute(value, context, runtime) {
    const input = parseObject(value);
    rejectUnknownKeys(input, [
      'action',
      'sourceMessageId',
      'supportAction',
      'otherTopic',
      'nodes',
      'invocation',
      'expected',
    ]);
    const source = assertCurrentTaskUserMessage(context, input.sourceMessageId);
    if (input.sourceMessageId !== context.currentMessageId)
      throw Error('本轮动作必须引用当前用户消息');
    if (runtime.requestAction !== 'pending')
      throw Error('本轮动作已记录，不能从工具结果或助手回复重新推导用户意图');
    const action = actions.find((entry) => entry === input.action);
    if (!Array.isArray(input.nodes))
      throw Error(
        '必须提供nodes：先检查全部用户意图，复合请求列出所有节点；只有单意图可传空数组',
      );
    if (input.nodes.length) {
      if (input.invocation !== undefined || input.expected !== undefined)
        throw Error('非空计划的invocation和expected必须放在节点内');
      const plan = parseExecutionPlan(input.nodes, source.content);
      const first = plan.nodes.find((node) => node.dependsOn.length === 0);
      if (input.action !== undefined && first?.action !== action)
        throw Error('action必须匹配首个可执行节点');
      if (
        runtime.consultPrebuiltId &&
        plan.nodes.some(
          (node) =>
            !['search_catalog', 'retrieve_knowledge'].includes(node.action),
        )
      )
        throw Error('整机咨询附件仅允许只读查询计划');
      runtime.executionPlan = plan;
      advanceExecutionPlan(runtime, context.currentMessageId, context.taskId);
      return { action: runtime.requestAction, plan };
    }
    if (!action) throw Error('本轮动作无效：请为单意图也提供一个完整节点');
    if (runtime.consultPrebuiltId && action !== 'search_catalog')
      throw Error(
        '本轮附带整机商品咨询，只能声明 search_catalog 只读查询动作，不能选定或修改方案',
      );
    if (action === 'other') {
      if (input.otherTopic !== 'support' && input.otherTopic !== 'general')
        throw Error('other动作必须提供otherTopic，区分售后咨询与普通交谈');
    } else if (input.otherTopic !== undefined) {
      throw Error('只有other动作可以记录otherTopic');
    }
    if (action === 'update_support') {
      const supportAction = supportActions.find(
        (entry) => entry === input.supportAction,
      );
      if (!supportAction)
        throw Error(
          '售后动作必须提供有效的supportAction，请依据当前用户完整语义记录',
        );
    } else if (input.supportAction !== undefined) {
      throw Error('只有update_support动作可以记录supportAction');
    }
    // 单意图简写仅在入口展开，后续与多意图共享计划和完成校验。
    runtime.executionPlan = parseExecutionPlan(
      [
        {
          id: 'task1',
          action,
          goal: source.content,
          sourceQuote: source.content,
          dependsOn: [],
          otherTopic: input.otherTopic,
          supportAction: input.supportAction,
          invocation: input.invocation,
          expected: input.expected,
        },
      ],
      source.content,
    );
    advanceExecutionPlan(runtime, context.currentMessageId, context.taskId);
    return {
      action,
      sourceMessageId: input.sourceMessageId,
      ...(action === 'other' ? { otherTopic: runtime.otherTopic } : {}),
      ...(action === 'update_support'
        ? { supportAction: runtime.supportRequest?.action }
        : {}),
    };
  },
};
