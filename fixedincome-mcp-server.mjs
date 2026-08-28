// dsh-cn-fixedincome-mcp — 可转债 / 债券 本地优先分析引擎（零依赖 Node ESM MCP stdio server）
// 设计定位：与 cb-strategy-mcp（策略层：双低/三低/YTM 引擎，依赖东财实时）错位 —— 本插件是
//   「分析/计算层 + 本地参考条款种子」，不抓取实时行情、不依赖 API key，所有数值由输入条款本地推导。
// 工具：cb_analytics / cb_lookup / cb_screen / bond_ytm / bond_metrics / bond_cashflow

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SEED_PATH = process.env.CB_SEED_PATH || path.join(__dirname, 'data', 'cb_seed.json');

// ---------- 工具函数 ----------
const r2 = (x) => (Math.round((x + Number.EPSILON) * 100) / 100);
const r4 = (x) => (Math.round((x + Number.EPSILON) * 10000) / 10000);
const num = (v, d = 0) => { const n = parseFloat(v); return isFinite(n) ? n : d; };

// 由票息数组 + 年限 + 赎回价 构造现金流（年付息，末年含赎回价）
function buildCashflows(couponRates, years, par, redemption) {
  const cf = [];
  const n = Math.max(1, Math.round(years));
  for (let t = 1; t <= n; t++) {
    const rate = (couponRates && couponRates[Math.min(t - 1, couponRates.length - 1)] != null)
      ? couponRates[Math.min(t - 1, couponRates.length - 1)] : 0;
    let amount = par * (rate / 100);
    if (t === n) amount += (redemption != null ? redemption : par);
    cf.push({ t, amount: r2(amount) });
  }
  return cf;
}

// 牛顿法解 YTM：price = Σ amount_t / (1+y)^t
function solveYTM(price, cf) {
  if (!(price > 0)) throw new Error('bond price must be > 0');
  let y = 0.03;
  for (let i = 0; i < 200; i++) {
    let f = -price, df = 0;
    for (const { t, amount } of cf) {
      const d = Math.pow(1 + y, t);
      f += amount / d;
      df += -t * amount / (d * (1 + y));
    }
    if (Math.abs(df) < 1e-12) break;
    const step = f / df;
    y -= step;
    if (y <= -0.9999) y = -0.9999;           // 防 pow 越界
    if (Math.abs(step) < 1e-12) break;
  }
  return y;
}

// 久期 / 凸度
function riskMetrics(price, cf, y) {
  let mac = 0, conv = 0;
  for (const { t, amount } of cf) {
    const d = Math.pow(1 + y, t);
    const pv = amount / d;
    mac += t * pv;
    conv += t * (t + 1) * pv;
  }
  mac /= price;
  const modified = mac / (1 + y);
  const dv01 = modified * price * 1e-4;
  const convexity = conv / (price * Math.pow(1 + y, 2));
  return { macaulay: r4(mac), modified: r4(modified), dv01: r4(dv01), convexity: r4(convexity) };
}

// 纯债价值（债底）：以给定贴现收益率对现金流贴现
function pureBondValue(cf, y) {
  let pv = 0;
  for (const { t, amount } of cf) pv += amount / Math.pow(1 + y, t);
  return r2(pv);
}

// 转股类指标
function convertMetrics(stockPrice, conversionPrice, par) {
  const ratio = par / conversionPrice;            // 转股比例 = 面值/转股价
  const cv = stockPrice * ratio;                  // 转股价值 = 股价 * 转股比例
  return { conversion_ratio: r4(ratio), conversion_value: r2(cv) };
}

// 条款触发判定（阈值可覆盖）
function clauseFlags(stockPrice, conversionPrice, opt) {
  const dThr = opt.downward_threshold != null ? opt.downward_threshold : 0.85;
  const cThr = opt.call_threshold != null ? opt.call_threshold : 1.30;
  const pThr = opt.put_threshold != null ? opt.put_threshold : 0.70;
  return {
    downward_revision: stockPrice < dThr * conversionPrice,   // 下修博弈：股价低于转股价阈值
    forced_redemption: stockPrice >= cThr * conversionPrice,  // 强赎：股价>=130% 转股价
    put_back: stockPrice < pThr * conversionPrice,            // 回售：股价低于阈值
  };
}

// ---------- 工具实现 ----------
function loadSeed() {
  try { return JSON.parse(fs.readFileSync(SEED_PATH, 'utf8')); }
  catch (e) { return { items: [], as_of: null }; }
}

function cbAnalytics(p) {
  const par = num(p.par, 100);
  const stockPrice = num(p.stock_price);
  const conversionPrice = num(p.conversion_price);
  if (!(stockPrice > 0) || !(conversionPrice > 0)) {
    throw new Error('stock_price 与 conversion_price 必须为正');
  }
  const { conversion_ratio, conversion_value } = convertMetrics(stockPrice, conversionPrice, par);

  const out = { par, stock_price: stockPrice, conversion_price: conversionPrice, conversion_ratio, conversion_value };

  // 债底 / YTM（需票息与年限）
  const couponRates = Array.isArray(p.coupon_rates) ? p.coupon_rates : null;
  const years = num(p.years_to_maturity, 0);
  const redemption = p.maturity_redemption != null ? num(p.maturity_redemption) : null;
  if (couponRates && years > 0) {
    const cf = buildCashflows(couponRates, years, par, redemption);
    out.cashflows = cf;
    const bondYield = p.bond_yield != null ? num(p.bond_yield) : 0.03;
    out.pure_bond_value = pureBondValue(cf, bondYield);
    out.debt_floor = out.pure_bond_value;
    const bondPrice = num(p.bond_price, 0);
    if (bondPrice > 0) {
      try {
        const y = solveYTM(bondPrice, cf);
        out.ytm = r4(y * 100);
        out.ytm_decimal = r4(y);
      } catch (e) { out.ytm = null; out.ytm_error = String(e.message || e); }
    }
  }

  // 转股溢价率 / 双低（需债价）
  const bondPrice = num(p.bond_price, 0);
  if (bondPrice > 0) {
    out.bond_price = bondPrice;
    const premium = (bondPrice - conversion_value) / conversion_value;   // 转股溢价率（小数）
    out.conversion_premium_rate = r4(premium * 100);                    // 百分比
    out.parity_premium_rate = r4(((conversionPrice - stockPrice) / stockPrice) * 100); // 转股价溢价率
    out.double_low = r2(bondPrice + premium * 100);                     // 双低 = 债价 + 溢价率(百分点)
  }

  out.clause_flags = clauseFlags(stockPrice, conversionPrice, p);
  return out;
}

function cbLookup(p) {
  const seed = loadSeed();
  const q = String(p.query || '').trim().toLowerCase();
  const item = (seed.items || []).find(it =>
    it.code === p.query || it.name === p.query ||
    it.code?.toLowerCase() === q || it.name?.toLowerCase() === q);
  if (!item) return { found: false, query: p.query };
  const terms = {
    code: item.code, name: item.name, conversion_price: item.conversion_price, par: item.par || 100,
    maturity_date: item.maturity_date, coupon_rates: item.coupon_rates, maturity_redemption: item.maturity_redemption,
  };
  let analytics = null;
  if (item.snapshot && item.snapshot.stock_price && item.snapshot.bond_price) {
    try {
      analytics = cbAnalytics({
        stock_price: item.snapshot.stock_price, conversion_price: item.conversion_price,
        bond_price: item.snapshot.bond_price, par: item.par || 100,
        coupon_rates: item.coupon_rates, years_to_maturity: item.years_to_maturity,
        maturity_redemption: item.maturity_redemption,
      });
    } catch (e) { analytics = { error: String(e.message || e) }; }
  }
  return { found: true, as_of: seed.as_of, terms, snapshot: item.snapshot || null, analytics };
}

function cbScreen(p) {
  const seed = loadSeed();
  const maxPremium = p.max_premium_rate != null ? num(p.max_premium_rate) : Infinity;
  const maxPrice = p.max_bond_price != null ? num(p.max_bond_price) : Infinity;
  const minYTM = p.min_ytm != null ? num(p.min_ytm) : -Infinity;
  const belowDownward = p.only_below_downward || false;
  const rows = [];
  for (const it of (seed.items || [])) {
    if (!it.snapshot || !it.snapshot.stock_price || !it.snapshot.bond_price) continue;
    let a;
    try {
      a = cbAnalytics({
        stock_price: it.snapshot.stock_price, conversion_price: it.conversion_price,
        bond_price: it.snapshot.bond_price, par: it.par || 100,
        coupon_rates: it.coupon_rates, years_to_maturity: it.years_to_maturity,
        maturity_redemption: it.maturity_redemption,
      });
    } catch (e) { continue; }
    if (a.conversion_premium_rate > maxPremium) continue;
    if (a.bond_price > maxPrice) continue;
    if (a.ytm != null && a.ytm < minYTM) continue;
    if (belowDownward && !a.clause_flags.downward_revision) continue;
    rows.push({
      code: it.code, name: it.name, bond_price: a.bond_price, conversion_premium_rate: a.conversion_premium_rate,
      ytm: a.ytm, double_low: a.double_low, debt_floor: a.debt_floor,
      downward_revision: a.clause_flags.downward_revision,
    });
  }
  rows.sort((x, y) => (x.double_low || 1e9) - (y.double_low || 1e9));
  return { as_of: seed.as_of, count: rows.length, rows };
}

function bondYTM(p) {
  const par = num(p.par, 100);
  const price = num(p.price);
  const couponRates = Array.isArray(p.coupon_rates) ? p.coupon_rates : null;
  const years = num(p.years, 0);
  const redemption = p.redemption != null ? num(p.redemption) : null;
  if (!couponRates || !(years > 0)) throw new Error('需要 coupon_rates 与 years');
  const cf = buildCashflows(couponRates, years, par, redemption);
  const y = solveYTM(price, cf);
  return { price, ytm: r4(y * 100), ytm_decimal: r4(y), cashflows: cf };
}

function bondMetrics(p) {
  const par = num(p.par, 100);
  const price = num(p.price);
  const y = num(p.ytm) / 100;
  let cf;
  if (Array.isArray(p.cashflows) && p.cashflows.length) cf = p.cashflows.map(c => ({ t: num(c.t), amount: num(c.amount) }));
  else {
    const couponRates = Array.isArray(p.coupon_rates) ? p.coupon_rates : null;
    const years = num(p.years, 0);
    const redemption = p.redemption != null ? num(p.redemption) : null;
    if (!couponRates || !(years > 0)) throw new Error('需要 cashflows 或 coupon_rates+years');
    cf = buildCashflows(couponRates, years, par, redemption);
  }
  const m = riskMetrics(price, cf, y);
  return { price, ytm: r4(y * 100), ...m, cashflows: cf };
}

function bondCashflow(p) {
  const par = num(p.par, 100);
  const couponRates = Array.isArray(p.coupon_rates) ? p.coupon_rates : null;
  const years = num(p.years, 0);
  const redemption = p.redemption != null ? num(p.redemption) : null;
  if (!couponRates || !(years > 0)) throw new Error('需要 coupon_rates 与 years');
  return { par, years, redemption: redemption ?? par, cashflows: buildCashflows(couponRates, years, par, redemption) };
}

// ---------- MCP 协议层 ----------
const TOOLS = [
  {
    name: 'cb_analytics', description: '可转债核心分析：转股价值/转股溢价率/双低/纯债价值(YTM)/下修·强赎·回售触发判定。可传条款即时算，或传 code 自动载入本地种子条款+快照。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '可选：可转债代码，自动载入种子条款+快照' },
        stock_price: { type: 'number', description: '正股现价' },
        conversion_price: { type: 'number', description: '转股价' },
        bond_price: { type: 'number', description: '可转债市价（用于算溢价率/双低/YTM）' },
        par: { type: 'number', description: '面值，默认 100' },
        coupon_rates: { type: 'array', items: { type: 'number' }, description: '各年票息率(%)数组' },
        years_to_maturity: { type: 'number', description: '剩余年限' },
        maturity_redemption: { type: 'number', description: '到期赎回价(元)' },
        bond_yield: { type: 'number', description: '纯债贴现收益率(小数,默认0.03)' },
        downward_threshold: { type: 'number', description: '下修阈值(默认0.85)' },
        call_threshold: { type: 'number', description: '强赎阈值(默认1.30)' },
        put_threshold: { type: 'number', description: '回售阈值(默认0.70)' },
      },
    },
  },
  {
    name: 'cb_lookup', description: '按代码/名称查本地可转债种子条款，并返回基于快照的分析。',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: '代码或名称' } }, required: ['query'] },
  },
  {
    name: 'cb_screen', description: '对本地种子（含快照）按转股溢价率/债价/YTM/下修状态筛选排序（双低升序）。',
    inputSchema: {
      type: 'object',
      properties: {
        max_premium_rate: { type: 'number', description: '转股溢价率上限(%)' },
        max_bond_price: { type: 'number', description: '债价上限' },
        min_ytm: { type: 'number', description: 'YTM 下限(%)' },
        only_below_downward: { type: 'boolean', description: '仅保留触发下修博弈的' },
      },
    },
  },
  {
    name: 'bond_ytm', description: '债券到期收益率（牛顿法）。给定价格+票息+年限+赎回价。',
    inputSchema: {
      type: 'object',
      properties: {
        price: { type: 'number', description: '债券全价' },
        par: { type: 'number', description: '面值默认100' },
        coupon_rates: { type: 'array', items: { type: 'number' }, description: '年票息率(%)' },
        years: { type: 'number', description: '年限' },
        redemption: { type: 'number', description: '到期赎回价' },
      },
      required: ['price', 'coupon_rates', 'years'],
    },
  },
  {
    name: 'bond_metrics', description: '债券久期/凸度/DV01。给定 YTM + 现金流(或票息+年限)。',
    inputSchema: {
      type: 'object',
      properties: {
        price: { type: 'number', description: '债券全价' },
        ytm: { type: 'number', description: '到期收益率(%)' },
        cashflows: { type: 'array', items: { type: 'object', properties: { t: { type: 'number' }, amount: { type: 'number' } } } },
        par: { type: 'number' }, coupon_rates: { type: 'array', items: { type: 'number' } }, years: { type: 'number' }, redemption: { type: 'number' },
      },
      required: ['price', 'ytm'],
    },
  },
  {
    name: 'bond_cashflow', description: '由票息率+年限+赎回价构造债券现金流时间表。',
    inputSchema: {
      type: 'object',
      properties: {
        par: { type: 'number' }, coupon_rates: { type: 'array', items: { type: 'number' } }, years: { type: 'number' }, redemption: { type: 'number' },
      },
      required: ['coupon_rates', 'years'],
    },
  },
];

function dispatch(name, args) {
  switch (name) {
    case 'cb_analytics': {
      if (args.code && (args.stock_price == null || args.conversion_price == null)) {
        const seed = loadSeed();
        const q = String(args.code).trim().toLowerCase();
        const it = (seed.items || []).find(i => i.code === args.code || i.code?.toLowerCase() === q || i.name?.toLowerCase() === q);
        if (!it) return { error: `种子中未找到 ${args.code}` };
        const a = {
          stock_price: it.snapshot?.stock_price, conversion_price: it.conversion_price,
          bond_price: it.snapshot?.bond_price, par: it.par || 100, coupon_rates: it.coupon_rates,
          years_to_maturity: it.years_to_maturity, maturity_redemption: it.maturity_redemption, ...args,
        };
        delete a.code;
        return cbAnalytics(a);
      }
      return cbAnalytics(args);
    }
    case 'cb_lookup': return cbLookup(args);
    case 'cb_screen': return cbScreen(args);
    case 'bond_ytm': return bondYTM(args);
    case 'bond_metrics': return bondMetrics(args);
    case 'bond_cashflow': return bondCashflow(args);
    default: throw new Error('unknown tool: ' + name);
  }
}

// ---------- stdio 循环 ----------
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) handle(line);
  }
});
process.stdin.on('end', () => process.exit(0));

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'dsh-cn-fixedincome-mcp', version: '0.1.0' },
    } });
  } else if (method === 'notifications/initialized') {
    // no-op
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  } else if (method === 'tools/call') {
    const { name, arguments: args } = params;
    try {
      const result = dispatch(name, args || {});
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ERROR: ' + (e.message || String(e)) }], isError: true } });
    }
  }
}

if (process.argv.includes('--selftest')) {
  // 仅在 --selftest 时由外部驱动；此处不自动跑
}
