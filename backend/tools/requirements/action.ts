import { assertCurrentTaskUserMessage } from './message';
import {
  objectSchema,
  parseObject,
  rejectUnknownKeys,
  requestToolActions,
  supportActions,
  type RegisteredTool,
} from '../types';

const actions = [
  'recommend',
  'clarify',
  'save_requirements',
  'other',
  ...requestToolActions,
] as const;

export const setRequestActionTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'set_request_action',
      description:
        '每条用户消息先明确本轮动作，仅依据用户原话和当前任务：recommend=请求主机配机且可从当前或历史用户消息补齐预算用途；clarify=主机购机需求缺少预算或用途，先保存已提供字段并追问缺失项；save_requirements=明确只在本次对话临时记录需求、暂不生成。纯整机商品咨询、按条件查询整机或配件目录用search_catalog，无需预算用途，不生成或选定方案；只要全部整机浏览入口可用other。已有方案的选定或整单确认用select_plan；用户选一套作为后续讨论对象也必须select_plan(confirm=false)，明确“不是最终确认”只禁止confirm=true，不能省略选定操作；局部确认用confirm_selections；换件用replace_parts；接受改进用apply_suggestion；解释配置选择用explain_selection；评估用evaluate_plan；只查换件候选用find_replacements；硬件知识查询用retrieve_knowledge；只有明确请求显示器推荐且已有完整主机方案时才用recommend_monitor。显示器请求中，仅浏览商品或尚无主机方案时用other，分别引导商品目录或说明推荐前置条件，不启动主机推荐；售后记录用update_support并填写supportAction；只询问转人工的方式、入口、能否提供人工服务时用other，例如“怎么转人工”只解释申请方式，不记录人工请求。只有要求现在请客服接手（包括礼貌、委婉请求）才用update_support且supportAction=handoff。具体工具动作必须执行对应工具后才能回复。other用于无需工具的普通回答、澄清、页面入口指引或暂不操作，不可用于口头承诺选定、修改、查询或解释。本工具不修改任务，也不授予配件替换或确认权限。',
      parameters: objectSchema(
        {
          action: {
            type: 'string',
            enum: actions,
          },
          sourceMessageId: { type: 'string' },
          otherTopic: {
            type: 'string',
            enum: ['support', 'general'],
            description:
              '仅action=other时必填。售后咨询、人工入口说明、暂不排查等用support；商品目录入口或其他普通交谈用general。依据当前用户语义，不从已有售后状态推断。',
          },
          supportAction: {
            type: 'string',
            enum: supportActions,
            description:
              '仅action=update_support时必填。依据当前用户完整语义：continue=记录问题或进展，new_issue=另一故障，stop=停止自行排查，resolved=明确反馈已经恢复，handoff=明确要求现在由人工处理。否定、条件假设、入口咨询、失败或情绪不代表人工请求；只问如何申请人工时主action用other，不填写supportAction；暂停、尚未恢复或询问是否恢复不代表已解决。不按关键词匹配。',
          },
        },
        ['action', 'sourceMessageId'],
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
    ]);
    assertCurrentTaskUserMessage(context, input.sourceMessageId);
    if (input.sourceMessageId !== context.currentMessageId)
      throw Error('本轮动作必须引用当前用户消息');
    if (runtime.requestAction !== 'pending')
      throw Error('本轮动作已记录，不能从工具结果或助手回复重新推导用户意图');
    const action = actions.find((entry) => entry === input.action);
    if (!action) throw Error('本轮动作无效');
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
      runtime.supportRequest = {
        action: supportAction,
        sourceMessageId: context.currentMessageId,
        taskId: context.taskId,
      };
    } else if (input.supportAction !== undefined) {
      throw Error('只有update_support动作可以记录supportAction');
    }
    runtime.requestAction = action;
    if (
      action === 'other' &&
      (input.otherTopic === 'support' || input.otherTopic === 'general')
    )
      runtime.otherTopic = input.otherTopic;
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
