import { readFileSync } from 'node:fs';

const readSupport = (name: string) =>
  readFileSync(new URL(`./support/${name}.md`, import.meta.url), 'utf8');
const general = readSupport('support-general-flow');
const power = readSupport('support-no-power');
const display = readSupport('support-no-display');
const boot = readSupport('support-no-boot-os');
const bsod = readSupport('support-bsod-restart');
const slow = readSupport('support-slow-freeze');
const heat = readSupport('support-heat-noise');
const network = readSupport('support-network');
const peripherals = readSupport('support-peripherals-data');

const documents = [
  ['support-general-flow', general, ['故障', '排查', '售后', '维修']],
  ['support-no-power', power, ['不开机', '无反应', '不通电', '电源']],
  ['support-no-display', display, ['黑屏', '无信号', '无显示', '显示器']],
  ['support-no-boot-os', boot, ['进不了系统', '启动失败', '找不到启动设备']],
  ['support-bsod-restart', bsod, ['蓝屏', '重启', '死机', '报错']],
  ['support-slow-freeze', slow, ['卡顿', '卡死', '很慢', '变慢']],
  ['support-heat-noise', heat, ['过热', '温度', '噪声', '风扇', '异响']],
  ['support-network', network, ['网络', '断网', 'WiFi', '上不了网']],
  [
    'support-peripherals-data',
    peripherals,
    ['USB', '键盘', '鼠标', '声音', '硬盘', '数据'],
  ],
] as const;

export const supportTopicIds = documents.map(([topicId]) => topicId);
export type SupportKnowledgeKind =
  | 'step'
  | 'clarification'
  | 'context'
  | 'stop';
function supportKind(sectionTitle: string): SupportKnowledgeKind {
  if (/^步骤\d+[：:]/u.test(sectionTitle)) return 'step';
  if (sectionTitle === '先问') return 'clarification';
  if (sectionTitle === '停止条件') return 'stop';
  return 'context';
}

// 文档是唯一正文来源。按标题拆成可选择的步骤，不把整篇故障树塞进一条回复。
export const supportKnowledge = documents.flatMap(
  ([topicId, markdown, tags]) => {
    const title = markdown.match(/^# (.+)/m)?.[1] ?? topicId;
    return [
      ...markdown.matchAll(
        /^#{2,3} (.+)\r?\n([\s\S]*?)(?=^#{2,3} |$(?![\s\S]))/gm,
      ),
    ]
      .filter((match) => match[2].trim())
      .map((match, index) => ({
        id: `${topicId}.${index + 1}`,
        topicId,
        title: `${title} · ${match[1]}`,
        sectionTitle: match[1],
        supportKind: supportKind(match[1]),
        category: 'support',
        tags: [...tags],
        content: match[2].trim(),
        source: null,
        checkedAt: null,
        kind: 'general_guide',
      }));
  },
);
