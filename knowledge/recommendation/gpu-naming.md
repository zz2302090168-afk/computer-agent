# 显卡名称：芯片厂商、产品系列、板卡品牌与型号

核对日期：2026-09-16。运行时知识条目位于 `knowledge/library.ts`，本文件说明内容和使用边界。

| 芯片厂商 | 游戏显卡系列 | 知识ID |
| --- | --- | --- |
| Intel 英特尔 | Arc | gpu-naming-intel-arc |
| AMD | Radeon RX | gpu-naming-amd-radeon |
| NVIDIA 英伟达 | GeForce RTX | gpu-naming-nvidia-geforce |

RTX是产品系列标识，不是与Intel、AMD并列的芯片厂商。芯片厂商与具体板卡品牌应分开识别，型号中的首词不能机械地用作商品brand。

例如，ASRock的Intel Arc B570 Challenger 10GB OC使用Intel Arc B570图形芯片，板卡品牌是ASRock华擎。这只是一个型号实例，不能推断所有Arc显卡都由华擎提供。

来源：[ASRock型号页](https://www.asrock.com/Graphics-Card/Intel/Intel%20Arc%20B570%20Challenger%2010GB%20OC/)、[NVIDIA GeForce产品页](https://www.nvidia.com/en-us/geforce/graphics-cards/)、[AMD Radeon产品页](https://www.amd.com/en/products/graphics/desktops/radeon.html)。

## 项目使用边界

知识ID：`gpu-naming-catalog-boundary`，类型：`project_policy`。

知识用于解释命名，不替代数据库商品的brand、name和已记录规格。用户明确板卡品牌限制时必须保留；知识中的实例不能作为本店商品存在性、演示身份、价格或兼容性证据。

现有`retrieve_knowledge`用于知识问答和解释，工具说明明确排除商品搜索等业务操作；`find_replacements`不自动检索这份知识。本次新增只补充知识内容，不能据此宣称PRICE07联动换件漏检已修复。将知识接入换件前的参数生成需单独设计并真实复测。
