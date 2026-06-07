/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * 从结算清单 .xls 抽取近一个月的实际发货流水，落到 data/shipments-history.json。
 * 用法：
 *   node scripts/import-shipments.js <path-to.xls> [--out data/shipments-history.json] [--append]
 *
 * 抽出后字段（与 src/lib/shipments/store.ts 的 Shipment 类型一一对应）：
 *   id, date, country (ISO), countryName, carrier, service, carrierServiceId,
 *   pieces, actualWeightKg, volumetricWeightKg, chargeableWeightKg,
 *   volumeCm3, dimsCm{L,W,H}, freightFee, miscFee, packingFee, totalAmount,
 *   pricePerKg, currency, itemDescription, postcode, origNo, transNo, source
 */
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const CN2ISO = {
  英国: 'GB', 美国: 'US', 法国: 'FR', 丹麦: 'DK', 荷兰: 'NL',
  加拿大: 'CA', 德国: 'DE', 瑞士: 'CH', 挪威: 'NO', 比利时: 'BE',
  澳大利亚: 'AU', 阿联酋: 'AE', 波兰: 'PL', 瑞典: 'SE', 西班牙: 'ES',
  意大利: 'IT', 日本: 'JP', 韩国: 'KR', 中国香港: 'HK', 中国台湾: 'TW',
  新西兰: 'NZ', 爱尔兰: 'IE', 葡萄牙: 'PT', 奥地利: 'AT', 芬兰: 'FI',
  捷克: 'CZ', 卢森堡: 'LU', 匈牙利: 'HU', 罗马尼亚: 'RO', 希腊: 'GR'
};

// 把账单里的 "英国皇邮快线-C价" 这种名字归并为 engine.ts 里的 carrierId:serviceId
const SERVICE_MAP = {
  '英国皇邮快线-C价': { carrierId: 'uk-royal', serviceId: 'c-line' },
  '欧洲DHL快线-C价': { carrierId: 'dhl-eu', serviceId: 'c-line' },
  '欧洲DHL快线-C带电': { carrierId: 'dhl-eu', serviceId: 'c-battery' },
  '美国UPS空派小货-C价': { carrierId: 'us-ups', serviceId: 'small-c' },
  '美国UPS空派小货-C带电': { carrierId: 'us-ups', serviceId: 'small-battery' },
  '美国USPS专线小包-C价': { carrierId: 'us-usps', serviceId: 'small' },
  广州ETK: { carrierId: 'ca-etk', serviceId: 'etk' },
  '香港联邦(2.5KG以内)-PAK': { carrierId: 'fedex-hk', serviceId: 'pak' },
  '香港联邦IP-C带电': { carrierId: 'fedex-hk', serviceId: 'ip-battery' },
  'HX-欧洲专线小包-C价': { carrierId: 'hx-eu', serviceId: 'small' },
  '澳大利亚集运专线-C价': { carrierId: 'au-line', serviceId: 'c-line' },
  '中东专线-C价': { carrierId: 'me-line', serviceId: 'c-line' },
  '荷兰小包-MG': { carrierId: 'nl-mg', serviceId: 'mg' }
};

function parseDims(s) {
  if (!s) return null;
  const m = String(s).match(/([\d.]+)\s*\*\s*([\d.]+)\s*\*\s*([\d.]+)/);
  if (!m) return null;
  const L = +m[1], W = +m[2], H = +m[3];
  return { dims: { L, W, H }, volume: L * W * H };
}
function parsePackingFee(s) {
  if (!s) return 0;
  const m = String(s).match(/打包费\s*[:：]\s*([\d.]+)/);
  return m ? +m[1] : 0;
}
function toIsoDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    // Excel serial date → JS Date (1900 base)
    const utc = new Date(Math.round((v - 25569) * 86400 * 1000));
    return utc.toISOString().slice(0, 10);
  }
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function importSheet(wb, sheetName) {
  const ws = wb.Sheets[sheetName];
  if (!ws) return [];
  // 用 header=1 拿到二维数组，再按第 5 行（index=5）当表头
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  if (rows.length < 7) return [];
  const header = rows[5];
  if (!header || !header.includes('运输方式')) return [];
  const idx = {};
  for (let i = 0; i < header.length; i++) idx[String(header[i] ?? '').trim()] = i;
  const out = [];
  for (let r = 6; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row[idx['运输方式']]) continue;
    const seq = num(row[idx['序号']]);
    if (seq == null || seq <= 0) continue; // 跳过小计 / 表头重复行
    const country = String(row[idx['目的国家']] ?? '').trim();
    if (!country) continue;
    const service = String(row[idx['运输方式']] ?? '').trim();
    // 真实服务名包含中文 - 跳过 "帐号" / 纯数字（账号 / 单号被错位写入）
    if (!/[\u4e00-\u9fa5]/.test(service) || service === '帐号') continue;
    const dimInfo = parseDims(row[idx['收货体积信息']]);
    const mapped = SERVICE_MAP[service];
    out.push({
      id: `${row[idx['原单号']] ?? ''}_${row[idx['转单号']] ?? ''}`.trim() || `ship_${sheetName}_${r}`,
      date: toIsoDate(row[idx['收货日期']]),
      country: CN2ISO[country] ?? country,
      countryName: country,
      service,
      carrierId: mapped?.carrierId,
      serviceId: mapped?.serviceId,
      carrierServiceId: mapped ? `${mapped.carrierId}:${mapped.serviceId}` : undefined,
      pieces: num(row[idx['件数']]) ?? 1,
      actualWeightKg: num(row[idx['实重']]),
      volumetricWeightKg: num(row[idx['材积重']]),
      chargeableWeightKg: num(row[idx['计费重']]),
      volumeCm3: dimInfo?.volume ?? null,
      dimsCm: dimInfo?.dims ?? null,
      freightFee: num(row[idx['应收运费']]),
      miscFee: num(row[idx['应收杂费']]),
      packingFee: parsePackingFee(row[idx['费用说明']]),
      totalAmount: num(row[idx['总金额']]),
      pricePerKg: num(row[idx['应收单价']]),
      currency: 'CNY',
      itemDescription: String(row[idx['备注']] ?? '').replace(/[;；\s]+$/, '').trim(),
      postcode: String(row[idx['收件人邮编']] ?? '').trim() || null,
      origNo: String(row[idx['原单号']] ?? '').trim() || null,
      transNo: String(row[idx['转单号']] ?? '').trim() || null,
      source: sheetName
    });
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const xlsPath = args.find((a) => !a.startsWith('--'));
  if (!xlsPath) {
    console.error('用法: node scripts/import-shipments.js <path-to.xls> [--out data/shipments-history.json] [--append]');
    process.exit(1);
  }
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : path.join(process.cwd(), 'data', 'shipments-history.json');
  const append = args.includes('--append');

  const wb = XLSX.readFile(xlsPath, { cellDates: true });
  const dailySheets = wb.SheetNames.filter((n) => /运费/.test(n));
  console.log(`读取 ${dailySheets.length} 张运费表 (来自 ${path.basename(xlsPath)})`);
  let all = [];
  for (const s of dailySheets) {
    const items = importSheet(wb, s);
    console.log(`  ${s}: ${items.length} 票`);
    all = all.concat(items);
  }

  let merged = all;
  if (append && fs.existsSync(outPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
      const byId = new Map(existing.map((it) => [it.id, it]));
      for (const it of all) byId.set(it.id, it); // 新数据覆盖旧
      merged = Array.from(byId.values());
    } catch (e) {
      console.warn('无法解析旧文件，覆盖写入：', e.message);
    }
  }
  merged.sort((a, b) => (a.date < b.date ? 1 : -1));

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(merged, null, 2), 'utf-8');
  console.log(`写入 ${merged.length} 票 → ${outPath}`);

  // 顺手打印一些统计
  const byCountry = {}, byService = {};
  for (const s of merged) {
    byCountry[s.country] = (byCountry[s.country] || 0) + 1;
    byService[s.service] = (byService[s.service] || 0) + 1;
  }
  console.log('国家分布:', Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 10));
  console.log('线路分布:', Object.entries(byService).sort((a, b) => b[1] - a[1]).slice(0, 10));
}

main();
