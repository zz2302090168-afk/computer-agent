import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx';
import type { Plan, Requirements } from '../domain/types';

const border = { style: BorderStyle.SINGLE, size: 1, color: 'D9D9D9' };
const cellBorders = {
  top: border,
  bottom: border,
  left: border,
  right: border,
};
const money = (value: number) => `¥${value.toLocaleString('zh-CN')}`;

function cell(
  text: string,
  width: number,
  options: {
    header?: boolean;
    align?: (typeof AlignmentType)[keyof typeof AlignmentType];
    shade?: boolean;
  } = {},
) {
  return new TableCell({
    width: { size: width, type: WidthType.PERCENTAGE },
    borders: cellBorders,
    margins: { top: 100, bottom: 100, left: 120, right: 120 },
    verticalAlign: VerticalAlign.CENTER,
    shading: options.header
      ? { fill: '1F4E78', color: 'auto', type: ShadingType.CLEAR }
      : options.shade
        ? { fill: 'F4F7FB', color: 'auto', type: ShadingType.CLEAR }
        : undefined,
    children: [
      new Paragraph({
        alignment: options.align ?? AlignmentType.LEFT,
        spacing: { before: 0, after: 0, line: 280 },
        children: [
          new TextRun({
            text,
            bold: options.header,
            color: options.header ? 'FFFFFF' : '000000',
            size: 20,
          }),
        ],
      }),
    ],
  });
}

function factRow(label: string, value: string, shade = false) {
  return new TableRow({
    children: [cell(label, 24, { shade }), cell(value, 76, { shade })],
  });
}

function compatibilityLabel(plan: Plan) {
  if (plan.kind === 'prebuilt') return '商家整机，不执行 DIY 配件兼容性审核';
  if (plan.validation.status === 'pass') return '已录入规格未发现兼容冲突';
  if (plan.validation.status === 'fail') return '存在兼容冲突';
  return '存在购买与装机前待核对项目';
}

export async function buildPlanDocx(plan: Plan, requirements: Requirements) {
  const difference = plan.total - requirements.budget;
  const children = [
    new Paragraph({
      text: '电脑配置方案',
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: `本文件记录“${plan.tier ?? plan.name}”的当前商品、价格、预算及兼容性结果。方案总价为 ${money(plan.total)}。`,
        }),
      ],
      spacing: { after: 240, line: 320 },
    }),
    new Paragraph({
      text: '方案摘要',
      heading: HeadingLevel.HEADING_1,
    }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      layout: TableLayoutType.FIXED,
      rows: [
        factRow('方案', plan.tier ?? plan.name),
        factRow(
          '购买方式',
          plan.kind === 'diy' ? 'DIY 自由搭配' : '商家组装整机',
          true,
        ),
        factRow(
          '用途',
          requirements.game
            ? `${requirements.purpose}（${requirements.game}）`
            : requirements.purpose,
        ),
        factRow('配色要求', requirements.color, true),
        factRow('主机预算', money(requirements.budget)),
        factRow('方案总价', money(plan.total)),
        factRow(
          '与预算相比',
          difference === 0
            ? '刚好符合预算'
            : `${difference > 0 ? '超出' : '节省'} ${money(Math.abs(difference))}`,
          true,
        ),
        factRow('预算结论', plan.budget.reason),
        factRow('兼容性结论', compatibilityLabel(plan), true),
        factRow('方案说明', plan.reason),
      ],
    }),
    new Paragraph({
      text: '配件明细',
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 280, after: 140 },
    }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      layout: TableLayoutType.FIXED,
      rows: [
        new TableRow({
          tableHeader: true,
          children: [
            cell('类别', 14, { header: true, align: AlignmentType.CENTER }),
            cell('品牌与型号', 52, { header: true }),
            cell('颜色', 14, { header: true, align: AlignmentType.CENTER }),
            cell('目录价', 20, { header: true, align: AlignmentType.RIGHT }),
          ],
        }),
        ...plan.parts.map(
          (part, index) =>
            new TableRow({
              children: [
                cell(part.categoryLabel, 14, {
                  shade: index % 2 === 1,
                  align: AlignmentType.CENTER,
                }),
                cell(`${part.brand} ${part.name}`, 52, {
                  shade: index % 2 === 1,
                }),
                cell(part.color, 14, {
                  shade: index % 2 === 1,
                  align: AlignmentType.CENTER,
                }),
                cell(money(part.price), 20, {
                  shade: index % 2 === 1,
                  align: AlignmentType.RIGHT,
                }),
              ],
            }),
        ),
      ],
    }),
    new Paragraph({
      text: '兼容性与装机提醒',
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 280, after: 100 },
    }),
    new Paragraph({
      text: compatibilityLabel(plan),
      spacing: { after: 100 },
    }),
    ...(plan.validation.issues.length
      ? plan.validation.issues.map(
          (issue) =>
            new Paragraph({
              text: `• ${issue}`,
              indent: { left: 320, hanging: 180 },
              spacing: { after: 70, line: 300 },
            }),
        )
      : [
          new Paragraph({
            text: '当前没有需要单独列出的兼容性问题。',
            spacing: { after: 100 },
          }),
        ]),
    new Paragraph({
      children: [
        new TextRun({
          text:
            plan.kind === 'prebuilt'
              ? '整机售价以商家整机目录价为准；配件行价格只用于说明构成，不作为拆件成交价。'
              : 'DIY 总价为八类配件目录价之和。带有“推定值”或“待确认”的项目应在购买和装机前核对；装好后的点亮、硬件识别、温度和稳定性测试不能替代兼容性确认。',
          italics: true,
          color: '404040',
        }),
      ],
      spacing: { before: 120, line: 300 },
    }),
  ];

  const document = new Document({
    creator: '电脑配置 Agent',
    title: '电脑配置方案',
    description: '主机配置、预算与兼容性核对结果',
    styles: {
      default: {
        document: {
          run: { font: 'Microsoft YaHei', size: 21, color: '000000' },
          paragraph: { spacing: { after: 120, line: 320 } },
        },
      },
      paragraphStyles: [
        {
          id: 'Title',
          name: 'Title',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: {
            font: 'Microsoft YaHei',
            size: 34,
            bold: true,
            color: '000000',
          },
          paragraph: { spacing: { after: 240 } },
        },
        {
          id: 'Heading1',
          name: 'Heading 1',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: {
            font: 'Microsoft YaHei',
            size: 25,
            bold: true,
            color: '000000',
          },
          paragraph: { spacing: { before: 260, after: 120 }, keepNext: true },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 },
          },
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(document);
}
