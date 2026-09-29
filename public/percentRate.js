'use strict';

/**
 * 印刷备料表单：过程损耗率「百分数文本」→ 服务端「小数字符串」的精确换算。
 *
 * 背景：过程损耗率输入框按百分数填写（输入 0.9 表示 0.9%）。旧实现直接用
 * Number(text) / 100 上送，而浮点除法会把 0.9 传成 0.009000000000000001；
 * 服务端按十进制字面值将其解析为 9000000000000001/10^18（比真实 9/1000
 * 略大），在「净用纸 + 开机损耗」恰好整除良品率时被 ceil 多取一张——
 * 例如 16 页、每帖 2 张、495 份、每帖开机损耗 1 张、每包 1000 张时，
 * 两帖各被算成 1001 张、采购 3 包；精确的 0.9% 应为各 1000 张、采购 2 包。
 *
 * 本函数只依据「用户输入的十进制文本」做字符串换算（百分数 ÷ 100 即小数点
 * 左移两位），产出的小数字符串交给服务端既有的有理数解析（BigInt 分子 /
 * 分母），前端全程不经过浮点除法，服务端计算逻辑保持不变。
 *
 * 接受范围与输入框标示一致：0 ~ 99.999，最多三位小数。
 * 空串 / 非十进制（科学计数法、含负号等）/ 超过三位小数 / 超出 99.999 等
 * 非法输入一律抛出带可读中文提示的 Error。
 *
 * 示例："3" -> "0.03"，"0.9" -> "0.009"，"99.999" -> "0.99999"，"0" -> "0"。
 *
 * UMD：浏览器经 <script> 引入后挂为全局 percentTextToRate；
 * Node（测试）下以 module.exports 导出。
 */
(function (root, factory) {
  const percentTextToRate = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = percentTextToRate;
  } else {
    root.percentTextToRate = percentTextToRate;
  }
})(globalThis, function percentRateFactory() {
  function percentTextToRate(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (text === '') {
      throw new Error('请填写过程损耗率（%）：范围 0 ~ 99.999，最多三位小数');
    }
    if (!/^\d+(\.\d{1,3})?$/.test(text)) {
      throw new Error(`过程损耗率「${text}」无法识别：请填写 0 ~ 99.999 的十进制百分数，最多三位小数（%）`);
    }
    const dot = text.indexOf('.');
    const intPart = dot < 0 ? text : text.slice(0, dot);
    const fracPart = dot < 0 ? '' : text.slice(dot + 1);
    // 整数部分只由数字组成，Number 安全；99.999% 已是上限（服务端要求损耗率 < 1）。
    if (Number(intPart) > 99) {
      throw new Error(`过程损耗率「${text}」超出范围：百分数必须为 0 ~ 99.999（%），最多三位小数`);
    }

    // 百分数 ÷ 100 = 小数点左移两位：去掉整数部分前导零（值 ≤ 99，至多 2 位），
    // 与小数部分拼成有效数码后补零到「原小数位数 + 2」位，再冠以 "0."。
    // 全程字符串运算，避免 0.9/100 = 0.009000000000000001 这类浮点尾差。
    const digits = String(Number(intPart)) + fracPart;
    const decimalPlaces = fracPart.length + 2;
    const fraction = digits.padStart(decimalPlaces, '0').replace(/0+$/, '');
    return fraction === '' ? '0' : `0.${fraction}`;
  }

  return percentTextToRate;
});
