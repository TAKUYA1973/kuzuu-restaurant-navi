#!/usr/bin/env node
// 承認済みURL(data/photo-sources.json)にもとづいて店舗写真を取得し、
// images/ フォルダへ保存するスクリプト。
//
// 安全設計:
//   - data/photo-sources.json に url があり、かつ approved:true のエントリのみ処理する
//     (それ以外はすべて「スキップ」であり、ネットを検索して自動収集することはしない)
//   - PROTECTED_IDS (id:2 = Street Coffee とらべる) はこのファイルの内容に関係なく
//     常にスキップする(ハードコード。photo-sources.json 側の設定ミスでも上書きされない)
//   - ダウンロードは一時ファイルに書き込み、Content-Type とサイズを検証してから
//     images/<slug>.<ext> へ配置する。検証に失敗した場合は既存ファイルに一切手を出さない
//   - index.html は読み込みも書き込みもしない
//
// このスクリプトは images/ フォルダの中身しか変更しない。

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SOURCES_PATH = join(REPO_ROOT, 'data', 'photo-sources.json');
const IMAGES_DIR = join(REPO_ROOT, 'images');

// このIDは photo-sources.json に何が書かれていても常に除外する。
const HARD_PROTECTED_IDS = [2];

const ALLOWED_CONTENT_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const MIN_BYTES = 1024; // 1KB 未満は取得失敗(エラーページ等の疑い)とみなす
const MAX_BYTES = 10 * 1024 * 1024; // 10MB 超は異常として扱う
const FETCH_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function loadSources() {
  const raw = readFileSync(SOURCES_PATH, 'utf8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data.shops)) {
    throw new Error('photo-sources.json の shops が配列ではありません');
  }
  const protectedIds = new Set([...(data.protected_ids || []), ...HARD_PROTECTED_IDS]);
  return { shops: data.shops, protectedIds };
}

async function fetchWithRedirects(url, redirectsLeft) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': 'kuzuu-restaurant-navi-photo-fetch/1.0' },
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) throw new Error(`リダイレクト応答(${res.status})にLocationヘッダがありません`);
      if (redirectsLeft <= 0) throw new Error('リダイレクト回数が上限を超えました');
      return fetchWithRedirects(new URL(location, url).toString(), redirectsLeft - 1);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOne(entry) {
  const { id, name, slug, url } = entry;

  if (!SLUG_PATTERN.test(slug || '')) {
    return { id, name, status: 'failed', reason: `不正なslug: ${slug}` };
  }

  let res;
  try {
    res = await fetchWithRedirects(url, MAX_REDIRECTS);
  } catch (e) {
    return { id, name, status: 'failed', reason: `取得エラー: ${e.message}` };
  }

  if (!res.ok) {
    return { id, name, status: 'failed', reason: `HTTPエラー: ${res.status}` };
  }

  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ext = ALLOWED_CONTENT_TYPES[contentType];
  if (!ext) {
    return { id, name, status: 'failed', reason: `許可されていないContent-Type: ${contentType || '(なし)'}` };
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < MIN_BYTES) {
    return { id, name, status: 'failed', reason: `ファイルサイズが小さすぎます(${buf.length} bytes)` };
  }
  if (buf.length > MAX_BYTES) {
    return { id, name, status: 'failed', reason: `ファイルサイズが大きすぎます(${buf.length} bytes)` };
  }

  const finalPath = join(IMAGES_DIR, `${slug}.${ext}`);
  const tmpPath = join(IMAGES_DIR, `.tmp-${slug}-${Date.now()}.${ext}`);

  try {
    if (!existsSync(IMAGES_DIR)) mkdirSync(IMAGES_DIR, { recursive: true });
    writeFileSync(tmpPath, buf);
    renameSync(tmpPath, finalPath); // 検証済みバッファのみ最終配置。失敗時は既存ファイル無傷。
  } catch (e) {
    if (existsSync(tmpPath)) {
      try { unlinkSync(tmpPath); } catch { /* ignore cleanup failure */ }
    }
    return { id, name, status: 'failed', reason: `保存エラー: ${e.message}` };
  }

  return { id, name, status: 'success', path: `images/${slug}.${ext}`, bytes: buf.length };
}

async function main() {
  const { shops, protectedIds } = loadSources();
  const shopIdFilter = process.env.SHOP_ID_FILTER ? String(process.env.SHOP_ID_FILTER).trim() : '';

  const results = [];

  for (const entry of shops) {
    const { id, name } = entry;

    if (shopIdFilter && String(id) !== shopIdFilter) {
      results.push({ id, name, status: 'skipped', reason: 'shop_id指定によりスキップ' });
      continue;
    }
    if (protectedIds.has(id)) {
      results.push({ id, name, status: 'skipped', reason: '保護対象店舗のためスキップ(常時除外)' });
      continue;
    }
    if (!entry.url || !entry.url.trim()) {
      results.push({ id, name, status: 'skipped', reason: 'URL未登録' });
      continue;
    }
    if (entry.approved !== true) {
      results.push({ id, name, status: 'skipped', reason: '未承認(approved:false)のためスキップ' });
      continue;
    }
    if (!entry.url.startsWith('https://')) {
      results.push({ id, name, status: 'failed', reason: 'httpsのURLのみ許可されています' });
      continue;
    }

    console.log(`[fetch_photos] 取得開始: id=${id} name=${name} url=${entry.url}`);
    const result = await fetchOne(entry);
    console.log(`[fetch_photos] 結果: ${result.status} ${result.reason || result.path || ''}`);
    results.push(result);
  }

  console.log('\n=== 取得結果サマリ ===');
  for (const r of results) {
    console.log(`id=${r.id}\t${r.name}\t${r.status}\t${r.reason || r.path || ''}`);
  }

  const summaryPath = join(REPO_ROOT, 'photo-fetch-summary.json');
  writeFileSync(summaryPath, JSON.stringify(results, null, 2));
  console.log(`\nサマリを書き出しました: ${summaryPath}`);

  const failedCount = results.filter((r) => r.status === 'failed').length;
  if (failedCount > 0) {
    console.log(`(${failedCount}件の失敗がありますが、既存画像は変更していません。ジョブ自体は継続します)`);
  }
}

main().catch((e) => {
  console.error('[fetch_photos] 予期しないエラー:', e);
  process.exit(1);
});
