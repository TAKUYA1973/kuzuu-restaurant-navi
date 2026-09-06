#!/usr/bin/env node
// index.html の shops データが想定どおりであることを検証するガードスクリプト。
// 画像取得ワークフローの前後、および将来 index.html への自動反映を実装する際の
// 安全チェックとして共通利用する。
//
// 検証内容:
//   1. index.html の const shops=[...] が正しく解析できる(JS構文が壊れていない)
//   2. 店舗数が期待値(22)と一致する
//   3. 復活させてはいけない店舗名が含まれていない(来々軒/川魚矢澤/駅前ダイニングさら)
//   4. id:2 (Street Coffee とらべる) の photo が street-coffee-toravel.jpeg のまま
//
// 違反があれば非ゼロ終了する。呼び出し側(ワークフロー)はこれを失敗として扱う。

import { readFileSync } from 'node:fs';

const EXPECTED_SHOP_COUNT = 22;
const BANNED_NAME_SUBSTRINGS = ['来々軒', '川魚矢澤', '駅前ダイニングさら'];
const PROTECTED_SHOP = { id: 2, name: 'Street Coffee とらべる', photo: 'street-coffee-toravel.jpeg' };

function loadShops(indexHtmlPath) {
  const html = readFileSync(indexHtmlPath, 'utf8');
  const match = html.match(/const shops=(\[[\s\S]*?\]);/);
  if (!match) {
    throw new Error('index.html 内に const shops=[...] が見つかりませんでした');
  }
  // eslint-disable-next-line no-eval
  const shops = eval(match[1]);
  if (!Array.isArray(shops)) {
    throw new Error('shops の解析結果が配列ではありません');
  }
  return shops;
}

function verify(indexHtmlPath) {
  const errors = [];
  let shops;

  try {
    shops = loadShops(indexHtmlPath);
  } catch (e) {
    errors.push(`構文解析エラー: ${e.message}`);
    return { ok: false, errors, shops: [] };
  }

  if (shops.length !== EXPECTED_SHOP_COUNT) {
    errors.push(`店舗数が想定と異なります: 期待=${EXPECTED_SHOP_COUNT}, 実際=${shops.length}`);
  }

  for (const shop of shops) {
    for (const banned of BANNED_NAME_SUBSTRINGS) {
      if (typeof shop.name === 'string' && shop.name.includes(banned)) {
        errors.push(`削除済みのはずの店舗名が見つかりました: id=${shop.id} name=${shop.name}`);
      }
    }
  }

  const protectedShop = shops.find((s) => s.id === PROTECTED_SHOP.id);
  if (!protectedShop) {
    errors.push(`保護対象の店舗(id=${PROTECTED_SHOP.id})が見つかりません`);
  } else {
    if (protectedShop.name !== PROTECTED_SHOP.name) {
      errors.push(`id=${PROTECTED_SHOP.id} の店名が変更されています: ${protectedShop.name}`);
    }
    if (protectedShop.photo !== PROTECTED_SHOP.photo) {
      errors.push(`id=${PROTECTED_SHOP.id} の photo が変更されています: ${protectedShop.photo}`);
    }
  }

  return { ok: errors.length === 0, errors, shops };
}

function main() {
  const indexHtmlPath = process.argv[2] || 'index.html';
  const result = verify(indexHtmlPath);

  console.log(`[verify_shops] 店舗数: ${result.shops.length}`);
  if (result.ok) {
    console.log('[verify_shops] OK: すべての検証項目をパスしました');
    process.exit(0);
  } else {
    console.error('[verify_shops] NG: 以下の問題が見つかりました');
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }
}

main();
