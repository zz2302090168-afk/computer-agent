export const knowledge = [
  {
    id: 'compat-memory',
    title: '内存代际与平台选择',
    category: 'compatibility',
    tags: ['内存', 'DDR4', 'DDR5', '主板', 'CPU'],
    content:
      'DDR4 与 DDR5 的电气特性和物理防呆不同，不能互插。CPU 支持两种内存不代表一块主板同时支持两种内存；必须按具体主板版本选择。检查内存代际、容量上限、条数与插槽数。高频套装标称速度不等于所有 CPU 和主板组合都保证达到的运行速度。',
    source:
      'https://www.kingston.com/en/blog/pc-performance/ddr-memory-generation-differences',
    checkedAt: '2026-09-07',
    kind: 'manufacturer',
  },
  {
    id: 'compat-cpu',
    title: '插槽与 BIOS 支持分开检查',
    category: 'compatibility',
    tags: ['CPU', '主板', 'BIOS', '插槽', '兼容'],
    content:
      'Intel 第十二代桌面处理器使用 LGA1700 平台。购买前应检查主板厂商的 CPU 支持清单及 BIOS 要求；插槽吻合只是必要条件。系统必须区分已确认支持、已确认冲突、缺少资料。不要将型号后缀相近视为同一个产品。',
    source:
      'https://www.intel.com/content/www/us/en/support/articles/000088143/processors/intel-core-processors.html',
    checkedAt: '2026-09-07',
    kind: 'manufacturer',
  },
  {
    id: 'compat-am5',
    title: 'AM5 平台规格实例',
    category: 'compatibility',
    tags: ['AMD', 'AM5', 'DDR5', '7600', 'CPU'],
    content:
      'AMD Ryzen 5 7600 的官方规格页列明 AM5 插槽与 DDR5 系统内存。该实例可用于理解 CPU、主板、内存之间的约束，不能据此推断任意 AM5 主板的出厂 BIOS 都已支持任意 AM5 CPU。商品资料导入时，应保留完整型号及具体主板支持证据。',
    source:
      'https://www.amd.com/en/support/downloads/drivers.html/processors/ryzen/ryzen-7000-series/amd-ryzen-5-7600.html',
    checkedAt: '2026-09-07',
    kind: 'manufacturer',
  },
  {
    id: 'compat-space',
    title: '机箱空间与供电审查流程',
    category: 'compatibility',
    tags: ['机箱', '电源', '显卡', '散热', '尺寸', '兼容'],
    content:
      '本项目检查主板板型、显卡长度和槽位厚度、风冷高度、内存与散热器间隙、电源尺寸和供电接口。厂家资料缺失的字段返回待确认，已知冲突禁止推荐。电源筛选优先采用对应显卡厂家建议功率；瞬时功耗及线材要求仍需按具体型号核对。',
    source: null,
    checkedAt: '2026-09-07',
    kind: 'project_policy',
  },
  {
    id: 'recommend-budget',
    title: '预算硬边界与无解处理',
    category: 'recommendation',
    tags: ['预算', '价格', '便宜', '总价', '推荐'],
    content:
      '所有方案满足主机总价与用户预算差额的绝对值不超过 1000 元，包含边界。用户明确上限时，总价还不得超过上限。DIY 总价由数据库配件报价相加；整机使用整机售价。显示器不计入主机预算。无解时如实说明当前目录没有匹配方案，不擅自放宽边界，也不为凑预算加入无用途的配件。',
    source: null,
    checkedAt: '2026-09-07',
    kind: 'project_policy',
  },
  {
    id: 'recommend-game',
    title: '游戏用途如何分配预算',
    category: 'recommendation',
    tags: ['游戏', 'GPU', 'CPU', '推荐', 'CS2', '黑神话'],
    content:
      '先询问游戏名称和预算，先完成主机，不主动要求用户选择显示器。性能取舍需要依据具体游戏测试，不能认为所有游戏都只取决于显卡。当前候选排序给显卡较高预算权重，并保留 CPU、内存与完整配件的预算；权重仅是候选排序策略，不代表测得的游戏性能。主机确定后再讨论显示器预算、分辨率与刷新率。',
    source: null,
    checkedAt: '2026-09-07',
    kind: 'project_policy',
  },
  {
    id: 'recommend-work',
    title: '办公、创作与本地 AI 的追问策略',
    category: 'recommendation',
    tags: ['办公', '剪辑设计', '编程', '本地 AI', '显存', '推荐'],
    content:
      '办公需要区分文档网页与专业软件。创作需要软件、素材分辨率和项目规模。编程需要区分普通开发、虚拟机、容器和大型编译。本地 AI 需要模型规模、量化方式、推理或训练需求，并核查软件对 GPU 后端的支持。资料不完整时先给候选方案，不承诺能运行任意模型或保证特定生产效率。',
    source: null,
    checkedAt: '2026-09-07',
    kind: 'project_policy',
  },
  {
    id: 'recommend-prebuilt',
    title: '整机配置透明度',
    category: 'recommendation',
    tags: ['整机', '品牌', '内存', '电源', '推荐'],
    content:
      '整机需要关联八类完整配件。仅写容量或功率不能替代完整型号。整机按商家整机目录价推荐；配件行展示商家目录价，不代表整机拆件成交价。当前套餐价格包含 150 元装机服务，运费、系统授权与保修范围需由商家另行说明。',
    source: null,
    checkedAt: '2026-09-07',
    kind: 'project_policy',
  },
];
