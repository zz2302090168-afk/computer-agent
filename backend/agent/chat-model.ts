export type ToolCall={id:string;type:'function';function:{name:string;arguments:string}};
export type ModelMessage={role:'system'|'user'|'assistant'|'tool';content:string|null;tool_calls?:ToolCall[];tool_call_id?:string};
export type ToolDefinition={type:'function';function:{name:string;description:string;parameters:Record<string,unknown>}};
export type ModelConfig={key?:string;base?:string;model?:string};
export async function chatCompletion(config:ModelConfig,messages:ModelMessage[],tools:ToolDefinition[],allowTools=true){
 if(!config.key||!config.base||!config.model)throw Error('模型配置缺失，请在服务端配置 API。');
 const url=new URL(config.base);if(url.protocol!=='https:')throw Error('模型地址必须使用 HTTPS');
 const response=await fetch(url.href.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${config.key}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(45000),body:JSON.stringify({model:config.model,messages,tools,tool_choice:allowTools?'auto':'none',temperature:0.2,max_tokens:1600})});
 if(!response.ok)throw Error(`模型连接失败（HTTP ${response.status}），请稍后重试。`);
 const data=await response.json() as {choices?:{message?:ModelMessage}[]};const message=data.choices?.[0]?.message;
 if(!message)throw Error('模型没有返回有效消息');return message;
}
