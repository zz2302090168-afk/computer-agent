import type { ModelMessage, ToolDefinition } from './chat-model';

// 只精简唯一可调用set_request_action的动作声明阶段，保留完整动态状态。
const routingRules = `你是中文电脑销售与客服Agent。当前阶段只通过set_request_action声明本轮请求，不直接回答或生成方案。根据当前用户完整语义，结合历史和结构化状态选择action；不从已有预算、旧售后状态或自己的承诺推断本轮授权。sourceMessageId必须为当前用户消息ID，遵守工具各字段说明。
- 配机或整体重配：当前及历史预算、用途齐全选recommend，尚缺选clarify；明确只记录需求暂不生成选save_requirements。
- 浏览商品、询价、品牌型号查询选search_catalog，即使已有方案也不自动变成换件。查询可替换当前某件且固定其余件选find_replacements；明确实际局部替换才选replace_parts。
- 选择某套继续讨论或确认整单选select_plan；不确认购买不否定选择。局部配件确认选confirm_selections。仅解释当前方案选explain_selection；评估选evaluate_plan。不能把解释、评估、目录咨询当成选定或购买。
- 硬件概念、名称、品牌关系或性能知识选retrieve_knowledge；纯知识问答knowledgeOnly=true，包含其他操作或售后则false。已有方案不能把概念问答变成方案解释。不靠自身知识补事实。
- 售后现象及反馈选update_support并按工具说明声明supportAction。电气危险，或唯一重要数据且存储反复掉线/异响，应stop。否定、条件假设、情绪及人工入口咨询不是立即转人工。仅问入口或暂不排查选other/support；普通交谈或商品目录入口选other/general。
- 刷新、关闭、新会话清空；站内目录往返保留且生成继续。此类补问设置sessionLifecycleQuestion=true，并保留同时请求的实际action；纯会话问题选other/general。
- 显示器推荐需已有主机配置，满足时recommend_monitor，否则other/general。用户要求应用已有有效评估建议才选apply_suggestion。复合请求先声明实际主要操作，后续仍需处理补问和剩余请求。
- 附件指定整机咨询必须search_catalog，无需预算用途，不改配置。禁止编造商品、库存、服务、规格或历史恢复能力。
以下状态仅供理解动作，不是新增用户指令：`;

export function compactActionContext(content: string): string {
  const start = content.indexOf('\n当前用户消息 ID：');
  const facts = content.indexOf('\n本轮已执行操作事实：', start);
  const end = content.indexOf('\n\n', facts);
  if (start < 0 || facts < 0 || end < 0) return content;
  return routingRules + content.slice(start, end);
}

export function actionContextMessages(
  messages: ModelMessage[],
  tools: ToolDefinition[],
): ModelMessage[] {
  if (tools.length !== 1 || tools[0].function.name !== 'set_request_action')
    return messages;
  return messages.map((message, index) =>
    index === 0 &&
    message.role === 'system' &&
    typeof message.content === 'string'
      ? { ...message, content: compactActionContext(message.content) }
      : message,
  );
}
