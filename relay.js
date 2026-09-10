#!/usr/bin/env node
'use strict';

/**
 * codex-relay — 本地重写代理，修复 Codex multi-agent v2 在第三方 Responses
 * 兼容端点上子代理消息不可读的问题。设计见 docs/plan.md。
 *
 *   node relay.js <port> <upstream-origin> [--host 127.0.0.1] [--name <label>]
 *
 * 钩子 A（请求侧）：input[] 中的 agent_message → 可读的 message(user)。
 * 钩子 B（响应侧）：SSE 中 collaboration function_call 注入 encrypted_function_args: []。
 *
 * 任何解析/改写失败一律原样透传。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Transform, PassThrough } = require('stream');
const { StringDecoder } = require('string_decoder');
const { URL } = require('url');

// ------------------------------------------------------------------ 常量

const COLLAB_TOOLS = new Set(['spawn_agent', 'send_message', 'followup_task']);
const SSE_EVENT_ITEM = new Set(['response.output_item.added', 'response.output_item.done']);

// {encrypted_function_args: []} 是 Codex 判定"明文直发"的标记，官方端点才会返回；
// 第三方端点从不返回，导致正文走 encrypted_content 槽位（见 plan §1.3）。
const DIRECT_PLAINTEXT_MARKER = Object.freeze([]);

// 单个 SSE 帧的缓冲上限：超过即视为异常流，剩余数据原样透传，避免无界增长。
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const SENSITIVE_HEADER = /^(authorization|proxy-authorization|api-key|x-api-key|cookie|set-cookie)$/i;

// ------------------------------------------------------------------ 钩子 A

/**
 * 把输入项里的 agent_message 降级为普通 user 消息：
 * 信封与 payload 拼接为纯文本，剥离 Codex 私有字段。
 * 拼接结果为空则保持原样（避免向严格端点制造空 user 消息）。
 * 返回改写条数。
 */
function rewriteAgentMessages(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.input)) return 0;
  let rewritten = 0;
  for (const item of body.input) {
    if (!item || typeof item !== 'object' || item.type !== 'agent_message') continue;
    const text = agentMessageText(item);
    if (!text) continue;
    for (const key of Object.keys(item)) delete item[key];
    Object.assign(item, {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    });
    rewritten += 1;
  }
  return rewritten;
}

function agentMessageText(item) {
  if (!Array.isArray(item.content)) return '';
  const parts = [];
  for (const part of item.content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'encrypted_content' && typeof part.encrypted_content === 'string') {
      parts.push(part.encrypted_content);
    } else if (typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.join('');
}

// ------------------------------------------------------------------ 钩子 B

/**
 * 对单个 SSE 帧注入明文标记。无法解析或无需改写时返回 null（调用方原样透传）。
 */
function patchSseFrame(frame) {
  const lines = frame.split(/\r?\n/);
  const dataLines = lines.filter((line) => line.startsWith('data:'));
  if (dataLines.length === 0) return null;

  // 与 eventsource_stream 语义对齐：多行 data 以 \n 拼接。
  const data = dataLines.map((line) => line.replace(/^data:[ ]?/, '')).join('\n');
  if (!data) return null;

  let event;
  try {
    event = JSON.parse(data);
  } catch {
    return null;
  }
  if (!event || typeof event !== 'object' || !SSE_EVENT_ITEM.has(event.type)) return null;

  const item = event.item;
  if (!item || item.type !== 'function_call') return null;
  if (item.namespace !== 'collaboration' || !COLLAB_TOOLS.has(item.name)) return null;
  if (Array.isArray(item.encrypted_function_args)) return null; // 已有标记（幂等）

  item.encrypted_function_args = [...DIRECT_PLAINTEXT_MARKER];
  // 事件类型取自 data JSON 的 type 字段；event: 行 Codex 不消费，无需保留。
  return 'data: ' + JSON.stringify(event) + '\n\n';
}

/**
 * 流式分帧器：按空行切帧（兼容 CRLF），跨 chunk 缓冲，帧内多行 data 拼接后改写。
 * 流末尾未成帧的剩余数据原样冲出。
 * onCompleted 用于识别 response.completed（流正常结束的标志，供中断归因使用）。
 */
function createSsePatcher({ onInject, onMalformed, onCompleted } = {}) {
  const decoder = new StringDecoder('utf8');
  const COMPLETED = /"type"\s*:\s*"response\.completed"/;
  let buf = '';

  function flushFrames(push) {
    let match;
    while ((match = /\r?\n\r?\n/.exec(buf))) {
      const frame = buf.slice(0, match.index);
      const separator = match[0];
      buf = buf.slice(match.index + separator.length);
      if (onCompleted && COMPLETED.test(frame)) onCompleted();
      let out = null;
      try {
        out = patchSseFrame(frame);
      } catch (err) {
        if (onMalformed) onMalformed(err);
        out = null;
      }
      if (out !== null) {
        if (onInject) onInject();
        push(out);
      } else {
        push(frame + separator);
      }
    }
  }

  return new Transform({
    decodeStrings: false,
    transform(chunk, _enc, callback) {
      buf += decoder.write(chunk);
      flushFrames((data) => this.push(data));
      if (buf.length > MAX_FRAME_BYTES) {
        this.push(buf);
        buf = '';
      }
      callback();
    },
    flush(callback) {
      buf += decoder.end();
      if (buf) {
        this.push(buf);
        buf = '';
      }
      callback();
    },
  });
}

// ------------------------------------------------------------------ 工具

function parseHooks(raw) {
  const set = new Set(
    String(raw === undefined || raw === '' ? 'A,B' : raw)
      .split(/[,\s]+/)
      .map((token) => token.trim().toUpperCase())
      .filter(Boolean),
  );
  return { A: set.has('A'), B: set.has('B') };
}

function redactHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADER.test(key) ? '<redacted>' : value;
  }
  return out;
}

function stripHopByHop(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

class Counters {
  constructor() {
    this.requests = 0;
    this.aRewrites = 0;
    this.bInjections = 0;
    this.bSkipped = 0; // 因响应压缩或钩子关闭而未注入
    this.errors = 0; // 客户端仍在等而上游失败（真实故障）
    this.clientAborts = 0; // Codex 主动断开（正常取消）
    this.completedAborts = 0; // 收到 response.completed 后厂商关闭连接（正常）
  }

  snapshot() {
    return {
      requests: this.requests,
      a_rewrites: this.aRewrites,
      b_injections: this.bInjections,
      b_skipped: this.bSkipped,
      errors: this.errors,
      client_aborts: this.clientAborts,
      completed_aborts: this.completedAborts,
    };
  }
}

// ------------------------------------------------------------------ 代理

function buildTarget(origin, requestUrl) {
  const base = new URL(origin);
  const queryAt = requestUrl.indexOf('?');
  const requestPath = queryAt === -1 ? requestUrl : requestUrl.slice(0, queryAt);
  const prefix = base.pathname.replace(/\/+$/, '');
  base.pathname = prefix + (requestPath.startsWith('/') ? requestPath : '/' + requestPath);
  base.search = queryAt === -1 ? '' : requestUrl.slice(queryAt);
  return base;
}

function createRelay(options) {
  const { port, origin, host = '127.0.0.1', name = `relay:${port}` } = options;
  const hooks = options.hooks || { A: true, B: true };
  const log = options.log || (() => {});
  const capture = options.capture || null;
  const counters = new Counters();

  const base = new URL(origin);
  const agent = new (base.protocol === 'https:' ? https.Agent : http.Agent)({
    keepAlive: true,
    maxSockets: 64,
  });

  const transport = base.protocol === 'https:' ? https : http;

  const server = http.createServer((req, res) => {
    const started = Date.now();
    counters.requests += 1;
    const seq = capture ? capture.next() : 0;

    if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/healthz/')) {
      const body = JSON.stringify({
        status: 'ok',
        name,
        upstream: origin,
        hooks,
        counters: counters.snapshot(),
      });
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }

    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
    });
    req.on('error', () => {
      counters.clientAborts += 1;
      res.destroy();
    });
    req.on('end', () => {
      let body = chunks.length ? Buffer.concat(chunks) : null;
      const headers = stripHopByHop(req.headers);
      delete headers.host;
      delete headers['content-length'];

      if (hooks.B) {
        // 服务器若忽略 identity 仍压缩响应，该连接跳过注入（见下方响应处理）。
        headers['accept-encoding'] = 'identity';
      } else {
        delete headers['accept-encoding'];
      }

      let aRewrites = 0;
      const requestEncoding = String(req.headers['content-encoding'] || '').toLowerCase();
      const looksJson = /json/i.test(String(req.headers['content-type'] || ''));
      if (hooks.A && body && !requestEncoding && size > 0 && (looksJson || body[0] === 0x7b)) {
        try {
          const parsed = JSON.parse(body.toString('utf8'));
          aRewrites = rewriteAgentMessages(parsed);
          if (aRewrites > 0) {
            body = Buffer.from(JSON.stringify(parsed), 'utf8');
            counters.aRewrites += aRewrites;
          }
        } catch {
          aRewrites = 0; // 解析失败：原样透传
        }
      }
      if (body) headers['content-length'] = String(body.length);

      if (capture) capture.request(seq, req, headers, body);

      const target = buildTarget(origin, req.url);
      const ctx = { seq, started, aRewrites, clientGone: false, completed: false, abortCounted: false };
      const upstreamReq = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          method: req.method,
          path: target.pathname + target.search,
          headers,
          agent,
        },
        (upstreamRes) => {
          handleResponse(upstreamRes, res, ctx);
        },
      );

      upstreamReq.on('error', (err) => {
        const kind = classifyAbort(ctx);
        if (kind === 'error') {
          counters.errors += 1;
          log(`#${seq || '-'} upstream request failed: ${err.message}`);
        }
        if (!res.headersSent && kind === 'error') {
          const payload = JSON.stringify({
            error: { message: `codex-relay: upstream request failed: ${err.message}`, type: 'relay_error' },
          });
          res.writeHead(502, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
          res.end(payload);
        } else if (!res.writableEnded) {
          res.destroy();
        }
      });

      res.on('close', () => {
        if (!res.writableEnded) {
          ctx.clientGone = true;
          upstreamReq.destroy();
        }
      });

      if (body) upstreamReq.end(body);
      else upstreamReq.end();
    });
  });

  /**
   * 区分"连接中断"的性质：Codex 主动取消（收齐即断开）与上游在流结束后关闭连接
   * 都是正常现象，只有客户端仍在等而流断了才算失败（N2：不把正常行为记成故障）。
   */
  function classifyAbort(ctx) {
    if (ctx.abortCounted) return 'counted';
    ctx.abortCounted = true;
    if (ctx.completed) {
      counters.completedAborts += 1;
      return 'after-completed';
    }
    if (ctx.clientGone) {
      counters.clientAborts += 1;
      return 'client-gone';
    }
    return 'error';
  }

  function handleResponse(upstreamRes, res, ctx) {
    const headers = stripHopByHop(upstreamRes.headers);
    const status = upstreamRes.statusCode || 502;
    const contentType = String(headers['content-type'] || '');
    const contentEncoding = String(headers['content-encoding'] || '').toLowerCase();
    const isSse = /text\/event-stream/i.test(contentType);

    const injectable = hooks.B && isSse && (contentEncoding === '' || contentEncoding === 'identity');
    if (hooks.B && isSse && !injectable) {
      counters.bSkipped += 1;
      log(`#${ctx.seq} hook B skipped: content-encoding=${contentEncoding}`);
    }

    const finish = () => {
      const suffix = ctx.aRewrites ? ` A=${ctx.aRewrites}` : '';
      log(`#${ctx.seq} ${status} ${Date.now() - ctx.started}ms${suffix} ${JSON.stringify(counters.snapshot())}`);
    };

    if (!injectable) {
      res.writeHead(status, headers);
      upstreamRes.pipe(res);
      upstreamRes.on('end', finish);
      upstreamRes.on('error', (err) => {
        const kind = classifyAbort(ctx);
        if (kind === 'error') {
          counters.errors += 1;
          log(`#${ctx.seq} response stream failed: ${err.message}`);
        }
        if (!res.writableEnded) res.destroy();
      });
      return;
    }

    delete headers['content-length']; // 注入会改变帧长度
    delete headers['content-md5'];
    res.writeHead(status, headers);

    let injected = 0;
    const patcher = createSsePatcher({
      onInject: () => {
        injected += 1;
        counters.bInjections += 1;
      },
      onMalformed: (err) => log(`#${ctx.seq} hook B frame parse error (passthrough): ${err.message}`),
      onCompleted: () => {
        ctx.completed = true;
      },
    });

    // 抓包旁路：Patcher 的输出（= Codex 实际收到的帧）经 PassThrough 落盘。
    const captureStream = capture ? capture.sseStream(ctx.seq) : null;
    let captureSink = null;
    if (captureStream) {
      captureSink = new PassThrough();
      captureSink.on('error', () => {});
      captureStream.on('error', () => {});
      captureSink.pipe(captureStream);
      patcher.pipe(captureSink);
    }

    upstreamRes.on('error', (err) => {
      const kind = classifyAbort(ctx);
      if (kind === 'error') {
        counters.errors += 1;
        log(`#${ctx.seq} response stream failed: ${err.message}`);
      }
      if (!res.writableEnded) res.destroy();
    });
    upstreamRes.on('end', () => {
      if (injected > 0 || ctx.aRewrites > 0) {
        log(`#${ctx.seq} injected B=${injected}`);
      }
      finish();
    });

    patcher.pipe(res);
    upstreamRes.pipe(patcher);
  }

  return {
    server,
    counters,
    host,
    port,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve(server.address());
        });
      });
    },
    close() {
      return Promise.resolve()
        .then(() => (capture && capture.whenIdle ? capture.whenIdle() : undefined))
        .then(
          () =>
            new Promise((resolve) => {
              server.close(() => {
                agent.destroy();
                resolve();
              });
              server.closeAllConnections?.();
            }),
        );
    },
  };
}

// ------------------------------------------------------------------ 抓包

function createCapture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  let seq = 0;
  const open = new Set();
  const pad = (n) => String(n).padStart(4, '0');
  return {
    next() {
      seq += 1;
      return seq;
    },
    request(n, req, headers, body) {
      const record = {
        n,
        time: new Date().toISOString(),
        method: req.method,
        path: req.url,
        headers: redactHeaders(headers),
        bodyLen: body ? body.length : 0,
        body: null,
      };
      if (body) {
        try {
          record.body = JSON.parse(body.toString('utf8'));
        } catch {
          record.body = body.toString('utf8').slice(0, 4000);
        }
      }
      writeFile(path.join(dir, `req-${pad(n)}.json`), JSON.stringify(record, null, 2));
    },
    sseStream(n) {
      const stream = fs.createWriteStream(path.join(dir, `res-${pad(n)}.sse`));
      open.add(stream);
      stream.on('close', () => open.delete(stream));
      return stream;
    },
    /** 等待所有响应抓包落盘（供测试与优雅退出使用）。 */
    whenIdle() {
      return Promise.all(
        [...open].map(
          (stream) => new Promise((resolve) => (stream.closed ? resolve() : stream.on('close', resolve))),
        ),
      );
    },
  };
}

function writeFile(target, contents) {
  try {
    fs.writeFileSync(target, contents);
  } catch {
    /* 抓包失败不影响转发 */
  }
}

// ------------------------------------------------------------------ 启动

function usage() {
  return [
    'usage: node relay.js <port> <upstream-origin> [--host 127.0.0.1] [--name <label>]',
    '',
    '  port             listen port on the loopback interface',
    '  upstream-origin  e.g. https://api.deepseek.com (path prefix is preserved)',
    '',
    'env:',
    '  CODEX_RELAY_HOOKS=A,B     hooks to enable (default A,B)',
    '  CODEX_RELAY_LOG=1         print per-request rewrite counters',
    '  CODEX_RELAY_CAPTURE=<dir> capture requests/responses (Authorization redacted)',
  ].join('\n');
}

function main(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--host') opts.host = argv[++i];
    else if (arg === '--name') opts.name = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      return 0;
    } else if (arg.startsWith('--')) {
      console.error(`codex-relay: unknown option ${arg}\n\n${usage()}`);
      return 2;
    } else positional.push(arg);
  }

  const port = Number.parseInt(positional[0], 10);
  const origin = positional[1];
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`codex-relay: invalid port "${positional[0]}"\n\n${usage()}`);
    return 2;
  }
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    console.error(`codex-relay: invalid upstream origin "${origin}"\n\n${usage()}`);
    return 2;
  }
  if (parsedOrigin.protocol !== 'https:' && parsedOrigin.protocol !== 'http:') {
    console.error('codex-relay: upstream must be http(s)');
    return 2;
  }

  const hooks = parseHooks(process.env.CODEX_RELAY_HOOKS);
  const wantLog = process.env.CODEX_RELAY_LOG === '1' || process.env.CODEX_RELAY_LOG === 'true';
  const captureDir = process.env.CODEX_RELAY_CAPTURE;
  const name = opts.name || `relay:${port}`;
  const logPrefix = `[${name}]`;
  const log = wantLog ? (...args) => console.log(logPrefix, ...args) : () => {};

  const relay = createRelay({
    port,
    origin: parsedOrigin.origin + parsedOrigin.pathname.replace(/\/+$/, ''),
    host: opts.host,
    name,
    hooks,
    log,
    capture: captureDir ? createCapture(captureDir) : null,
  });

  relay
    .listen()
    .then((address) => {
      const enabled = [hooks.A ? 'A' : null, hooks.B ? 'B' : null].filter(Boolean).join(',') || 'none';
      console.log(
        `${logPrefix} listening on http://${address.address}:${address.port} → ${parsedOrigin.origin} ` +
          `(hooks: ${enabled}${captureDir ? `, capture: ${captureDir}` : ''})`,
      );
    })
    .catch((err) => {
      console.error(`${logPrefix} failed to listen: ${err.message}`);
      process.exit(1);
    });

  const shutdown = () => {
    console.log(`${logPrefix} shutting down`);
    relay.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  rewriteAgentMessages,
  agentMessageText,
  patchSseFrame,
  createSsePatcher,
  createRelay,
  createCapture,
  parseHooks,
  buildTarget,
  stripHopByHop,
  redactHeaders,
  COLLAB_TOOLS,
  MAX_FRAME_BYTES,
};
