'use strict';

/**
 * /api/impose 请求归属（public/latestOperation.js）单元测试。
 *
 * 场景：先提交生成 A、改输入再提交 B，或生成未返回时发起试印重核；两条请求
 * 乱序完成时，只有「最后发起」的操作能落地——较早请求无论成功或失败都标记
 * stale，由调用方直接丢弃（不更新结果 / 导航 / 核验结论 / 高亮 / 错误 / 导出）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const createRunner = require('../public/latestOperation');

/** 可控 fetch：登记每个请求的 resolve / reject，按测试节奏决定谁先完成。 */
function controllableFetch() {
  const calls = [];
  const fetchImpl = (url, init) => {
    const call = {
      url,
      init,
      payload: JSON.parse(init.body),
      resolve: null,
      reject: null,
    };
    const p = new Promise((resolve, reject) => {
      call.resolve = resolve;
      call.reject = reject;
    });
    calls.push(call);
    return p;
  };
  function respond(call, { ok = true, status = 200, body = {} }) {
    call.resolve({
      ok,
      status: ok ? status : status || 400,
      json: async () => body,
    });
  }
  return { calls, fetchImpl, respond };
}

function jsonResp(body = {}, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

test('唯一操作成功：非过期，返回状态码与响应 JSON', async () => {
  const { calls, fetchImpl, respond } = controllableFetch();
  const runner = createRunner({ fetch: fetchImpl });
  const p = runner.send({ totalPages: 8 });
  respond(calls[0], { body: { totalPages: 8, signatureCount: 1 } });
  const r = await p;
  assert.equal(r.stale, false);
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { totalPages: 8, signatureCount: 1 });
  assert.equal(runner.seq, 1);
});

test('唯一操作失败：非过期，携带服务端错误信息与状态码', async () => {
  const { calls, fetchImpl, respond } = controllableFetch();
  const runner = createRunner({ fetch: fetchImpl });
  const p = runner.send({ totalPages: 8 });
  respond(calls[0], { ok: false, status: 400, body: { error: '页数必须为整数' } });
  const r = await p;
  assert.equal(r.stale, false);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.error, '页数必须为整数');
});

test('旧响应晚到覆盖新结果：A 先发起后完成、B 后发起先完成，A 一律 stale', async () => {
  const { calls, fetchImpl, respond } = controllableFetch();
  const runner = createRunner({ fetch: fetchImpl });

  // 生成 A（旧输入），先不返回
  const idA = runner.begin();
  const pA = runner.send({ totalPages: 8 }, idA);
  // 改输入后生成 B（新输入）
  const idB = runner.begin();
  const pB = runner.send({ totalPages: 16 }, idB);
  assert.notEqual(idA, idB);
  assert.equal(runner.isLatest(idA), false);
  assert.equal(runner.isLatest(idB), true);

  // B 先成功返回 -> 落地为当前结果
  respond(calls[1], { body: { totalPages: 16, tag: 'B' } });
  const rB = await pB;
  assert.equal(rB.stale, false);
  assert.equal(rB.ok, true);
  assert.equal(rB.data.tag, 'B');

  // A 之后才成功返回（旧响应）-> 过期，不得覆盖预览 / 导出
  respond(calls[0], { body: { totalPages: 8, tag: 'A' } });
  const rA = await pA;
  assert.equal(rA.stale, true);
  assert.equal(rA.ok, true); // 成功也一样过期
  assert.equal(rA.data.tag, 'A');
});

test('旧请求失败晚到：stale 且不得把旧错误误报为当前操作失败', async () => {
  const { calls, fetchImpl, respond } = controllableFetch();
  const runner = createRunner({ fetch: fetchImpl });

  const idA = runner.begin();
  const pA = runner.send({ totalPages: 8 }, idA);
  const idB = runner.begin();
  const pB = runner.send({ totalPages: 16 }, idB);

  // B 先成功
  respond(calls[1], { body: { tag: 'B' } });
  assert.equal((await pB).stale, false);

  // A 失败晚到（如 400 / 503 / 504）：过期失败，调用方应直接忽略
  respond(calls[0], { ok: false, status: 503, body: { error: '线程池满载' } });
  const rA = await pA;
  assert.equal(rA.stale, true);
  assert.equal(rA.ok, false);
  assert.equal(rA.error, '线程池满载');
});

test('最后一次操作失败：非过期失败；上一次成功结果由调用方保留即可', async () => {
  const { calls, fetchImpl, respond } = controllableFetch();
  const runner = createRunner({ fetch: fetchImpl });

  // 先有一次成功生成 A（页面当前结果）
  const pA = runner.send({ totalPages: 8 });
  respond(calls[0], { body: { tag: 'A' } });
  const rA = await pA;
  assert.equal(rA.stale, false);

  // 修改输入后再提交 B，B 失败且为最后一次操作 -> 非过期失败，页面保留 A
  const pB = runner.send({ totalPages: -1 });
  respond(calls[1], { ok: false, status: 400, body: { error: '页数必须 ≥ 1' } });
  const rB = await pB;
  assert.equal(rB.stale, false);
  assert.equal(rB.ok, false);
  assert.equal(rB.error, '页数必须 ≥ 1');
  assert.equal(runner.seq, 2);
});

test('生成未返回时发起重核：重核序号更新；后到的生成响应过期', async () => {
  const { calls, fetchImpl, respond } = controllableFetch();
  const runner = createRunner({ fetch: fetchImpl });

  // 生成（携带观察的提交）在途
  const idGen = runner.begin();
  const pGen = runner.send({ totalPages: 8, observations: [] }, idGen);
  // 观察变化触发自动重核（同一输入 + 新观察）
  const idVerify = runner.begin();
  const pVerify = runner.send({ totalPages: 8, observations: [{ signature: 1 }] }, idVerify);

  // 重核先回来 -> 落地核验结论
  respond(calls[1], { body: { tag: 'verify' } });
  const rVerify = await pVerify;
  assert.equal(rVerify.stale, false);

  // 旧生成响应后到 -> 过期（其核验结论不得覆盖重核结果）
  respond(calls[0], { body: { tag: 'gen' } });
  const rGen = await pGen;
  assert.equal(rGen.stale, true);
});

test('send 省略序号时自动 begin；连续多次调用序号单调递增', async () => {
  const { calls, fetchImpl, respond } = controllableFetch();
  const runner = createRunner({ fetch: fetchImpl });
  const p1 = runner.send({ a: 1 });
  const p2 = runner.send({ a: 2 });
  const p3 = runner.send({ a: 3 });
  assert.equal(runner.seq, 3);

  calls.forEach((c, i) => respond(c, { body: { a: i + 1 } }));
  const rs = await Promise.all([p1, p2, p3]);
  // 即使按发起顺序完成，前两次也已不是最新操作
  assert.deepEqual(rs.map((r) => r.stale), [true, true, false]);
});

test('本地收集阶段先 begin：校验失败的提交也使在途旧响应过期', async () => {
  const { calls, fetchImpl, respond } = controllableFetch();
  const runner = createRunner({ fetch: fetchImpl });

  // 旧生成在途
  const idOld = runner.begin();
  const pOld = runner.send({ totalPages: 8 }, idOld);

  // 用户改输入再次提交：先 begin 占位，随后本地收集 / 校验抛错（不发新请求）
  const idNew = runner.begin();
  const localError = (() => {
    try {
      throw new Error('生成失败：过程损耗率格式错误');
    } catch (e) {
      return e;
    }
  })();
  assert.equal(runner.isLatest(idOld), false);
  assert.equal(runner.isLatest(idNew), true);

  // 旧响应晚到：即使新提交只是本地失败、没有网络请求，旧响应依然过期
  respond(calls[0], { body: { tag: 'old' } });
  const rOld = await pOld;
  assert.equal(rOld.stale, true);
  assert.match(localError.message, /过程损耗率/);
});

test('网络层异常：最新操作失败但非过期，错误信息可读', async () => {
  const calls = [];
  const fetchImpl = () => new Promise((_, reject) => {
    calls.push(1);
    reject(new TypeError('Failed to fetch'));
  });
  const runner = createRunner({ fetch: fetchImpl });
  const r = await runner.send({ totalPages: 8 });
  assert.equal(r.stale, false);
  assert.equal(r.ok, false);
  assert.match(r.error, /Failed to fetch/);
});

test('非 JSON 响应：最新操作失败但非过期', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 502,
    json: async () => { throw new SyntaxError('Unexpected token'); },
  });
  const runner = createRunner({ fetch: fetchImpl });
  const r = await runner.send({ totalPages: 8 });
  assert.equal(r.stale, false);
  assert.equal(r.ok, false);
  assert.match(r.error, /响应解析失败/);
});

test('!resp.ok 但响应体无 error 字段：回退为状态码提示', async () => {
  const fetchImpl = async () => jsonResp({}, false, 500);
  const runner = createRunner({ fetch: fetchImpl });
  const r = await runner.send({ totalPages: 8 });
  assert.equal(r.stale, false);
  assert.equal(r.ok, false);
  assert.equal(r.error, '服务器返回 500');
});

test('请求体与请求头约定不变：POST JSON，body 为提交时输入的序列化', async () => {
  const { calls, fetchImpl, respond } = controllableFetch();
  const runner = createRunner({ fetch: fetchImpl });
  const payload = { totalPages: 16, binding: 'left', flip: 'short' };
  const id = runner.begin();
  const p = runner.send(payload, id);
  assert.equal(calls[0].url, '/api/impose');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  // body 是提交时快照的序列化，之后调用方再改本地对象不影响已发请求
  payload.totalPages = 99;
  assert.deepEqual(calls[0].payload, { totalPages: 16, binding: 'left', flip: 'short' });
  respond(calls[0], { body: {} });
  assert.equal((await p).ok, true);
});
