'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { createRelay, createCapture, rewriteAgentMessages } = require('../relay.js');
const { startUpstream, sseFrame, writeSse, request, COLLAB_FUNCTION_CALL } = require('./helpers.js');

const AGENT_MESSAGE = {
  type: 'agent_message',
  id: 'amsg_1',
  author: '/root',
  recipient: '/root/probe',
  content: [
    { type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/probe\nSender: /root\nPayload:\n' },
    { type: 'encrypted_content', encrypted_content: 'ZXQ-TRACER payload: echo ECHO-ZXQ-TRACER' },
  ],
};

function requestBody(input) {
  return {
    model: 'test-model',
    input,
    tools: [{ type: 'function', name: 'spawn_agent' }],
    stream: true,
  };
}

async function startRelay(upstreamOrigin, options = {}) {
  const relay = createRelay({
    port: 0,
    origin: upstreamOrigin,
    hooks: options.hooks,
    log: options.log,
    capture: options.capture,
    name: 'test-relay',
  });
  await relay.listen();
  return relay;
}

async function withRelay(upstreamHandler, relayOptions, run) {
  const upstream = await startUpstream(upstreamHandler);
  const relay = await startRelay(upstream.origin, relayOptions);
  try {
    await run({ upstream, relay, port: relay.server.address().port });
  } finally {
    await relay.close();
    await upstream.close();
  }
}

const OKEchoJson = (req, res, record) => {
  const body = JSON.stringify({ received: record.json });
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};

// ------------------------------------------------------------------ 钩子 A

test('e2e A: 出站请求中的 agent_message 被降级，上游收到可读正文', async () => {
  await withRelay(OKEchoJson, { hooks: { A: true, B: false } }, async ({ upstream, port }) => {
    const res = await request(port, { body: requestBody([AGENT_MESSAGE]) });
    assert.equal(res.status, 200);

    const seen = upstream.requests[0];
    assert.equal(seen.url, '/responses');
    const item = seen.json.input[0];
    assert.deepEqual(item, {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text:
            'Message Type: NEW_TASK\nTask name: /root/probe\nSender: /root\nPayload:\n' +
            'ZXQ-TRACER payload: echo ECHO-ZXQ-TRACER',
        },
      ],
    });
    // 私有字段已剥离
    for (const key of ['id', 'author', 'recipient', 'internal_chat_message_metadata_passthrough']) {
      assert.ok(!(key in item), `${key} 应被剥离`);
    }
    // Content-Length 必须与实际改写后的字节数一致
    assert.equal(Number(seen.headers['content-length']), seen.body.length);
  });
});

test('e2e A: 多字节正文改写后 Content-Length 按字节计算', async () => {
  const item = {
    type: 'agent_message',
    content: [
      { type: 'input_text', text: 'Payload:\n' },
      { type: 'encrypted_content', encrypted_content: '中文·正文·emoji🙂' },
    ],
  };
  await withRelay(OKEchoJson, { hooks: { A: true, B: false } }, async ({ upstream, port }) => {
    await request(port, { body: requestBody([item]) });
    const seen = upstream.requests[0];
    assert.equal(seen.json.input[0].content[0].text, 'Payload:\n中文·正文·emoji🙂');
    assert.equal(Number(seen.headers['content-length']), Buffer.byteLength(JSON.stringify(seen.json)));
    assert.equal(Number(seen.headers['content-length']), seen.body.length);
  });
});

test('e2e A: 钩子关闭时请求体逐字节不变', async () => {
  await withRelay(OKEchoJson, { hooks: { A: false, B: false } }, async ({ upstream, port }) => {
    const payload = JSON.stringify(requestBody([AGENT_MESSAGE]));
    await request(port, { body: payload, headers: { 'content-type': 'application/json' } });
    assert.equal(upstream.requests[0].body.toString('utf8'), payload);
  });
});

test('e2e A: 坏 JSON 请求体原样透传（不制造坏请求）', async () => {
  await withRelay(OKEchoJson, { hooks: { A: true, B: false } }, async ({ upstream, port }) => {
    const payload = '{"model":"m","input":[{"type":"agent_message"';
    const res = await request(port, { body: payload, headers: { 'content-type': 'application/json' } });
    assert.equal(res.status, 200);
    assert.equal(upstream.requests[0].body.toString('utf8'), payload);
  });
});

test('e2e A: 带 Content-Encoding 的请求体不解析、原样透传', async () => {
  await withRelay(OKEchoJson, { hooks: { A: true, B: false } }, async ({ upstream, port }) => {
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(requestBody([AGENT_MESSAGE]))));
    await request(port, {
      body: gz,
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    });
    assert.ok(upstream.requests[0].body.equals(gz));
  });
});

// ------------------------------------------------------------------ 钩子 B

const SSE_HEAD_AND_TAIL = 'data: {"type":"response.created"}\n\n';

test('e2e B: SSE 命中帧被注入，客户端收到 encrypted_function_args: []', async () => {
  const handler = async (req, res) => {
    await writeSse(res, [
      SSE_HEAD_AND_TAIL,
      sseFrame('response.output_item.added', { item: COLLAB_FUNCTION_CALL, output_index: 0 }),
      sseFrame('response.output_item.done', { item: COLLAB_FUNCTION_CALL, output_index: 0 }),
      sseFrame('response.completed', { response: { usage: { input_tokens: 3 } } }),
    ]);
  };
  await withRelay(handler, { hooks: { A: true, B: true } }, async ({ relay, port }) => {
    const res = await request(port, { body: requestBody([]) });
    const frames = res.text.split('\n\n').filter(Boolean);
    const injected = frames.filter((f) => f.includes('"encrypted_function_args":[]'));
    assert.equal(injected.length, 2, res.text);
    assert.ok(res.text.startsWith(SSE_HEAD_AND_TAIL), '未命中的帧保持原样');
    assert.ok(res.text.includes('response.completed'));
    assert.equal(relay.counters.bInjections, 2);
  });
});

test('e2e B: 分片到达（含每块延迟）仍正确注入', async () => {
  const full = sseFrame('response.output_item.done', { item: COLLAB_FUNCTION_CALL, output_index: 0 });
  const handler = async (req, res) => {
    await writeSse(res, [full.slice(0, 20), full.slice(20, 60), full.slice(60)], { delayMs: 5 });
  };
  await withRelay(handler, { hooks: { A: false, B: true } }, async ({ port }) => {
    const res = await request(port, { body: requestBody([]) });
    assert.match(res.text, /"encrypted_function_args":\[\]/);
  });
});

test('e2e B: CRLF + event: 行的流', async () => {
  const handler = async (req, res, record) => {
    void record;
    const eol = '\r\n';
    const frame =
      `event: response.output_item.done${eol}` +
      `data: ${JSON.stringify({ type: 'response.output_item.done', item: COLLAB_FUNCTION_CALL })}${eol}${eol}`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(frame);
  };
  await withRelay(handler, { hooks: { A: false, B: true } }, async ({ port }) => {
    const res = await request(port, { body: requestBody([]) });
    assert.match(res.text, /"encrypted_function_args":\[\]/);
  });
});

test('e2e B: 上游响应被压缩时跳过注入、字节原样透传（A 不受影响）', async () => {
  const sse = Buffer.from(sseFrame('response.output_item.done', { item: COLLAB_FUNCTION_CALL }), 'utf8');
  const gz = zlib.gzipSync(sse);
  const handler = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' });
    res.end(gz);
  };
  await withRelay(handler, { hooks: { A: true, B: true } }, async ({ relay, port }) => {
    const res = await request(port, { body: requestBody([AGENT_MESSAGE]) });
    assert.ok(res.raw.equals(gz), '压缩流必须逐字节透传');
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.equal(relay.counters.bSkipped, 1);
    assert.equal(relay.counters.bInjections, 0);
    assert.equal(relay.counters.aRewrites, 1);
  });
});

test('e2e B: 非 SSE 响应（JSON 错误体）原样透传，含状态码', async () => {
  const errorBody = JSON.stringify({ error: { message: 'input.10: item type "agent_message" is not supported' } });
  const handler = (req, res) => {
    res.writeHead(400, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(errorBody) });
    res.end(errorBody);
  };
  await withRelay(handler, { hooks: { A: true, B: true } }, async ({ relay, port }) => {
    const res = await request(port, { body: requestBody([]) });
    assert.equal(res.status, 400);
    assert.equal(res.text, errorBody);
    assert.equal(relay.counters.errors, 0);
    assert.equal(relay.counters.bInjections, 0);
  });
});

// ------------------------------------------------------------------ 传输行为

test('转发强制 Accept-Encoding: identity（B 关闭时不加该头）', async () => {
  await withRelay(OKEchoJson, { hooks: { A: true, B: true } }, async ({ upstream, port }) => {
    await request(port, { body: requestBody([]) });
    assert.equal(upstream.requests[0].headers['accept-encoding'], 'identity');
  });
  await withRelay(OKEchoJson, { hooks: { A: true, B: false } }, async ({ upstream, port }) => {
    await request(port, { body: requestBody([]) });
    assert.equal(upstream.requests[0].headers['accept-encoding'], undefined);
  });
});

test('Authorization 与路径前缀原样转发', async () => {
  const upstream = await startUpstream(OKEchoJson);
  const relay = createRelay({ port: 0, origin: `${upstream.origin}/coding/v1`, hooks: { A: true, B: true } });
  await relay.listen();
  try {
    await request(relay.server.address().port, {
      path: '/responses',
      headers: { authorization: 'Bearer sk-test-1234567890' },
      body: requestBody([]),
    });
    assert.equal(upstream.requests[0].url, '/coding/v1/responses');
    assert.equal(upstream.requests[0].headers.authorization, 'Bearer sk-test-1234567890');
  } finally {
    await relay.close();
    await upstream.close();
  }
});

test('/healthz 返回 200 与计数，且不触上游、不计入流量', async () => {
  await withRelay(OKEchoJson, { hooks: { A: true, B: true } }, async ({ upstream, relay, port }) => {
    const before = await request(port, { path: '/healthz', method: 'GET' });
    assert.equal(before.status, 200);
    assert.equal(JSON.parse(before.text).status, 'ok');
    await request(port, { body: requestBody([AGENT_MESSAGE]) });
    const after = JSON.parse((await request(port, { path: '/healthz', method: 'GET' })).text);
    assert.equal(after.counters.a_rewrites, 1);
    assert.equal(upstream.requests.length, 1, 'healthz 不得触上游');
    assert.equal(relay.counters.requests, 1, '探活不应计入 requests（只统计数据面）');
  });
});

test('上游不可达时返回 502 JSON（不挂起、不破坏 Codex 的错误展示）', async () => {
  const upstream = await startUpstream(OKEchoJson);
  const origin = upstream.origin;
  await upstream.close();
  const relay = await startRelay(origin, { hooks: { A: true, B: true } });
  try {
    const res = await request(relay.server.address().port, { body: requestBody([]) });
    assert.equal(res.status, 502);
    assert.match(JSON.parse(res.text).error.message, /upstream request failed/);
    assert.equal(relay.counters.errors, 1);
  } finally {
    await relay.close();
  }
});

test('抓包：Authorization 脱敏落盘，正文与响应可选留痕', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-relay-cap-'));
  const handler = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sseFrame('response.output_item.done', { item: COLLAB_FUNCTION_CALL }));
  };
  const upstream = await startUpstream(handler);
  const relay = await startRelay(upstream.origin, { hooks: { A: true, B: true }, capture: createCapture(dir) });
  try {
    await request(relay.server.address().port, {
      headers: { authorization: 'Bearer sk-super-secret' },
      body: requestBody([AGENT_MESSAGE]),
    });
  } finally {
    // close() 会等待抓包落盘，保证随后读取到完整文件
    await relay.close();
    await upstream.close();
  }
  const reqCapture = JSON.parse(fs.readFileSync(path.join(dir, 'req-0001.json'), 'utf8'));
  assert.equal(reqCapture.headers.authorization, '<redacted>');
  assert.equal(reqCapture.body.input[0].type, 'message', '抓包记录的是改写后的出站形态');
  assert.ok(!JSON.stringify(reqCapture).includes('sk-super-secret'));
  const sse = fs.readFileSync(path.join(dir, 'res-0001.sse'), 'utf8');
  assert.match(sse, /"encrypted_function_args":\[\]/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ 中断归因

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('归因: Codex 收齐后主动断开记为 client_abort，不算故障', async () => {
  const handler = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sseFrame('response.created', {})); // 之后保持连接打开，等客户端断开
  };
  await withRelay(handler, { hooks: { A: true, B: true } }, async ({ relay, port }) => {
    await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/responses' }, (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.on('error', reject);
      req.end('{}');
    });
    await sleep(300);
    assert.equal(relay.counters.errors, 0, JSON.stringify(relay.counters.snapshot()));
    assert.equal(relay.counters.clientAborts, 1);
  });
});

test('归因: 收到 response.completed 后上游关闭连接记为 completed_abort，不算故障', async () => {
  const handler = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sseFrame('response.completed', { response: { usage: { input_tokens: 1 } } }));
    setTimeout(() => res.destroy(), 60); // 厂商在流结束后直接断连（实测 Kimi 行为）
  };
  await withRelay(handler, { hooks: { A: false, B: true } }, async ({ relay, port }) => {
    await request(port, { body: requestBody([]) }).catch(() => {});
    await sleep(300);
    assert.equal(relay.counters.errors, 0, JSON.stringify(relay.counters.snapshot()));
    assert.equal(relay.counters.completedAborts, 1);
  });
});

test('归因: 客户端中途放弃请求体只记一次 client_abort（请求流报错路径）', async () => {
  await withRelay(OKEchoJson, { hooks: { A: true, B: true } }, async ({ relay, port }) => {
    await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        // 声明 chunked 却只发一半就 RST：服务端 req 流报错（走 req.on('error') 分支）
        sock.write(
          'POST /responses HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n' +
            'Transfer-Encoding: chunked\r\n\r\nff\r\n{"partial":',
        );
        setTimeout(() => {
          sock.resetAndDestroy();
          resolve();
        }, 100);
      });
      sock.on('error', () => {});
    });
    await sleep(300);
    assert.equal(relay.counters.errors, 0, JSON.stringify(relay.counters.snapshot()));
    assert.equal(relay.counters.clientAborts, 1, '一次中断只能记一次');
    assert.equal(relay.counters.completedAborts, 0);
  });
});

test('归因: 上游中途断开且客户端仍在等 → 记为 error（真实故障）', async () => {
  const handler = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sseFrame('response.created', {}));
    setTimeout(() => res.destroy(), 60); // 未发 response.completed 就断连
  };
  await withRelay(handler, { hooks: { A: false, B: true } }, async ({ relay, port }) => {
    await request(port, { body: requestBody([]) }).catch(() => {});
    await sleep(300);
    assert.equal(relay.counters.errors, 1, JSON.stringify(relay.counters.snapshot()));
    assert.equal(relay.counters.completedAborts, 0);
  });
});

test('钩子 A 的改写结果与单测函数一致（回归锚点）', () => {
  const body = requestBody([structuredClone(AGENT_MESSAGE)]);
  assert.equal(rewriteAgentMessages(body), 1);
  assert.equal(body.input[0].content[0].text.split('Payload:\n')[1], 'ZXQ-TRACER payload: echo ECHO-ZXQ-TRACER');
});
