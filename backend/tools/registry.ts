import type { ToolDefinition } from '../agent/chat-model';
import { assembleBuildTool, recommendPcTool } from './build';
import { searchCatalogTool } from './catalog';
import { retrieveKnowledgeTool } from './knowledge';
import { updateRequirementsTool } from './requirements';
import type { RegisteredTool, ToolContext, ToolRuntime } from './types';

export const registeredTools = [
  updateRequirementsTool,
  recommendPcTool,
  searchCatalogTool,
  assembleBuildTool,
  retrieveKnowledgeTool,
] as const;

// 注册表是工具名称到执行入口的唯一映射，启动和测试时都能发现重名。
export function createToolRegistry(tools: readonly RegisteredTool[]) {
  const entries = tools.map(
    (tool) => [tool.definition.function.name, tool] as const,
  );
  if (new Set(entries.map(([name]) => name)).size !== entries.length)
    throw Error('Function Calling 工具名称重复');
  return new Map(entries);
}

const registry = createToolRegistry(registeredTools);
export const toolDefinitions: ToolDefinition[] = registeredTools.map(
  (tool) => tool.definition,
);

export async function executeRegisteredTool(
  name: string,
  argumentsValue: unknown,
  context: ToolContext,
  runtime: ToolRuntime,
) {
  const tool = registry.get(name);
  if (!tool) {
    const error = `不支持的工具：${name}`;
    runtime.toolErrors.push(error);
    return { error };
  }
  try {
    return await tool.execute(argumentsValue, context, runtime);
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : '工具执行失败';
    runtime.toolErrors.push(error);
    return { error };
  }
}
