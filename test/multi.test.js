'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { startRelayFromConfig, createFileLogger, processHealth } = require('../relay.js');
const { startUpstream, sseFrame, request, COLLAB_FUNCTION_CALL } = require('./helpers.js');

const AGENT_MESSAGE = {
  type: 'agent_message',
  author: '/root',
  recipient: '/root/probe',
  content: [
    { type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/probe\nSender: /root\nPayload:\n' },
    { type: 'encrypted_content', encrypted_content: 'payload-text' },
  ],
};

/** 借一个空闲端口（返回前先释放） */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

test('多端口单进程：端点各自监听、计数独立、钩子各自生效、同一进程', async () => {
  // 注意：startUpstream 已消费请求体并在 'end' 时调用 handler（第三个参数 record 是解析好的 body），
  // handler 里不能再挂 req.on('data'/'end')——那时事件早已发完，响应会永远不回。
  const echoJson = (tag) => (req, res, record) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ who: tag, input: record.json ? record.json.input : null }));
  };
  const upstreamA = await startUpstream(echoJson('A'));
  const upstreamB = await startUpstream(echoJson('B'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-multi-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      endpoints: [
        { name: 'ep-a', port: 0, upstream: upstreamA.origin },
        { name: 'ep-b', port: 0, upstream: upstreamB.origin },
      ],
    }),
  );

  const multi = await startRelayFromConfig({ configPath, hooks: { A: true, B: true } });
  try {
    assert.equal(multi.relays.length, 2);
    const [relayA, relayB] = multi.relays;
    const portA = relayA.server.address().port;
    const portB = relayB.server.address().port;

    // healthz：名字/上游正确、暴露 pid 与 recovered_errors
    const ha = JSON.parse((await request(portA, { path: '/healthz', method: 'GET' })).text);
    const hb = JSON.parse((await request(portB, { path: '/healthz', method: 'GET' })).text);
    assert.equal(ha.name, 'ep-a');
    assert.equal(hb.name, 'ep-b');
    assert.equal(ha.upstream, upstreamA.origin);
    assert.equal(hb.upstream, upstreamB.origin);
    assert.equal(typeof ha.pid, 'number');
    assert.equal(ha.recovered_errors, processHealth.recoveredErrors);
    assert.equal(ha.pid, hb.pid, '同一进程');

    // 钩子 A 在两个端点各自生效、计数互不影响
    await request(portA, { body: { model: 'm', input: [structuredClone(AGENT_MESSAGE)] } });
    await request(portB, { body: { model: 'm', input: [structuredClone(AGENT_MESSAGE)] } });
    assert.equal(relayA.counters.aRewrites, 1);
    assert.equal(relayB.counters.aRewrites, 1);
    assert.equal(relayA.counters.requests, 1);
    assert.equal(relayB.counters.requests, 1);

    // 钩子 B 照常注入（用独立单端点实例验证 SSE 路径）
    const sse = sseFrame('response.output_item.done', { item: COLLAB_FUNCTION_CALL });
    const upstreamSse = await startUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse);
    });
    const cConfig = path.join(dir, 'c-only.json');
    fs.writeFileSync(cConfig, JSON.stringify({ endpoints: [{ name: 'ep-c', port: 0, upstream: upstreamSse.origin }] }));
    const single = await startRelayFromConfig({ configPath: cConfig, hooks: { A: false, B: true } });
    try {
      const portC = single.relays[0].server.address().port;
      const res = await request(portC, { body: { model: 'm', input: [] } });
      assert.match(res.text, /"encrypted_function_args":\[\]/);
      assert.equal(single.relays[0].counters.bInjections, 1);
    } finally {
      await single.close();
      await upstreamSse.close();
    }
  } finally {
    await multi.close();
    await upstreamA.close();
    await upstreamB.close();
  }
});

test('多端口单进程：任一端口被占用则整体失败，且已成功端口的端口被释放（回滚）', async () => {
  const upstream = await startUpstream((req, res) => res.end('{}'));
  const blocker = await startUpstream(() => {});
  const blockerPort = blocker.server.address().port;
  const free1 = await freePort();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-multi-fail-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      endpoints: [
        { name: 'ok-one', port: free1, upstream: upstream.origin },
        { name: 'blocked', port: blockerPort, upstream: upstream.origin },
      ],
    }),
  );

  await assert.rejects(
    () => startRelayFromConfig({ configPath, hooks: { A: true, B: true } }),
    /failed to listen.*blocked/,
  );

  // 回滚生效：free1 已被释放，可以重新绑定
  const retry = await startRelayFromConfig({
    configPath: (() => {
      const p = path.join(dir, 'retry.json');
      fs.writeFileSync(p, JSON.stringify({ endpoints: [{ name: 'again', port: free1, upstream: upstream.origin }] }));
      return p;
    })(),
    hooks: { A: true, B: true },
  });
  await retry.close();

  await blocker.close();
  await upstream.close();
});

test('文件日志：追加写入并在超过上限时轮转为 .1', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-log-'));
  const file = path.join(dir, 'relay.log');
  const logger = createFileLogger(file, 500);

  const line = 'x'.repeat(80);
  for (let i = 0; i < 20; i += 1) logger.write(`${i} ${line}`);
  logger.close();

  // 轮转在 end() 回调里完成，给事件循环一点时间
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(fs.existsSync(file + '.1'), '应产生 .1 轮转文件');
  assert.ok(fs.statSync(file + '.1').size > 0);
  assert.ok(fs.statSync(file).size <= 700, `当前文件应远小于累计写入量（实际 ${fs.statSync(file).size}）`);
});
