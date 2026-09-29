'use strict';

/**
 * 前端损耗率百分数换算（public/percentRate.js）单元测试。
 *
 * 该模块是印刷备料表单「过程损耗率（%）」输入框与服务端之间的唯一换算点：
 * 必须按用户输入的十进制文本精确换算（不做浮点除法），产出的小数字符串
 * 交给服务端既有的有理数解析；非法输入抛出可读中文提示。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const percentTextToRate = require('../public/percentRate');

test('百分数文本精确换算为小数字符串（覆盖输入框 0 ~ 99.999、最多三位小数）', () => {
  const cases = new Map([
    ['0', '0'],
    ['0.0', '0'],
    ['0.000', '0'],
    ['3', '0.03'],
    ['0.9', '0.009'], // 修复目标：浮点 0.9/100 = 0.009000000000000001
    ['0.1', '0.001'],
    ['0.001', '0.00001'],
    ['0.01', '0.0001'],
    ['1', '0.01'],
    ['10', '0.1'],
    ['12.34', '0.1234'],
    ['5.05', '0.0505'],
    ['99.9', '0.999'],
    ['99.99', '0.9999'],
    ['99.999', '0.99999'],
    ['0.5', '0.005'],
    ['7.125', '0.07125'],
  ]);
  for (const [input, expected] of cases) {
    assert.equal(percentTextToRate(input), expected, `「${input}」应换算为「${expected}」`);
  }
});

test('换算结果不含浮点尾差：输出一律是规范十进制文本', () => {
  // 旧实现 Number(text)/100 在若干输入下产生浮点尾差，逐一回归
  for (const text of ['0.9', '0.7', '0.3', '0.29', '2.9', '14.5', '99.999', '0.011']) {
    const out = percentTextToRate(text);
    assert.match(out, /^0(\.\d+)?$|^0$/, `「${text}」的输出「${out}」应为纯十进制文本`);
    assert.ok(!out.includes('e') && !out.includes('E'), `「${text}」的输出不应含科学计数法`);
    // 与服务端一致的字面值语义：输出再转回 number 不应出现 ...0000000001 之类的尾差文本
    assert.equal(out, String(Number(out)), `「${text}」的输出「${out}」应是最短往返形式`);
  }
});

test('前后空白可容忍；整数部分前导零不影响字面值', () => {
  assert.equal(percentTextToRate(' 0.9 '), '0.009');
  assert.equal(percentTextToRate('03'), '0.03');
  assert.equal(percentTextToRate('09.5'), '0.095');
});

test('非法输入给出可读提示：空值 / 超范围 / 超过三位小数 / 非十进制', () => {
  for (const bad of ['', '   ', null, undefined]) {
    assert.throws(() => percentTextToRate(bad), /请填写过程损耗率/, `空输入 ${String(bad)} 应提示填写`);
  }
  for (const bad of ['100', '100.0', '99.9999', '12345']) {
    assert.throws(() => percentTextToRate(bad), /0 ~ 99\.999/, `超范围「${bad}」应提示范围`);
  }
  for (const bad of ['0.0001', '3.0001', '0.1234']) {
    assert.throws(() => percentTextToRate(bad), /最多三位小数/, `超三位小数「${bad}」应提示小数位`);
  }
  for (const bad of ['-0.5', '-1', 'abc', '1e-2', '1e2', '0x10', '1,5', '3.', '.5', 'NaN', 'Infinity']) {
    assert.throws(() => percentTextToRate(bad), /过程损耗率/, `非十进制「${bad}」应被拒绝`);
  }
});

test('与服务端有理数解析衔接：换算输出即服务端可精确解析的字面值', () => {
  // 0.9% 的完整链路：前端文本 -> 小数字符串 -> 服务端逐帖精确取整
  const { computeImposition } = require('../src/imposition');
  const rate = percentTextToRate('0.9');
  assert.equal(rate, '0.009');
  const r = computeImposition({
    totalPages: 16, sheetsPerSignature: 2, binding: 'left', flip: 'short',
    materialPrep: { copies: 495, makereadySheets: 1, processWasteRate: rate, sheetsPerPack: 1000 },
  });
  assert.deepEqual(r.materialPrep.signatures.map((s) => s.requiredSheets), [1000, 1000]);
  assert.equal(r.materialPrep.totals.requiredSheets, 2000);
  assert.equal(r.materialPrep.totals.purchasePacks, 2);
  assert.equal(r.materialPrep.totals.purchaseSheets, 2000);
});
