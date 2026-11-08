/* 車輛油耗保養紀錄 — 核心邏輯（無 DOM 相依，可在瀏覽器與 Node 執行）
 * - 讀取 .xlsx（自行解 ZIP + XML，不需外部套件）與 .csv
 * - 把工作表對應成加油紀錄 / 費用紀錄
 * - 計算油耗、每日費用、每公里費用等統計
 */
(function (G) {
  'use strict';

  /* ---------------- 共用工具 ---------------- */
  const round = (n, d = 2) => (n == null || !isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayStr = () => ymd(new Date());
  const dayNum = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;
  const daysBetween = (a, b) => dayNum(b) - dayNum(a);

  function excelSerialToDate(n, date1904) {
    const base = date1904 ? 24107 : 25569; // 1904/1900 系統對 1970-01-01 的位移
    const d = new Date(Math.round((n - base) * 86400000));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }

  /** 把各種日期寫法轉成 YYYY-MM-DD，無法辨識回傳 null */
  function toDate(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'object' && v.date) return v.date;
    if (typeof v === 'number') return v > 20000 && v < 80000 ? excelSerialToDate(v) : null;
    const s = String(v).trim();
    let m = s.match(/^(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})日?/);
    if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    m = s.match(/^(\d{2,3})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/); // 民國年 114/1/22
    if (m && +m[1] < 200) return `${+m[1] + 1911}-${pad(m[2])}-${pad(m[3])}`;
    if (/^\d{5}(\.\d+)?$/.test(s)) return toDate(+s);
    return null;
  }

  function toNum(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'object') return null;
    const s = String(v).replace(/[,，\s$元]/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    return +s;
  }

  /* ---------------- ZIP ---------------- */
  async function inflateRaw(u8) {
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function openZip(buf) {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('檔案不是有效的 .xlsx（找不到 ZIP 結構）');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const td = new TextDecoder();
    const files = {};
    for (let k = 0; k < count; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP 目錄損毀');
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const off = dv.getUint32(p + 42, true);
      files[td.decode(u8.subarray(p + 46, p + 46 + nlen))] = { method, csize, off };
      p += 46 + nlen + xlen + clen;
    }
    return {
      has: name => name in files,
      async text(name) {
        const f = files[name];
        if (!f) return null;
        const start = f.off + 30 + dv.getUint16(f.off + 26, true) + dv.getUint16(f.off + 28, true);
        const data = u8.subarray(start, start + f.csize);
        let out;
        if (f.method === 0) out = data;
        else if (f.method === 8) out = await inflateRaw(data);
        else throw new Error('不支援的壓縮格式');
        return td.decode(out);
      }
    };
  }

  /* ---------------- XLSX ---------------- */
  const unxml = s => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
    const map = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
    if (map[e.toLowerCase()]) return map[e.toLowerCase()];
    return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
  const attr = (s, name) => { const m = s.match(new RegExp('(?:^|\\s)' + name + '="([^"]*)"')); return m ? unxml(m[1]) : null; };
  const textOf = xml => { let out = ''; xml.replace(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g, (m, t) => (out += t)); return unxml(out); };
  const colIndex = ref => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

  const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58]);
  function isDateFormat(id, code) {
    if (BUILTIN_DATE_FMTS.has(id)) return true;
    if (!code) return false;
    const c = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
    return /[ymd]/i.test(c) && !/^[#0.,%\s]*$/.test(c);
  }

  async function readXlsx(buf) {
    const zip = openZip(buf);
    const wbXml = await zip.text('xl/workbook.xml');
    if (!wbXml) throw new Error('找不到 workbook.xml，這可能不是 Excel 檔');
    const date1904 = /date1904="(1|true)"/.test(wbXml);
    const relsXml = (await zip.text('xl/_rels/workbook.xml.rels')) || '';
    const rels = {};
    relsXml.replace(/<(?:\w+:)?Relationship\b([^>]*)\/?>/g, (m, a) => { rels[attr(a, 'Id')] = attr(a, 'Target'); });

    const shared = [];
    const ssXml = await zip.text('xl/sharedStrings.xml');
    if (ssXml) ssXml.replace(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g, (m, inner) => { shared.push(textOf(inner.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, ''))); });

    const dateStyle = [];
    const stXml = await zip.text('xl/styles.xml');
    if (stXml) {
      const fmts = {};
      stXml.replace(/<(?:\w+:)?numFmt\b([^>]*)\/?>/g, (m, a) => { fmts[attr(a, 'numFmtId')] = attr(a, 'formatCode'); });
      const xfs = (stXml.match(/<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/) || [])[1] || '';
      xfs.replace(/<(?:\w+:)?xf\b([^>]*?)\/?>/g, (m, a) => { const id = +(attr(a, 'numFmtId') || 0); dateStyle.push(isDateFormat(id, fmts[id])); });
    }

    const sheets = [];
    const sheetTags = wbXml.match(/<(?:\w+:)?sheet\b[^>]*\/?>/g) || [];
    for (const tag of sheetTags) {
      const name = attr(tag, 'name');
      const rid = attr(tag, 'r:id') || (tag.match(/\w+:id="([^"]*)"/) || [])[1];
      let target = rels[rid];
      if (!target) continue;
      target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
      const xml = await zip.text(target);
      if (!xml) continue;
      const rows = [];
      const data = (xml.match(/<(?:\w+:)?sheetData\b[^>]*>([\s\S]*?)<\/(?:\w+:)?sheetData>/) || [])[1] || '';
      data.replace(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g, (m, ra, inner) => {
        const rIdx = +(attr(ra, 'r') || rows.length + 1) - 1;
        const row = [];
        let auto = 0;
        (inner || '').replace(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g, (m2, ca, ci) => {
          const ref = attr(ca, 'r');
          const col = ref ? colIndex(ref) : auto;
          auto = col + 1;
          const t = attr(ca, 't');
          const s = +(attr(ca, 's') || 0);
          ci = ci || '';
          const vm = ci.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/);
          const raw = vm ? unxml(vm[1]) : null;
          let val = null;
          if (t === 's') val = raw != null ? shared[+raw] : null;
          else if (t === 'inlineStr') val = textOf(ci);
          else if (t === 'str') val = raw;
          else if (t === 'b') val = raw === '1';
          else if (t === 'e') val = null;
          else if (raw != null && raw !== '') {
            const n = +raw;
            val = dateStyle[s] && n > 0 ? { date: excelSerialToDate(n, date1904), serial: n } : n;
          }
          row[col] = val;
        });
        rows[rIdx] = row;
      });
      for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
      sheets.push({ name, rows });
    }
    return sheets;
  }

  /* ---------------- CSV ---------------- */
  function decodeText(buf) {
    const u8 = new Uint8Array(buf);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8).replace(/^﻿/, ''); }
    catch { try { return new TextDecoder('big5').decode(u8); } catch { return new TextDecoder().decode(u8); } }
  }

  function parseCsv(text) {
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  async function readFile(name, buf) {
    if (/\.csv$/i.test(name)) return [{ name: name.replace(/\.[^.]+$/, ''), rows: parseCsv(decodeText(buf)) }];
    if (/\.xls$/i.test(name)) throw new Error('不支援舊版 .xls，請在 Excel 另存為 .xlsx 或 .csv');
    return readXlsx(buf);
  }

  /* ---------------- 分類 ---------------- */
  const CATEGORIES = ['保養', '維修', '輪胎', '保險', '稅費', '配件改裝', '購車', '停車過路', '其他'];
  function guessCategory(note) {
    const s = note || '';
    if (/購車|買車|牽車|新車/.test(s)) return '購車';
    if (/險/.test(s)) return '保險';
    if (/燃料費|牌照稅|稅|驗車|罰/.test(s)) return '稅費';
    if (/停車|過路|etc|洗車/i.test(s)) return '停車過路';
    if (/輪胎|前輪|後輪|胎/.test(s)) return '輪胎';
    if (/機油|齒輪油|濾|火星塞|皮帶|普利珠|保養|冷卻|煞車油|變速箱油/.test(s)) return '保養';
    if (/煞|來令|碟|電池|修|更換|零件|燈泡/.test(s)) return '維修';
    if (/行車紀錄器|配件|掛鉤|墊|後照鏡|大底|開關|架|改/.test(s)) return '配件改裝';
    return '其他';
  }

  /* ---------------- 匯入對應 ---------------- */
  const H = {
    date: [/^日期$/, /日期|date/i],
    amount: [/^金額$/, /金額|費用|價格|花費|價錢|amount|cost|price/i],
    odo: [/^總里程$/, /^里程$/, /里程|里數|公里數|odometer|odo|mileage/i],
    liters: [/^本次加油$/, /公升|加油量|油量|本次加油|liter|litre/i],
    note: [/^備註$/, /備註|項目|說明|內容|note|memo|item/i],
    category: [/分類|類別|category/i],
    full: [/加滿|full/i]
  };
  const H_EXCLUDE = {
    amount: /總|每|累計|平均|油價|單價/,
    odo: /本次|每|平均/,
    liters: /已加油|總|每|平均/
  };
  const cellText = v => (v == null ? '' : typeof v === 'object' ? v.date || '' : String(v)).trim();

  function mapHeader(row) {
    const cols = {};
    const texts = row.map(cellText);
    for (const key of Object.keys(H)) {
      for (const re of H[key]) {
        const i = texts.findIndex((t, idx) => t && re.test(t) && !(H_EXCLUDE[key] && H_EXCLUDE[key].test(t)) && !Object.values(cols).includes(idx));
        if (i >= 0) { cols[key] = i; break; }
      }
    }
    return cols;
  }

  /** 分析一張工作表：找表頭、對應欄位、轉出紀錄 */
  function analyzeSheet(sheet) {
    const res = { name: sheet.name, header: -1, cols: {}, fuel: [], expense: [], skipped: 0, summary: false };
    for (let i = 0; i < Math.min(sheet.rows.length, 20); i++) {
      const cols = mapHeader(sheet.rows[i] || []);
      if (cols.date != null && cols.amount != null) { res.header = i; res.cols = cols; break; }
    }
    if (res.header < 0) return res;
    const head = (sheet.rows[res.header] || []).map(cellText).join('|');
    res.summary = /總花費表|彙總|summary/i.test(sheet.name) || /^總花費$/.test(sheet.name) || /每公里總費用|每天成本/.test(head);
    const c = res.cols;
    for (let i = res.header + 1; i < sheet.rows.length; i++) {
      const r = sheet.rows[i] || [];
      if (!r.some(v => cellText(v) !== '')) continue;
      const date = toDate(r[c.date]);
      const amount = toNum(r[c.amount]);
      const liters = c.liters != null ? toNum(r[c.liters]) : null;
      const odo = c.odo != null ? toNum(r[c.odo]) : null;
      const note = c.note != null ? cellText(r[c.note]) : '';
      if (!date || amount == null) { res.skipped++; continue; }
      if (liters != null && liters > 0) {
        let full = !/未加滿|沒加滿|半滿|部分/.test(note);
        if (c.full != null) { const f = cellText(r[c.full]); if (/^(否|n|no|false|0|x)$/i.test(f)) full = false; }
        res.fuel.push({ date, amount: round(amount, 2), odo: odo != null ? round(odo, 2) : null, liters: round(liters, 3), full, note });
      } else {
        const category = c.category != null && CATEGORIES.includes(cellText(r[c.category])) ? cellText(r[c.category]) : guessCategory(note);
        res.expense.push({ date, amount: round(amount, 2), odo: odo != null ? round(odo, 2) : null, category, note });
      }
    }
    return res;
  }

  /** 分析整個檔案；若同時有明細表與「總花費」彙總表，彙總表預設略過以免重複 */
  function analyzeWorkbook(sheets) {
    const list = sheets.map(analyzeSheet).filter(s => s.header >= 0);
    const hasDetail = list.some(s => !s.summary && (s.fuel.length || s.expense.length));
    list.forEach(s => { s.include = (s.fuel.length + s.expense.length > 0) && !(s.summary && hasDetail); });
    return list;
  }

  const fuelKey = f => `${f.date}|${f.amount}|${f.odo}|${f.liters}`;
  const expKey = e => `${e.date}|${e.amount}|${(e.note || '').trim()}`;

  /* ---------------- 計算 ---------------- */
  const byDateOdo = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.odo ?? 0) - (b.odo ?? 0));

  /** 每筆加油加上：本次里程、本次油耗(滿到滿)、油價 */
  function computeFuelRows(fuels) {
    const rows = fuels.slice().sort(byDateOdo).map(f => ({ ...f }));
    let prevOdo = null, baseOdo = null, accL = 0, segKm = 0, segL = 0;
    const segments = [];
    for (const r of rows) {
      r.ppl = r.liters > 0 ? r.amount / r.liters : null;
      r.dist = prevOdo != null && r.odo != null ? r.odo - prevOdo : null;
      r.kmpl = null;
      if (r.odo != null) prevOdo = r.odo;
      if (baseOdo == null) {
        if (r.full !== false && r.odo != null) { baseOdo = r.odo; accL = 0; }
        continue;
      }
      accL += r.liters || 0;
      if (r.full !== false && r.odo != null) {
        const km = r.odo - baseOdo;
        if (km > 0 && accL > 0) {
          r.kmpl = km / accL; r.segKm = km; r.segL = accL;
          segKm += km; segL += accL; segments.push({ date: r.date, km, liters: accL });
        }
        baseOdo = r.odo; accL = 0;
      }
    }
    return { rows, segments, avgKmpl: segL > 0 ? segKm / segL : null, segKm, segL };
  }

  function computeStats(vehicle, fuels, expenses, opt = {}) {
    const includePurchase = opt.includePurchase !== false;
    const f = computeFuelRows(fuels);
    const exps = expenses.slice().sort(byDateOdo);
    const dates = [...fuels.map(x => x.date), ...exps.map(x => x.date)].sort();
    const odos = [...fuels, ...exps].map(x => x.odo).filter(x => x != null);
    const start = vehicle.startDate || dates[0] || null;
    const end = dates[dates.length - 1] || null;
    const days = start && end ? Math.max(1, daysBetween(start, end) + 1) : null;
    const startOdo = vehicle.startOdo != null && vehicle.startOdo !== '' ? +vehicle.startOdo : (odos.length ? Math.min(...odos) : 0);
    const curOdo = odos.length ? Math.max(...odos) : null;
    const km = curOdo != null ? curOdo - startOdo : null;

    const sum = (a, k) => a.reduce((s, x) => s + (+x[k] || 0), 0);
    const fuelTotal = sum(fuels, 'amount');
    const litersTotal = sum(fuels.filter(x => x.liters > 0), 'liters');
    const purchase = sum(exps.filter(x => x.category === '購車'), 'amount');
    const expAll = sum(exps, 'amount');
    const expTotal = includePurchase ? expAll : expAll - purchase;
    const total = fuelTotal + expTotal;

    const recentSeg = f.segments.slice(-5);
    const rk = recentSeg.reduce((s, x) => s + x.km, 0), rl = recentSeg.reduce((s, x) => s + x.liters, 0);
    const last = f.segments[f.segments.length - 1];

    const fr = f.rows;
    const intervals = [];
    for (let i = 1; i < fr.length; i++) intervals.push(daysBetween(fr[i - 1].date, fr[i].date));

    const byCat = {};
    exps.forEach(e => { byCat[e.category] = (byCat[e.category] || 0) + (+e.amount || 0); });

    // 依年度
    const years = {};
    const Y = d => d.slice(0, 4);
    const yr = y => (years[y] = years[y] || { year: y, fuel: 0, liters: 0, exp: 0, fills: 0, segKm: 0, segL: 0, maxOdo: null });
    fuels.forEach(x => { const o = yr(Y(x.date)); o.fuel += +x.amount || 0; o.liters += +x.liters || 0; o.fills++; });
    exps.forEach(x => { if (!includePurchase && x.category === '購車') return; yr(Y(x.date)).exp += +x.amount || 0; });
    [...fuels, ...exps].forEach(x => { if (x.odo != null) { const o = yr(Y(x.date)); o.maxOdo = Math.max(o.maxOdo ?? -Infinity, x.odo); } });
    f.segments.forEach(s => { const o = yr(Y(s.date)); o.segKm += s.km; o.segL += s.liters; });
    let prevMax = startOdo;
    const yearList = Object.values(years).sort((a, b) => (a.year < b.year ? -1 : 1)).map(o => {
      const kmY = o.maxOdo != null ? Math.max(0, o.maxOdo - prevMax) : null;
      if (o.maxOdo != null) prevMax = Math.max(prevMax, o.maxOdo);
      return { year: o.year, fuel: o.fuel, exp: o.exp, total: o.fuel + o.exp, liters: o.liters, fills: o.fills, km: kmY, kmpl: o.segL > 0 ? o.segKm / o.segL : null };
    });

    const today = opt.today || todayStr();
    const lastMatch = re => {
      const e = exps.filter(x => re.test(x.note || '')).pop();
      if (!e) return null;
      return { date: e.date, odo: e.odo, note: e.note, kmSince: e.odo != null && curOdo != null ? curOdo - e.odo : null, daysSince: daysBetween(e.date, today) };
    };

    return {
      fuelRows: f.rows, segments: f.segments,
      start, end, days, startOdo, curOdo, km,
      fuelTotal, litersTotal, expTotal, expAll, purchase, total,
      avgKmpl: f.avgKmpl, lastKmpl: last ? last.km / last.liters : null, recentKmpl: rl > 0 ? rk / rl : null,
      avgPpl: litersTotal > 0 ? fuelTotal / litersTotal : null,
      lastPpl: fr.length ? fr[fr.length - 1].ppl : null,
      fuelPerDay: days ? fuelTotal / days : null,
      totalPerDay: days ? total / days : null,
      fuelPerKm: km > 0 ? fuelTotal / km : null,
      totalPerKm: km > 0 ? total / km : null,
      fuelPerYear: days >= 183 ? (fuelTotal / days) * 365 : null,
      totalPerYear: days >= 183 ? (total / days) * 365 : null,
      fills: fuels.length, avgFillDays: intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : null,
      avgFillKm: f.segments.length ? f.segKm / f.segments.length : null,
      byCat, years: yearList,
      lastOil: lastMatch(/機油/), lastGear: lastMatch(/齒輪油/),
      includePurchase
    };
  }


  /* ---------------- 電子發票 QR ---------------- */
  /** 把掃描結果轉成文字。jsQR 給原始 bytes，可依發票宣告的編碼（0=Big5、1=UTF-8、2=Base64 品名）正確解碼中文 */
  function invoiceText(raw, preferEnc) {
    if (!raw) return '';
    if (typeof raw === 'string') return raw.trim();
    const bytes = raw.binaryData;
    if (!bytes || !bytes.length) return String(raw.data || '').trim();
    const u8 = Uint8Array.from(bytes);
    const dec = (label, fatal) => new TextDecoder(label, { fatal: !!fatal }).decode(u8).trim();
    let head = '';
    for (let i = 0; i < Math.min(bytes.length, 120); i++) head += String.fromCharCode(bytes[i]);
    if (/^[A-Z]{2}\d{8}/.test(head) && bytes.length >= 77) {
      const ext = head.slice(77);
      const enc = ext.startsWith(':') ? ext.slice(1).split(':')[3] : '';
      try { if (enc === '0') return dec('big5'); if (enc === '1') return dec('utf-8'); } catch (e) {}
    } else if (head.startsWith('**')) {
      try { if (preferEnc === '0') return dec('big5'); return dec('utf-8', true); }
      catch (e) { try { return dec('big5'); } catch (e2) {} }
    }
    if (raw.data && !raw.data.includes('�')) return raw.data.trim();
    try { return dec('utf-8', true); } catch (e) { try { return dec('big5'); } catch (e2) {} }
    return String(raw.data || head).trim();
  }

  function invoiceItems(fields, enc) {
    const out = [];
    for (let i = 0; i < fields.length; i += 3) {
      let name = String(fields[i] || '').trim();
      if (!name) continue;
      if (enc === '2') {
        try { name = new TextDecoder('utf-8').decode(Uint8Array.from(atob(name), c => c.charCodeAt(0))).trim(); } catch (e) {}
      }
      out.push({ name, qty: parseFloat(fields[i + 1]) || 0, price: parseFloat(fields[i + 2]) || 0 });
    }
    return out;
  }

  /** 解析一個發票 QR。左側回傳 { kind:'left', no, date, total, items, itemsOnQR, totalItems, enc, ... }；
   *  右側回傳 { kind:'right', fields }；不是發票 QR 回傳 null */
  function parseInvoiceQR(raw, preferEnc) {
    const text = invoiceText(raw, preferEnc).replace(/[\r\n]+/g, '').trim();
    if (!text) return null;
    if (text.startsWith('**')) return { kind: 'right', fields: text.replace(/^\*+:?/, '').split(':') };
    const m = /^([A-Z]{2}\d{8})(\d{7})([0-9A-Za-z]{4})([0-9A-Fa-f]{8})([0-9A-Fa-f]{8})(\d{8})(\d{8})/.exec(text);
    if (!m || text.length < 77) return null;
    const year = parseInt(m[2].slice(0, 3), 10) + 1911, month = +m[2].slice(3, 5), day = +m[2].slice(5, 7);
    const dt = new Date(year, month - 1, day);
    if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) return null;
    const total = parseInt(m[5], 16);
    if (!(total > 0) || total > 1e8) return null;
    let items = [], enc = '1', itemsOnQR = NaN, totalItems = NaN;
    const ext = text.slice(77);
    if (ext.startsWith(':')) {
      const f = ext.slice(1).split(':'); // [自用區, 本QR品目數, 總品目數, 編碼, 品名, 數量, 單價, ...]
      itemsOnQR = parseInt(f[1], 10); totalItems = parseInt(f[2], 10);
      enc = f[3] || '1';
      items = invoiceItems(f.slice(4), enc);
    }
    return { kind: 'left', no: m[1], date: `${year}-${pad(month)}-${pad(day)}`, random: m[3], total, buyer: m[6], seller: m[7], enc, items, itemsOnQR, totalItems };
  }
  /** 品項數比左側 QR 記載的還多：還有品項放在右側 QR */
  const needsRightQR = l => Number.isFinite(l.itemsOnQR) && Number.isFinite(l.totalItems) && l.totalItems > l.itemsOnQR;

  const FUEL_NAME = /汽油|柴油|無鉛|超柴|燃油|(^|[^0-9])(92|95|98)(?![0-9])/;
  const NOT_FUEL = /機油|潤滑|齒輪|洗車|飲|水|煙|茶|咖啡|食品/;

  /** 從發票挑出油品品項，回傳要帶進加油表單的資料。油品品項的「數量」就是公升數 */
  function fuelFromInvoice(inv, extraItems = []) {
    const items = [...inv.items, ...extraItems].filter(it => it.qty > 0);
    const sub = it => it.qty * it.price;
    let by = 'name';
    let cand = items.filter(it => FUEL_NAME.test(it.name) && !NOT_FUEL.test(it.name));
    if (!cand.length) { // 品名看不懂時：單價像油價，且 數量×單價 ≈ 發票總計
      by = 'sum';
      cand = items.filter(it => it.price >= 10 && it.price <= 80 && it.qty < 300 && Math.abs(sub(it) - inv.total) <= Math.max(2, inv.total * 0.02));
    }
    cand.sort((a, b) => sub(b) - sub(a));
    const f = cand[0] || null;
    return {
      no: inv.no, date: inv.date, amount: inv.total,
      liters: f ? round(f.qty, 3) : null, ppl: f ? f.price : null, item: f ? f.name : null,
      fuelSubtotal: f ? round(sub(f), 2) : null, matchedBy: f ? by : null,
      itemCount: items.length
    };
  }

  /* ---------------- 匯出 CSV ---------------- */
  function toCsv(rows) {
    const q = v => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return '﻿' + rows.map(r => r.map(q).join(',')).join('\r\n');
  }

  G.VL = {
    round, ymd, todayStr, daysBetween, toDate, toNum,
    readFile, readXlsx, parseCsv, analyzeSheet, analyzeWorkbook,
    CATEGORIES, guessCategory, fuelKey, expKey,
    computeFuelRows, computeStats, toCsv, byDateOdo,
    parseInvoiceQR, needsRightQR, fuelFromInvoice, invoiceItems
  };
})(typeof window !== 'undefined' ? window : globalThis);
