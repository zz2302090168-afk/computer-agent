# 显卡命名知识补充与验证

2026-09-16。根据用户建议新增4条RAG知识，区分Intel/AMD/NVIDIA芯片厂商、Arc/Radeon RX/GeForce RTX系列、具体板卡品牌与完整型号。官方事实来源与项目字段约定分别标注，见 `knowledge/recommendation/gpu-naming.md`；运行时内容已加入 `knowledge/library.ts`。

## 真实验证

用例：`eval/system/gpu-naming.v1.json`，结果：`eval/results/gpu-naming-2026-09-16/`。

- GPU-KNOW01：真实检索两次均命中新4条，基本分类正确，但最终答复编写了返回资料没有支持的厂商合作关系，全文未通过。
- GPU-KNOW02：模型误调用`explain_selection`，未检索知识，两次工具失败后仍自行扩写制造和合作关系，未通过。
- 初版程序检查未覆盖`expect=retrieve_knowledge`，已补入必需工具检查；原始结果不覆盖，独立复核保存在`review.json`。不能将原始程序2/2当作真实任务成功，完整答复为0/2通过。

主agent与协调agent分别读取答复和工具事实。知识源文件及哈希保留在`knowledge-source/`、`knowledge-manifest.json`。类型检查、代码检查、构建通过，评测脚本语法检查通过。未改变核心规则，未重复运行全套核心单测。

## 结论与边界

知识补充和检索命中已验证，回答仍有路由错误和超出证据扩写。商品搜索和换件查询当前没有自动使用RAG，故不能宣称PRICE07漏检修复。后续需分别验证知识问答路由、回答依证据生成，以及商品查询中的参数绑定；本轮未修改业务路由、过滤、审核或数据库。
