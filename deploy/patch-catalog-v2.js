#!/usr/bin/env node
'use strict';

/**
 * 给模型目录（models.json）里的指定模型补上 "multi_agent_version": "v2"。
 *
 * 为什么需要：v2 是 subagents 工具面的开关。未标 v2 的模型会落 v1 —— v1 请求带
 * tool_search 工具面，而 GLM / Kimi 等端点在 v1 下每请求 400 或模型不会用它发现工具
 * （见 docs/plan.md §3.1）。DeepSeek / Kimi 的目录已自带该字段，GLM 实测缺失。
 *
 * 用法：
 *   node deploy/patch-catalog-v2.js <models.json> [slug ...]        # 预览
 *   node deploy/patch-catalog-v2.js <models.json> [slug ...] --apply # 写入（自动备份）
 *
 * 不指定 slug 时，处理目录中所有缺少该字段的模型。改写保留文件其余内容与原有 BOM，
 * 写入前校验仍是合法 JSON。
 */

const fs = require('fs');

function main(argv) {
  const apply = argv.includes('--apply');
  const positional = argv.filter((arg) => arg !== '--apply');
  const [catalogPath, ...slugs] = positional;
  if (!catalogPath) {
    console.error('usage: node deploy/patch-catalog-v2.js <models.json> [slug ...] [--apply]');
    return 2;
  }

  const raw = fs.readFileSync(catalogPath);
  const hadBom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  let text = (hadBom ? raw.subarray(3) : raw).toString('utf8');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error(`目录不是合法 JSON，放弃（未做任何修改）：${err.message}`);
    return 1;
  }
  const models = Array.isArray(parsed.models) ? parsed.models : null;
  if (!models) {
    console.error('目录里没有 models 数组，放弃（未做任何修改）');
    return 1;
  }

  const targets = slugList(models, slugs);
  if (targets.length === 0) {
    console.log('没有需要处理的模型（全部已带 multi_agent_version 或 slug 不存在）');
    return 0;
  }

  for (const slug of targets) {
    const pattern = new RegExp('"slug"\\s*:\\s*"' + slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"');
    const match = pattern.exec(text);
    if (!match) {
      console.log(`${slug}: 文本中找不到，跳过`);
      continue;
    }
    let at = match.index + match[0].length;
    if (text[at] === ',') at += 1; // 插在同级字段之间
    text = text.slice(0, at) + '\n    "multi_agent_version": "v2",' + text.slice(at);
    console.log(`${slug}: 补 multi_agent_version=v2`);
  }

  try {
    JSON.parse(text);
  } catch (err) {
    console.error(`改写后不是合法 JSON，放弃写入：${err.message}`);
    return 1;
  }

  if (!apply) {
    console.log('\n预览完成（未写入）。加 --apply 实际写入。');
    return 0;
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  fs.writeFileSync(`${catalogPath}.bak-${stamp}`, raw);
  fs.writeFileSync(catalogPath, Buffer.concat([hadBom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(text, 'utf8')]));
  console.log(`\n已写入 ${catalogPath}（备份 ${catalogPath}.bak-${stamp}）`);
  return 0;
}

function slugList(models, requested) {
  const missing = models.filter((m) => m && typeof m.slug === 'string' && !('multi_agent_version' in m)).map((m) => m.slug);
  if (requested.length === 0) return missing;
  return requested.filter((slug) => missing.includes(slug) || logSkip(models, slug));
}

function logSkip(models, slug) {
  const model = models.find((m) => m && m.slug === slug);
  if (!model) console.log(`${slug}: 目录中不存在，跳过`);
  else if ('multi_agent_version' in model) console.log(`${slug}: 已有 multi_agent_version=${model.multi_agent_version}，跳过`);
  return false;
}

process.exitCode = main(process.argv.slice(2));
