'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  rewriteAgentMessages,
  agentMessageText,
  patchSseFrame,
  createSsePatcher,
  parseHooks,
  buildTarget,
  stripHopByHop,
  redactHeaders,
} = require('../relay.js');

const { COLLAB_FUNCTION_CALL } = require('./helpers.js');

// 抓包实证形态（_investigation/captures-a/req-0002.json）：
// 信封在上，正文原样躺在 encrypted_content 槽位里。
function agentMessageItem(overrides = {}) {
  return {
    type: 'agent_message',
    id: 'amsg_01a08aac-3a1a-7b31-959a-5f957ac29695',
    author: '/root',
    recipient: '/root/probe',
    content: [
      {
        type: 'input_text',
        text: 'Message Type: NEW_TASK\nTask name: /root/probe\nSender: /root\nPayload:\n',
      },
      {
        type: 'encrypted_content',
        encrypted_content: 'ZXQ-7742-TRACER payload: reply with exactly ECHO-ZXQ-7742-TRACER',
      },
    ],
    ...overrides,
  };
}

const EXPECTED_TEXT =
  'Message Type: NEW_TASK\nTask name: /root/probe\nSender: /root\nPayload:\n' +
  'ZXQ-7742-TRACER payload: reply with exactly ECHO-ZXQ-7742-TRACER';

test('hook A: agent_message 降级为可读 message(user)', () => {
  const body = { model: 'm', input: [agentMessageItem()] };
  assert.equal(rewriteAgentMessages(body), 1);
  assert.deepEqual(body.input[0], {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: EXPECTED_TEXT }],
  });
});

test('hook A: 改写后的文本与 Codex 明文路径 InterAgentMessage::render() 完全一致', () => {
  // render() = "Message Type: {TYPE}\nTask name: {recipient}\nSender: {author}\nPayload:\n{payload}"
  const item = agentMessageItem();
  assert.equal(agentMessageText(item), EXPECTED_TEXT);
});

test('hook A: 空正文原样透传', () => {
  const item = agentMessageItem({ content: [{ type: 'input_text', text: '' }] });
  const body = { input: [item] };
  assert.equal(rewriteAgentMessages(body), 0);
  assert.equal(body.input[0].type, 'agent_message');
});

test('hook A: content 缺失/非数组原样透传', () => {
  const body = { input: [{ type: 'agent_message' }, { type: 'agent_message', content: 'x' }] };
  assert.equal(rewriteAgentMessages(body), 0);
  assert.equal(body.input[0].type, 'agent_message');
  assert.equal(body.input[1].type, 'agent_message');
});

test('hook A: 已明文（output_text 形态）的 agent_message 同样降级', () => {
  const item = agentMessageItem({ content: [{ type: 'output_text', text: 'Message Type: MESSAGE\nPayload:\nhi' }] });
  const body = { input: [item] };
  assert.equal(rewriteAgentMessages(body), 1);
  assert.equal(body.input[0].role, 'user');
  assert.equal(body.input[0].content[0].text, 'Message Type: MESSAGE\nPayload:\nhi');
});

test('hook A: 只碰顶层 input[] 的 agent_message，其它 item 不动', () => {
  const reasoning = { type: 'reasoning', encrypted_content: 'keep-me' };
  const message = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] };
  const call = { type: 'function_call', name: 'spawn_agent', arguments: '{}', call_id: 'c' };
  const body = {
    input: [message, reasoning, agentMessageItem(), call],
    tools: [{ type: 'function', name: 'spawn_agent' }],
  };
  assert.equal(rewriteAgentMessages(body), 1);
  assert.deepEqual(body.input[1], reasoning);
  assert.deepEqual(body.input[3], call);
  assert.equal(body.tools[0].name, 'spawn_agent');
});

test('hook A: 无 input 字段不抛错', () => {
  assert.equal(rewriteAgentMessages({ model: 'm' }), 0);
  assert.equal(rewriteAgentMessages(null), 0);
  assert.equal(rewriteAgentMessages({ input: 'not-an-array' }), 0);
});

test('hook A: 多条 agent_message 全部改写并计数', () => {
  const body = { input: [agentMessageItem(), agentMessageItem(), agentMessageItem()] };
  assert.equal(rewriteAgentMessages(body), 3);
  for (const item of body.input) assert.equal(item.type, 'message');
});

// ------------------------------------------------------------------ 钩子 B

function frameFor(type, item) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, item, output_index: 0 })}\n\n`;
}

test('hook B: added/done 的 collaboration function_call 注入明文标记', () => {
  for (const type of ['response.output_item.added', 'response.output_item.done']) {
    const out = patchSseFrame(frameFor(type, COLLAB_FUNCTION_CALL));
    assert.ok(out, `${type} 应被改写`);
    const parsed = JSON.parse(out.replace(/^data: /, '').trim());
    assert.deepEqual(parsed.item.encrypted_function_args, []);
    assert.equal(parsed.item.call_id, 'call_1');
    assert.equal(parsed.item.arguments, COLLAB_FUNCTION_CALL.arguments);
    assert.ok(out.endsWith('\n\n'));
  }
});

test('hook B: send_message / followup_task 同样注入', () => {
  for (const name of ['send_message', 'followup_task']) {
    const out = patchSseFrame(frameFor('response.output_item.done', { ...COLLAB_FUNCTION_CALL, name }));
    assert.ok(out, `${name} 应被改写`);
  }
});

test('hook B: 非 collab 工具/命名空间/事件类型一律不碰', () => {
  const cases = [
    frameFor('response.output_item.done', { ...COLLAB_FUNCTION_CALL, name: 'wait_agent' }),
    frameFor('response.output_item.done', { ...COLLAB_FUNCTION_CALL, namespace: 'shell' }),
    frameFor('response.output_item.done', { ...COLLAB_FUNCTION_CALL, namespace: undefined }),
    frameFor('response.output_item.done', { type: 'message', role: 'assistant', content: [] }),
    frameFor('response.output_text.delta', { delta: 'hi' }),
    frameFor('response.completed', { response: { usage: { input_tokens: 1 } } }),
  ];
  for (const frame of cases) assert.equal(patchSseFrame(frame), null, frame.slice(0, 60));
});

test('hook B: 注入幂等（已有 encrypted_function_args 不再改写）', () => {
  const item = { ...COLLAB_FUNCTION_CALL, encrypted_function_args: [] };
  assert.equal(patchSseFrame(frameFor('response.output_item.done', item)), null);
  const item2 = { ...COLLAB_FUNCTION_CALL, encrypted_function_args: ['abc'] };
  assert.equal(patchSseFrame(frameFor('response.output_item.done', item2)), null);
});

test('hook B: 坏 JSON / 非 data 帧 / 空帧原样透传', () => {
  assert.equal(patchSseFrame('data: {not json'), null);
  assert.equal(patchSseFrame(': keep-alive comment'), null);
  assert.equal(patchSseFrame(''), null);
  assert.equal(patchSseFrame('data: null'), null);
  assert.equal(patchSseFrame('data: [1,2,3]'), null);
});

test('hook B: 多行 data 拼接后解析（eventsource_stream 语义）', () => {
  const obj = { type: 'response.output_item.done', item: COLLAB_FUNCTION_CALL };
  const json = JSON.stringify(obj);
  const split = Math.floor(json.length / 2);
  const frame = `data: ${json.slice(0, split)}\ndata: ${json.slice(split)}\n\n`;
  // \n 落在 JSON 字符串内部时无效，但落在结构间隙时是合法 JSON——两种都由 JSON.parse 决定。
  const out = patchSseFrame(frame);
  assert.ok(out === null || JSON.parse(out.replace(/^data: /, '').trim()).item.encrypted_function_args.length === 0);
});

test('hook B: CRLF 分隔的帧正常处理', () => {
  const obj = { type: 'response.output_item.done', item: COLLAB_FUNCTION_CALL };
  const frame = `event: response.output_item.done\r\ndata: ${JSON.stringify(obj)}\r\n\r\n`;
  const out = patchSseFrame(frame);
  assert.ok(out);
  assert.equal(JSON.parse(out.replace(/^data: /, '')).item.encrypted_function_args.length, 0);
});

// ------------------------------------------------- 分帧器（跨 chunk / 多字节）

async function runPatcher(inputs, onInject = () => {}) {
  const patcher = createSsePatcher({ onInject });
  const out = [];
  patcher.on('data', (chunk) => out.push(Buffer.from(chunk)));
  const done = new Promise((resolve, reject) => {
    patcher.on('end', resolve);
    patcher.on('error', reject);
  });
  for (const input of inputs) patcher.write(input);
  patcher.end();
  await done;
  return Buffer.concat(out).toString('utf8');
}

const PLAIN_FRAME = frameFor('response.output_item.done', { type: 'message', role: 'assistant', content: [] });
const COLLAB_FRAME = frameFor('response.output_item.done', COLLAB_FUNCTION_CALL);
const DELTA_FRAME = frameFor('response.output_text.delta', { delta: '中文多字节字符测试' });

test('分帧器: 任意字节边界切分都得到同一结果（含多字节字符跨界）', async () => {
  const payload = Buffer.from(PLAIN_FRAME + DELTA_FRAME + COLLAB_FRAME, 'utf8');
  const expected = await runPatcher([payload]);
  assert.ok(expected.includes('"encrypted_function_args":[]'));
  assert.ok(expected.includes('中文多字节字符测试'));
  for (let i = 0; i <= payload.length; i += 1) {
    const got = await runPatcher([payload.subarray(0, i), payload.subarray(i)]);
    assert.equal(got, expected, `split at byte ${i}`);
  }
});

test('分帧器: 逐字节喂入（最坏分片）结果不变', async () => {
  const payload = Buffer.from(PLAIN_FRAME + COLLAB_FRAME, 'utf8');
  const expected = await runPatcher([payload]);
  const got = await runPatcher([...payload].map((b) => Buffer.from([b])));
  assert.equal(got, expected);
});

test('分帧器: 注入计数正确、非目标帧原样输出', async () => {
  let injected = 0;
  const got = await runPatcher([Buffer.from(PLAIN_FRAME + COLLAB_FRAME, 'utf8')], () => {
    injected += 1;
  });
  assert.equal(injected, 1);
  assert.ok(got.startsWith(PLAIN_FRAME));
});

test('分帧器: 流末尾未成帧的残余数据原样冲出', async () => {
  const partial = 'data: {"type":"response.output_item.do';
  const got = await runPatcher([Buffer.from(PLAIN_FRAME + partial, 'utf8')]);
  assert.equal(got, PLAIN_FRAME + partial);
});

test('分帧器: CRLF 流不被改写为 LF（未命中的帧逐字节保持）', async () => {
  const crlf = PLAIN_FRAME.replace(/\n/g, '\r\n');
  const got = await runPatcher([Buffer.from(crlf, 'utf8')]);
  assert.equal(got, crlf);
});

// ------------------------------------------------------------------ 其它

test('parseHooks: 默认 A,B，可单独关闭', () => {
  assert.deepEqual(parseHooks(undefined), { A: true, B: true });
  assert.deepEqual(parseHooks(''), { A: true, B: true });
  assert.deepEqual(parseHooks('A'), { A: true, B: false });
  assert.deepEqual(parseHooks('b'), { A: false, B: true });
  assert.deepEqual(parseHooks('a, b'), { A: true, B: true });
  assert.deepEqual(parseHooks('none'), { A: false, B: false });
});

test('buildTarget: 保留 base_url 路径前缀与查询串', () => {
  assert.equal(buildTarget('https://api.deepseek.com', '/responses').href, 'https://api.deepseek.com/responses');
  assert.equal(
    buildTarget('https://open.bigmodel.cn/api/v1', '/responses?x=1').href,
    'https://open.bigmodel.cn/api/v1/responses?x=1',
  );
  assert.equal(
    buildTarget('https://api.kimi.com/coding/v1/', '/responses').href,
    'https://api.kimi.com/coding/v1/responses',
  );
});

test('stripHopByHop / redactHeaders', () => {
  const headers = {
    connection: 'keep-alive',
    'transfer-encoding': 'chunked',
    'content-type': 'application/json',
    authorization: 'Bearer sk-secret-value',
    'x-api-key': 'sk-other',
  };
  const stripped = stripHopByHop(headers);
  assert.deepEqual(Object.keys(stripped).sort(), ['authorization', 'content-type', 'x-api-key']);
  const redacted = redactHeaders(headers);
  assert.equal(redacted.authorization, '<redacted>');
  assert.equal(redacted['x-api-key'], '<redacted>');
  assert.equal(redacted['content-type'], 'application/json');
});
