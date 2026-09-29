'use strict';

/**
 * /api/impose 请求归属：只有「最后发起的操作」能更新页面。
 *
 * 背景：拼版生成与试印重核（含观察增删触发的自动重核）都会 POST /api/impose。
 * 旧实现各自 await，哪条响应先回来就先写页面——先提交生成 A、改输入再提交 B 时，
 * 若 A 的响应晚到，旧预览与 JSON 导会覆盖新结果；生成未返回时发起重核，两条请求
 * 乱序完成同样互相覆盖；旧请求的失败还可能被误报为当前操作失败。
 *
 * 本模块为生成与重核维护同一条单调递增的操作序号：
 *
 * - begin() 声明一次新操作（序号 +1）。拼版输入在本地收集 / 校验之前先 begin，
 *   这样本地校验抛错（如备料参数非法）也会成为「最后一次操作」，在途旧响应晚到
 *   依旧无法覆盖错误提示与既有结果；
 * - send(payload, seq?) 发起请求（请求 / 响应约定与旧实现完全一致：POST JSON、
 *   成功取响应 JSON、!resp.ok 时取 data.error），返回：
 *     { stale: false, ok: true,  status, data }   —— 最新操作成功
 *     { stale: false, ok: false, status?, error } —— 最新操作失败
 *     { stale: true,  ... }                        —— 已被更新操作取代的过期响应
 *   过期响应（无论成功还是失败、何时返回）调用方必须直接忽略，不得改动任何页面
 *   状态——拼版结果、逐张导航、核验结论、定位高亮、错误提示与导出数据都只由
 *   最新一次操作决定；
 * - 最后一次操作失败时调用方保留上一次成功结果即可：失败请求的输入不写入重核
 *   基准（基准更新逻辑在调用方，且只在「最新 + 成功」时执行）。
 *
 * UMD：浏览器经 <script> 引入后挂为全局 createLatestOperationRunner；
 * Node（测试）下以 module.exports 导出。
 */
(function (root, factory) {
  const createLatestOperationRunner = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = createLatestOperationRunner;
  } else {
    root.createLatestOperationRunner = createLatestOperationRunner;
  }
})(globalThis, function latestOperationFactory() {
  function createLatestOperationRunner(options = {}) {
    const url = options.url || '/api/impose';
    const fetchImpl = options.fetch || globalThis.fetch;
    let seq = 0;

    /** 声明一次新操作（生成或重核）：序号加一并返回；此前所有操作随即过期。 */
    function begin() {
      seq += 1;
      return seq;
    }

    /** 某操作序号是否仍为最新；调用方在响应到达时据此做最终归属判定。 */
    function isLatest(id) {
      return id === seq;
    }

    /**
     * 发起一次 /api/impose 请求并给出归属结果，始终 resolve（不抛异常）。
     * id 省略时内部自动 begin（适用于请求体可直接拼出、无本地收集阶段的重核）；
     * 需要先做本地收集 / 校验的生成流程应先 begin() 拿到 id，校验通过后再
     * send(payload, id)，校验失败同样已使在途旧操作失效。
     */
    async function send(payload, id) {
      const myId = id || begin();
      let resp;
      try {
        resp = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        return pack(myId, false, { error: err && err.message ? err.message : String(err) });
      }
      let data;
      try {
        data = await resp.json();
      } catch (err) {
        return pack(myId, false, { error: `响应解析失败：${err.message}` });
      }
      if (!resp.ok) {
        return pack(myId, false, {
          status: resp.status,
          error: data && data.error ? data.error : `服务器返回 ${resp.status}`,
        });
      }
      return pack(myId, true, { status: resp.status, data });
    }

    /** 打包结果：归属判定只看 myId 是否仍等于当前序号，与成败无关。 */
    function pack(myId, ok, rest) {
      return { stale: myId !== seq, ...rest, ok };
    }

    return { begin, send, isLatest, get seq() { return seq; } };
  }

  return createLatestOperationRunner;
});
