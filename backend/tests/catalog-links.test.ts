import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogMessageParts } from '../../frontend/catalog-links';

void test('聊天目录链接保留正文并直达整机或显示器分类', () => {
  assert.deepEqual(
    catalogMessageParts(
      '先[查看整机](/catalog?kind=prebuilt)，也可[看显示器](/catalog?kind=monitor)。',
    ),
    [
      { text: '先' },
      { text: '查看整机', href: '/catalog?kind=prebuilt' },
      { text: '，也可' },
      { text: '看显示器', href: '/catalog?kind=monitor' },
      { text: '。' },
    ],
  );
});

void test('模型返回的外部地址、脚本或其他站内操作不会变成目录链接', () => {
  for (const content of [
    '[外部](https://example.com)',
    '[操作](/api/chat)',
    '[脚本](javascript:alert(1))',
    '[伪目录](//example.com/catalog)',
    '[跳转](/catalog?redirect=https://example.com)',
    '<img src=x onerror=alert(1)>',
  ])
    assert.deepEqual(catalogMessageParts(content), [{ text: content }]);
});
