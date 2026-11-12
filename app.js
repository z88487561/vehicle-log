(() => {
  'use strict';
  const VL = window.VL;
  const KEY = 'vehicle-log:v1';
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const fmt = (n, d = 2) => (n == null || !isFinite(n) ? '—' : Number(n).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const pct = r => fmt(r * 100, 2) + '%';
  const money = (n, d = 2) => (n == null || !isFinite(n) ? '—' : '$' + fmt(n, d));

  /* ---------------- 資料 ---------------- */
  const emptyDb = () => ({ version: 1, vehicles: [], fuel: [], expenses: [], settings: { current: null, includePurchase: true } });
  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY));
      if (d && Array.isArray(d.vehicles)) return { ...emptyDb(), ...d, settings: { ...emptyDb().settings, ...d.settings } };
    } catch {}
    return emptyDb();
  }
  let db = load();
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); }
    catch (e) { toast('儲存失敗：' + e.message); }
    scheduleBackup();
  }

  /* ---------------- 自動備份（Android App：文件／VehicleLog） ---------------- */
  const backupText = () => JSON.stringify({ app: 'vehicle-log', version: 1, exportedAt: new Date().toISOString(), data: db }, null, 1);
  let bkTimer = null, bkPruneDay = null;
  function scheduleBackup() {
    if (!Backup.canAuto) return;
    clearTimeout(bkTimer); bkTimer = setTimeout(runBackup, 1500);
  }
  async function runBackup() {
    clearTimeout(bkTimer); bkTimer = null;
    if (!Backup.canAuto || !db.vehicles.length) return;
    const day = VL.todayStr();
    const ok = await Backup.write(backupText(), day, bkPruneDay !== day);
    if (ok) bkPruneDay = day;
    renderBackupStatus();
  }
  function renderBackupStatus() {
    const st = Backup.status(), b = $('#bkBanner');
    if (b) {
      b.hidden = !st.alert;
      if (st.alert) b.innerHTML = `<span class="warn">⚠ ${esc(st.alert)}</span> <button class="btn" data-act="backup-share">分享備份</button>`;
    }
    const p = $('#bkStatus'); if (p) p.textContent = st.text;
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  const cur = () => db.vehicles.find(v => v.id === db.settings.current) || db.vehicles[0] || null;
  const fuelOf = vid => db.fuel.filter(f => f.vid === vid);
  const expOf = vid => db.expenses.filter(e => e.vid === vid);

  const ui = { tab: 'overview', fuelYear: 'all', expYear: 'all', expCat: 'all' };

  /* ---------------- 共用 UI ---------------- */
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    try { if (!t.matches(':popover-open')) t.showPopover(); } catch (e) {}
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.classList.remove('show'); try { t.hidePopover(); } catch (e) {} }, 3200);
  }

  const dlg = $('#dlg');
  let dlgSubmit = null;
  /** 開啟對話框。onSubmit(form) 回傳 false 代表驗證失敗、不關閉 */
  function openDialog(title, body, { submitText = '儲存', onSubmit, extraLeft = '', onOpen } = {}) {
    const f = $('#dlgForm');
    Object.keys(f.dataset).forEach(k => delete f.dataset[k]);   // 清掉上一個表單留下的狀態（例如掃到的發票號碼）
    f.oninput = null;
    f.innerHTML = `
      <div class="dlg-head">${esc(title)}</div>
      <div class="dlg-body">${body}</div>
      <div class="dlg-foot">${extraLeft ? `<span class="left">${extraLeft}</span>` : ''}
        <button type="button" class="btn ghost" data-act="dlg-cancel">取消</button>
        ${onSubmit ? `<button type="submit" class="btn primary">${esc(submitText)}</button>` : ''}
      </div>`;
    dlgSubmit = onSubmit || null;
    dlg.showModal();
    if (onOpen) onOpen($('#dlgForm'));
  }
  const closeDialog = () => { dlg.close(); dlgSubmit = null; };
  $('#dlgForm').addEventListener('submit', e => {
    e.preventDefault();
    if (!dlgSubmit) return closeDialog();
    if (dlgSubmit($('#dlgForm')) !== false) closeDialog();
  });
  dlg.addEventListener('click', e => { if (e.target === dlg) closeDialog(); });

  /** 存成檔案：瀏覽器觸發下載；Android App 存進「文件／VehicleLog」（WebView 不支援 blob 下載） */
  function download(name, content, type) {
    const p = Backup.download(new File([content], name, { type }));   // 瀏覽器版必須在點擊手勢內同步發動
    if (Backup.kind === 'native') p.then(n => toast(n ? `已存到「${Backup.savedWhere}」：${n}` : '存檔失敗，請確認儲存權限'));
  }
  /** 分享檔案；環境不支援或分享失敗就改為下載／存檔 */
  async function shareFile(file, title) {
    try {
      const r = await Backup.share(file, title);
      if (r === 'shared' || r === 'cancel') return;
    } catch (e) { /* 分享失敗：改為下載 */ }
    download(file.name, file, file.type);
    if (Backup.kind !== 'native') toast('這個瀏覽器無法直接分享檔案，已改為下載');
  }
  const val = (form, name) => { const el = form.elements[name]; return el ? el.value.trim() : ''; };
  const numOrNull = s => (s === '' ? null : VL.toNum(s));

  /* ---------------- 版面 ---------------- */
  function renderVehicleSelect() {
    const sel = $('#vehicleSel');
    const v = cur();
    sel.hidden = db.vehicles.length === 0;
    sel.innerHTML = db.vehicles.map(x => `<option value="${x.id}" ${v && x.id === v.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('') +
      '<option value="__new">＋ 新增車輛…</option>';
  }

  function render() {
    renderVehicleSelect();
    document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === ui.tab)));
    document.querySelectorAll('.tab').forEach(s => (s.hidden = s.id !== 'tab-' + ui.tab));
    const fn = { overview: renderOverview, fuel: renderFuel, expense: renderExpense, data: renderData }[ui.tab];
    $('#tab-' + ui.tab).innerHTML = fn();
    renderBackupStatus();
  }

  const emptyState = () => `
    <div class="card empty">
      <img class="icon" src="icons/icon-192.png" alt="">
      <h2>開始記錄你的愛車</h2>
      <p>記錄加油、保養與各項費用，自動算出平均油耗、每日與每公里花費。<br>可以管理多台車，也能直接匯入現有的 Excel 紀錄。</p>
      <div class="row" style="justify-content:center">
        <button class="btn primary" data-act="vehicle-new">新增車輛</button>
        <button class="btn" data-act="import">匯入 Excel / CSV</button>
      </div>
    </div>`;

  /* ---------------- 總覽 ---------------- */
  function kpi(label, value, unit, sub, cls = '') {
    return `<div class="kpi ${cls}"><div class="label">${label}</div><div class="value">${value}${unit ? `<span class="unit">${unit}</span>` : ''}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  }

  function renderOverview() {
    const v = cur();
    if (!v) return emptyState();
    const fuels = fuelOf(v.id), exps = expOf(v.id);
    const s = VL.computeStats(v, fuels, exps, { includePurchase: db.settings.includePurchase });
    const head = `
      <div class="card">
        <div class="vhead"><span class="name">${esc(v.name)}</span>
          <span class="chip">${esc(v.type || '機車')}</span>${v.plate ? `<span class="chip gray">${esc(v.plate)}</span>` : ''}</div>
        <div class="muted small" style="margin-top:4px">
          ${s.start ? `起算 ${s.start}・已使用 ${fmt(s.days, 0)} 天` : '尚無紀錄'}${s.curOdo != null ? `・目前里程 ${fmt(s.curOdo)} km` : ''}
        </div>
        <div class="row" style="margin-top:12px">
          <button class="btn primary" data-act="fuel-new">＋ 加油</button>
          <button class="btn" data-act="exp-new">＋ 保養／費用</button>
        </div>
      </div>`;
    if (!fuels.length && !exps.length) return head + `<div class="card muted">還沒有紀錄。新增第一筆加油或費用，或到「資料」頁匯入 Excel。</div>`;

    const oil = s.lastOil
      ? kpi('距上次換機油', fmt(s.lastOil.kmSince), 'km', `${s.lastOil.date}（${fmt(s.lastOil.daysSince, 0)} 天前）${s.lastGear ? `<br>齒輪油：${fmt(s.lastGear.kmSince)} km 前` : ''}`)
      : kpi('保養紀錄', fmt(exps.length, 0), '筆', '備註含「機油」的費用會顯示距上次換機油的里程');

    const kpis = `<div class="kpis">
      ${kpi('平均油耗', fmt(s.avgKmpl, 2), 'km/L', `最近 5 次 ${fmt(s.recentKmpl, 2)}・上次 ${fmt(s.lastKmpl, 2)}`, 'hero')}
      ${kpi('每日費用', money(s.totalPerDay, 2), '', `油資 ${money(s.fuelPerDay, 2)}／天`, 'hero')}
      ${kpi('總花費', money(s.total), '', `油資 ${money(s.fuelTotal)}・其他 ${money(s.expTotal)}`)}
      ${kpi('每公里費用', money(s.totalPerKm, 2), '', `油資 ${money(s.fuelPerKm, 2)}／km`)}
      ${kpi('每年估算', s.totalPerYear != null ? money(s.totalPerYear) : '—', '', s.totalPerYear != null ? `油資 ${money(s.fuelPerYear)}／年` : '使用滿半年後才估算')}
      ${kpi('行駛里程', fmt(s.km), 'km', s.avgFillKm ? `平均每 ${fmt(s.avgFillDays, 2)} 天加油、跑 ${fmt(s.avgFillKm)} km` : '')}
      ${kpi('平均油價', fmt(s.avgPpl, 2), '元/L', `上次 ${fmt(s.lastPpl, 2)}・共 ${fmt(s.litersTotal, 2)} L`)}
      ${oil}
    </div>`;

    const purchaseToggle = s.purchase > 0 ? `
      <label class="check small" style="margin:-2px 0 12px 2px">
        <input type="checkbox" data-act="toggle-purchase" ${db.settings.includePurchase ? 'checked' : ''}>
        費用計算包含購車價（${money(s.purchase)}）
      </label>` : '';

    const cats = [['油資', s.fuelTotal], ...Object.entries(s.byCat).filter(([k]) => db.settings.includePurchase || k !== '購車')]
      .filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    const maxCat = Math.max(...cats.map(c => c[1]), 1);
    const catCard = cats.length ? `
      <div class="card"><h2>花費分類<small>合計 ${money(s.total)}</small></h2>
        <div class="bars">${cats.map(([k, n]) => `
          <div class="bar-row" title="${esc(k)}：${money(n)}（${fmt(n / s.total * 100, 2)}%）">
            <span>${esc(k)}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${(n / maxCat * 100).toFixed(2)}%"></span></span>
            <span class="amt">${money(n)}<small>${pct(n / s.total)}</small></span>
          </div>`).join('')}
        </div></div>` : '';

    const yearCard = s.years.length ? `
      <div class="card"><h2>年度統計</h2>
        <div class="table-wrap"><table>
          <thead><tr><th class="l">年度</th><th>油資</th><th>其他費用</th><th>合計</th><th>里程 km</th><th>油耗 km/L</th><th>加油次數</th></tr></thead>
          <tbody>${s.years.map(y => `<tr style="cursor:default"><td class="l">${y.year}</td><td>${fmt(y.fuel)}</td><td>${fmt(y.exp)}</td><td>${fmt(y.total)}</td><td>${fmt(y.km)}</td><td>${fmt(y.kmpl, 2)}</td><td>${fmt(y.fills, 0)}</td></tr>`).join('')}</tbody>
        </table></div></div>` : '';

    return head + kpis + purchaseToggle + catCard + yearCard;
  }

  /* ---------------- 加油 ---------------- */
  const SCAN_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/></svg>';
  const yearsOf = list => [...new Set(list.map(x => x.date.slice(0, 4)))].sort().reverse();
  const yearSelect = (act, list, value) => `<select data-act="${act}" aria-label="年度">
      <option value="all">全部年度</option>${yearsOf(list).map(y => `<option ${y === value ? 'selected' : ''}>${y}</option>`).join('')}</select>`;

  function renderFuel() {
    const v = cur();
    if (!v) return emptyState();
    const all = VL.computeFuelRows(fuelOf(v.id)).rows;
    const rows = all.filter(r => ui.fuelYear === 'all' || r.date.startsWith(ui.fuelYear)).reverse();
    const sumA = rows.reduce((s, r) => s + (+r.amount || 0), 0), sumL = rows.reduce((s, r) => s + (+r.liters || 0), 0);
    const segs = rows.filter(r => r.kmpl);
    return `
      <div class="toolbar">${yearSelect('fuel-year', all, ui.fuelYear)}<span class="spacer"></span>
        <button class="btn" data-act="fuel-scan-new">${SCAN_ICON} 掃發票</button>
        <button class="btn primary" data-act="fuel-new">＋ 新增加油</button></div>
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th class="l">日期</th><th>金額</th><th>公升</th><th>本次里程</th><th>油耗</th><th>油價</th><th>總里程</th><th class="l">備註</th></tr></thead>
        <tbody>${rows.map(r => `<tr data-act="fuel-edit" data-id="${r.id}">
          <td class="l">${r.date}</td><td>${fmt(r.amount)}</td><td>${fmt(r.liters, 2)}</td>
          <td>${fmt(r.dist)}</td><td><b>${fmt(r.kmpl, 2)}</b></td><td>${fmt(r.ppl, 2)}</td><td>${fmt(r.odo)}</td>
          <td class="note">${r.full === false ? '<span class="tag warn">未加滿</span> ' : ''}${esc(r.note)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td class="l">${rows.length} 筆</td><td>${fmt(sumA)}</td><td>${fmt(sumL, 2)}</td><td></td>
          <td>${fmt(weightedKmpl(segs), 2)}</td><td>${sumL ? fmt(sumA / sumL, 2) : '—'}</td><td></td><td></td></tr></tfoot>
      </table></div>
      <p class="muted small">油耗採「滿到滿」計算：從上一次加滿到這一次加滿之間的里程 ÷ 期間加的油量。第一筆只當起點。點任一列可編輯。</p>`
      : `<div class="card muted">${ui.fuelYear === 'all' ? '還沒有加油紀錄。' : '這個年度沒有加油紀錄。'}</div>`}`;
  }
  // 篩選範圍內的加權平均油耗：Σ滿到滿里程 ÷ Σ期間油量（與總覽算法一致）
  function weightedKmpl(segRows) {
    const km = segRows.reduce((s, r) => s + r.segKm, 0), l = segRows.reduce((s, r) => s + r.segL, 0);
    return l > 0 ? km / l : null;
  }

  function fuelForm(rec, opt = {}) {
    const v = cur();
    const isEdit = !!rec;
    const r = rec || { date: VL.todayStr(), amount: '', odo: '', liters: '', full: true, note: '' };
    const body = `
      <button type="button" class="btn scan-btn" data-act="fuel-scan">${SCAN_ICON} 掃描發票，自動帶入日期、金額、公升</button>
      <div class="grid2">
        <div class="field"><label>日期</label><input type="date" name="date" value="${r.date}" required></div>
        <div class="field"><label>金額（元）</label><input type="number" name="amount" inputmode="decimal" step="any" min="0" value="${r.amount ?? ''}" required></div>
        <div class="field"><label>總里程（km）</label><input type="number" name="odo" inputmode="decimal" step="any" min="0" value="${r.odo ?? ''}" required></div>
        <div class="field"><label>公升</label><input type="number" name="liters" inputmode="decimal" step="any" min="0" value="${r.liters ?? ''}" placeholder="或填下方油價"></div>
        <div class="field"><label>油價（元/L，選填）</label><input type="number" name="ppl" inputmode="decimal" step="any" min="0" placeholder="自動換算公升"></div>
        <div class="field" style="display:flex;align-items:flex-end"><label class="check"><input type="checkbox" name="full" ${r.full !== false ? 'checked' : ''}>有加滿</label></div>
      </div>
      <div class="field"><label>備註</label><input type="text" name="note" value="${esc(r.note)}" placeholder="例如：95 無鉛、某加油站"></div>
      <div class="hint" id="fuelHint"></div>`;
    openDialog(isEdit ? '編輯加油紀錄' : '新增加油', body, {
      extraLeft: isEdit ? `<button type="button" class="btn danger" data-act="fuel-del" data-id="${rec.id}">刪除</button>` : '',
      onOpen(form) {
        if (rec) form.dataset.editId = rec.id;
        const upd = () => updateFuelHint(form, v, rec);
        form.oninput = upd; upd();
        if (opt.autoScan) scanInvoice();
        else if (!isEdit) form.elements.amount.focus();
      },
      onSubmit(form) {
        const amount = numOrNull(val(form, 'amount')), odo = numOrNull(val(form, 'odo'));
        let liters = numOrNull(val(form, 'liters'));
        const ppl = numOrNull(val(form, 'ppl'));
        if (!liters && ppl && amount) liters = VL.round(amount / ppl, 3);
        if (!val(form, 'date') || amount == null || odo == null || !liters) { toast('請填寫日期、金額、總里程，以及公升或油價'); return false; }
        const data = { date: val(form, 'date'), amount, odo, liters, full: form.elements.full.checked, note: val(form, 'note') };
        if (form.dataset.inv) data.inv = form.dataset.inv;   // 記下發票號碼，之後可以提醒重複掃描
        if (isEdit) Object.assign(db.fuel.find(f => f.id === rec.id), data);
        else db.fuel.push({ id: uid(), vid: v.id, ...data });
        save(); render(); toast(isEdit ? '已更新' : '已新增加油紀錄');
      }
    });
  }

  /** 開啟掃描視窗；掃到後把日期、金額、公升帶進目前開著的加油表單，並把焦點移到里程 */
  function scanInvoice() {
    const form = $('#dlgForm');
    if (!form.elements.odo || !window.VLScan) return;
    VLScan.open(r => applyInvoice(form, r));
  }
  function applyInvoice(form, r) {
    const set = (name, v) => { form.elements[name].value = v; };
    set('date', r.date); set('amount', r.amount);
    if (r.liters != null) { set('liters', r.liters); set('ppl', ''); }
    form.dataset.inv = r.no;
    const no = r.no.slice(0, 2) + '-' + r.no.slice(2);
    const notes = [`📷 已從發票 ${no} 帶入日期、金額${r.liters != null ? '、公升' : ''}`];
    if (r.liters == null) notes.push('<span class="warn">發票內沒有找到油量，請自己填公升（或填油價）</span>');
    else if (r.fuelSubtotal != null && Math.abs(r.fuelSubtotal - r.amount) > 1) notes.push(`<span class="warn">發票總計 ${money(r.amount)}，其中油品 ${money(r.fuelSubtotal)}，已填總計，需要的話請自行修改</span>`);
    const dup = db.fuel.find(f => f.inv === r.no && f.id !== (form.dataset.editId || ''));
    if (dup) notes.push(`<span class="warn">⚠ 這張發票已經記錄過了（${dup.date}）</span>`);
    form.dataset.scanNote = notes.join('<br>');
    form.dispatchEvent(new Event('input', { bubbles: true }));
    toast(dup ? '這張發票已經記錄過了' : '已帶入發票資料，請填寫里程');
    // 等掃描視窗關閉、焦點還給原本的按鈕之後，再把焦點移到里程
    setTimeout(() => { const odo = form.elements.odo; odo.focus(); odo.select(); odo.scrollIntoView({ block: 'center' }); }, 80);
  }

  function updateFuelHint(form, v, rec) {
    const hint = $('#fuelHint', form);
    const amount = numOrNull(val(form, 'amount')), odo = numOrNull(val(form, 'odo'));
    let liters = numOrNull(val(form, 'liters'));
    const ppl = numOrNull(val(form, 'ppl'));
    const msgs = form.dataset.scanNote ? [form.dataset.scanNote] : [];
    if (!liters && ppl && amount) { liters = amount / ppl; msgs.push(`換算約 ${fmt(liters, 2)} L`); }
    if (amount && liters) msgs.push(`油價 ${fmt(amount / liters, 2)} 元/L`);
    const date = val(form, 'date');
    const others = fuelOf(v.id).filter(f => !rec || f.id !== rec.id);
    if (date && odo != null && liters) {
      const tmp = { id: '__tmp', date, amount: amount || 0, odo, liters, full: form.elements.full.checked };
      const rows = VL.computeFuelRows([...others, tmp]).rows;
      const me = rows.find(x => x.id === '__tmp');
      const prev = rows[rows.indexOf(me) - 1];
      if (prev) {
        msgs.push(`距上次加油 ${fmt(me.dist)} km`);
        if (me.dist != null && me.dist <= 0) msgs.push(`<span class="warn">⚠ 里程沒有比上一筆（${prev.date}，${fmt(prev.odo)} km）多</span>`);
      }
      if (me.kmpl) msgs.push(`本次油耗 <b>${fmt(me.kmpl, 2)} km/L</b>`);
      else if (!prev) msgs.push('第一筆加油只當起點，從下一次加滿開始算油耗');
    } else {
      const last = VL.computeFuelRows(others).rows.pop();
      if (last) msgs.push(`上次加油：${last.date}，${fmt(last.odo)} km`);
    }
    hint.innerHTML = msgs.join('　') || '填入金額、里程與公升後，會即時算出油價與本次油耗。';
  }

  /* ---------------- 費用 ---------------- */
  function renderExpense() {
    const v = cur();
    if (!v) return emptyState();
    const all = expOf(v.id).sort(VL.byDateOdo);
    const rows = all.filter(r => (ui.expYear === 'all' || r.date.startsWith(ui.expYear)) && (ui.expCat === 'all' || r.category === ui.expCat)).reverse();
    const cats = [...new Set(all.map(r => r.category))];
    const sum = rows.reduce((s, r) => s + (+r.amount || 0), 0);
    return `
      <div class="toolbar">${yearSelect('exp-year', all, ui.expYear)}
        <select data-act="exp-cat" aria-label="分類"><option value="all">全部分類</option>${VL.CATEGORIES.filter(c => cats.includes(c)).map(c => `<option ${c === ui.expCat ? 'selected' : ''}>${c}</option>`).join('')}</select>
        <span class="spacer"></span><button class="btn primary" data-act="exp-new">＋ 新增費用</button></div>
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th class="l">日期</th><th class="l">項目</th><th>金額</th><th class="l">分類</th><th>里程</th></tr></thead>
        <tbody>${rows.map(r => `<tr data-act="exp-edit" data-id="${r.id}">
          <td class="l">${r.date}</td><td class="note">${esc(r.note) || '<span class="muted">—</span>'}</td><td>${fmt(r.amount)}</td><td class="l">${esc(r.category)}</td><td>${fmt(r.odo)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td class="l">${rows.length} 筆</td><td></td><td>${fmt(sum)}</td><td></td><td></td></tr></tfoot>
      </table></div><p class="muted small">點任一列可編輯。保養、維修、保險、稅金、購車等加油以外的花費都記在這裡。</p>`
      : `<div class="card muted">沒有符合條件的費用紀錄。</div>`}`;
  }

  function expenseForm(rec) {
    const v = cur();
    const isEdit = !!rec;
    const r = rec || { date: VL.todayStr(), amount: '', odo: '', category: '保養', note: '' };
    const notes = [...new Set(expOf(v.id).map(e => e.note).filter(Boolean))].slice(-40);
    const curOdo = Math.max(...[...fuelOf(v.id), ...expOf(v.id)].map(x => x.odo).filter(x => x != null), -Infinity);
    const body = `
      <div class="field"><label>項目／備註</label><input type="text" name="note" list="noteList" value="${esc(r.note)}" placeholder="例如：機油齒輪油、後輪、強制險" ${isEdit ? '' : 'autofocus'}>
        <datalist id="noteList">${notes.map(n => `<option value="${esc(n)}">`).join('')}</datalist></div>
      <div class="grid2">
        <div class="field"><label>日期</label><input type="date" name="date" value="${r.date}" required></div>
        <div class="field"><label>分類</label><select name="category" style="width:100%">${VL.CATEGORIES.map(c => `<option ${c === r.category ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        <div class="field"><label>金額（元）</label><input type="number" name="amount" inputmode="decimal" step="any" min="0" value="${r.amount ?? ''}" required></div>
        <div class="field"><label>里程（km，選填）</label><input type="number" name="odo" inputmode="decimal" step="any" min="0" value="${r.odo ?? ''}" placeholder="${isFinite(curOdo) ? '目前 ' + fmt(curOdo) : ''}"></div>
      </div>`;
    openDialog(isEdit ? '編輯費用' : '新增保養／費用', body, {
      extraLeft: isEdit ? `<button type="button" class="btn danger" data-act="exp-del" data-id="${rec.id}">刪除</button>` : '',
      onOpen(form) {
        let touched = isEdit;
        form.elements.category.addEventListener('change', () => (touched = true));
        form.elements.note.addEventListener('input', () => { if (!touched) form.elements.category.value = VL.guessCategory(form.elements.note.value); });
      },
      onSubmit(form) {
        const amount = numOrNull(val(form, 'amount'));
        if (!val(form, 'date') || amount == null) { toast('請填寫日期與金額'); return false; }
        const data = { date: val(form, 'date'), amount, odo: numOrNull(val(form, 'odo')), category: val(form, 'category'), note: val(form, 'note') };
        if (isEdit) Object.assign(db.expenses.find(e => e.id === rec.id), data);
        else db.expenses.push({ id: uid(), vid: v.id, ...data });
        save(); render(); toast(isEdit ? '已更新' : '已新增費用');
      }
    });
  }

  /* ---------------- 車輛 ---------------- */
  function vehicleForm(rec) {
    const isEdit = !!rec;
    const r = rec || { name: '', type: '機車', plate: '', startDate: '', startOdo: '', note: '' };
    const body = `
      <div class="field"><label>名稱</label><input type="text" name="name" value="${esc(r.name)}" placeholder="例如：胖迪、家裡的車" required></div>
      <div class="grid2">
        <div class="field"><label>類型</label><select name="type" style="width:100%">${['機車', '汽車', '其他'].map(t => `<option ${t === r.type ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="field"><label>車牌（選填）</label><input type="text" name="plate" value="${esc(r.plate)}"></div>
        <div class="field"><label>起算日／購車日</label><input type="date" name="startDate" value="${r.startDate || ''}"></div>
        <div class="field"><label>起始里程（km）</label><input type="number" name="startOdo" inputmode="decimal" step="any" min="0" value="${r.startOdo ?? ''}" placeholder="新車填 0"></div>
      </div>
      <div class="field"><label>備註</label><input type="text" name="note" value="${esc(r.note)}"></div>
      <p class="muted small">起算日用來計算每日費用；沒填的話會用最早一筆紀錄的日期。</p>`;
    openDialog(isEdit ? '編輯車輛' : '新增車輛', body, {
      onSubmit(form) {
        const name = val(form, 'name');
        if (!name) { toast('請輸入名稱'); return false; }
        const data = { name, type: val(form, 'type'), plate: val(form, 'plate'), startDate: val(form, 'startDate'), startOdo: numOrNull(val(form, 'startOdo')), note: val(form, 'note') };
        if (isEdit) Object.assign(db.vehicles.find(x => x.id === rec.id), data);
        else { const nv = { id: uid(), ...data }; db.vehicles.push(nv); db.settings.current = nv.id; }
        save(); render(); toast(isEdit ? '已更新車輛' : '已新增車輛');
      }
    });
  }

  function deleteVehicle(id) {
    const v = db.vehicles.find(x => x.id === id);
    if (!v) return;
    const n = fuelOf(id).length + expOf(id).length;
    if (!confirm(`確定刪除「${v.name}」？\n這台車的 ${n} 筆紀錄也會一起刪除，且無法復原。`)) return;
    db.vehicles = db.vehicles.filter(x => x.id !== id);
    db.fuel = db.fuel.filter(x => x.vid !== id);
    db.expenses = db.expenses.filter(x => x.vid !== id);
    if (db.settings.current === id) db.settings.current = db.vehicles[0]?.id || null;
    save(); render(); toast('已刪除');
  }

  /* ---------------- 資料頁 ---------------- */
  function renderData() {
    const v = cur();
    return `
      <div class="card"><h2>車輛</h2>
        <div class="list">${db.vehicles.map(x => `
          <div class="list-item"><div class="grow"><div class="t">${esc(x.name)} ${x.id === v?.id ? '<span class="chip">目前</span>' : ''}</div>
            <div class="muted small">${esc(x.type || '')}${x.plate ? '・' + esc(x.plate) : ''}・加油 ${fuelOf(x.id).length} 筆・費用 ${expOf(x.id).length} 筆</div></div>
            <button class="btn" data-act="vehicle-edit" data-id="${x.id}">編輯</button>
            <button class="btn danger" data-act="vehicle-del" data-id="${x.id}">刪除</button></div>`).join('') || '<div class="muted">尚未新增車輛</div>'}
        </div>
        <div class="row" style="margin-top:10px"><button class="btn primary" data-act="vehicle-new">＋ 新增車輛</button></div>
      </div>

      <div class="card"><h2>匯入 Excel / CSV</h2>
        <p class="muted small" style="margin-top:0">會自動找出含「日期」「金額」的表頭。有「公升／本次加油」欄的列當作加油紀錄，其他列當作費用紀錄；「里程／總里程」「備註」欄也會一起匯入。由明細算出來的「總花費」彙總表預設不匯入，避免重複。已存在的相同紀錄會自動略過。</p>
        <button class="btn primary" data-act="import">選擇檔案（.xlsx / .csv）</button>
      </div>

      <div class="card"><h2>完整 CSV<small>全部車輛、加油、費用</small></h2>
        <p class="muted small" style="margin-top:0">把所有車輛的紀錄放在同一個 CSV，可以傳給其他裝置，或用 Excel 開啟編輯。匯入時會<b>覆蓋</b>目前所有資料。</p>
        <div class="row">
          <button class="btn primary" data-act="csv-share" ${db.vehicles.length ? '' : 'disabled'}>分享完整 CSV</button>
          <button class="btn" data-act="csv-download" ${db.vehicles.length ? '' : 'disabled'}>下載</button>
          <button class="btn" data-act="csv-restore">匯入完整 CSV（覆蓋）</button>
        </div>
      </div>

      <div class="card"><h2>備份與匯出</h2>
        <p class="muted small" id="bkStatus" style="margin-top:0">${esc(Backup.status().text)}</p>
        <div class="row">
          <button class="btn" data-act="backup">匯出完整備份（.json）</button>
          <button class="btn" data-act="backup-share">分享備份</button>
          <button class="btn" data-act="restore">從備份還原</button>
          ${v ? `<button class="btn" data-act="csv">匯出「${esc(v.name)}」為 CSV</button>` : ''}
        </div>
      </div>

      <div class="card"><h2>其他</h2>
        <button class="btn danger" data-act="wipe">清除所有資料</button>
        <p class="muted small">油耗保養紀錄・資料不會上傳到任何伺服器</p>
      </div>`;
  }

  /* ---------------- 匯入 ---------------- */
  async function handleImportFile(file) {
    let analyzed;
    try {
      const sheets = await VL.readFile(file.name, await file.arrayBuffer());
      analyzed = VL.analyzeWorkbook(sheets).filter(s => s.fuel.length || s.expense.length);
    } catch (e) { toast('讀取失敗：' + e.message); return; }
    if (!analyzed.length) { toast('找不到可匯入的資料（需要有「日期」與「金額」欄位的表頭）'); return; }
    const baseName = file.name.replace(/\.[^.]+$/, '');
    const v = cur();
    const body = `
      <p class="muted small" style="margin-top:0">檔案：${esc(file.name)}</p>
      ${analyzed.map((s, i) => {
        const dates = [...s.fuel, ...s.expense].map(x => x.date).sort();
        return `<label class="sheet check" style="align-items:flex-start">
          <input type="checkbox" name="sheet${i}" ${s.include ? 'checked' : ''} style="margin-top:3px">
          <span><b>${esc(s.name)}</b><br><span class="small">${s.fuel.length ? `加油 ${s.fuel.length} 筆　` : ''}${s.expense.length ? `費用 ${s.expense.length} 筆　` : ''}${s.skipped ? `<span class="muted">略過 ${s.skipped} 列（沒有日期或金額）</span>` : ''}</span>
          <br><span class="muted small">${dates[0]} ～ ${dates[dates.length - 1]}${s.summary ? '<br>這張看起來是由其他表算出的彙總表，勾選會造成重複' : ''}</span></span></label>`;
      }).join('')}
      <div class="field" style="margin-top:12px"><label>匯入到</label>
        <select name="target" style="width:100%">
          <option value="__new">新增車輛</option>
          ${db.vehicles.map(x => `<option value="${x.id}">${esc(x.name)}${x.id === v?.id ? '（目前）' : ''}</option>`).join('')}
        </select></div>
      <div id="newVehicleFields" class="grid2">
        <div class="field"><label>新車輛名稱</label><input type="text" name="vname" value="${esc(baseName)}"></div>
        <div class="field"><label>類型</label><select name="vtype" style="width:100%"><option>機車</option><option>汽車</option><option>其他</option></select></div>
      </div>`;
    openDialog('匯入資料', body, {
      submitText: '匯入',
      onOpen(form) {
        const t = form.elements.target;
        const upd = () => ($('#newVehicleFields', form).hidden = t.value !== '__new');
        t.addEventListener('change', upd); upd();
      },
      onSubmit(form) {
        const chosen = analyzed.filter((s, i) => form.elements['sheet' + i].checked);
        if (!chosen.length) { toast('請至少勾選一張工作表'); return false; }
        let vid = val(form, 'target');
        const fuels = chosen.flatMap(s => s.fuel), exps = chosen.flatMap(s => s.expense);
        if (vid === '__new') {
          const name = val(form, 'vname') || baseName;
          const dates = [...fuels, ...exps].map(x => x.date).sort();
          const odos = [...fuels, ...exps].map(x => x.odo).filter(x => x != null);
          const nv = { id: uid(), name, type: val(form, 'vtype'), plate: '', startDate: dates[0] || '', startOdo: odos.length ? Math.min(...odos) : null, note: `從 ${file.name} 匯入` };
          db.vehicles.push(nv); vid = nv.id;
        }
        const fk = new Set(fuelOf(vid).map(VL.fuelKey)), ek = new Set(expOf(vid).map(VL.expKey));
        let nf = 0, ne = 0, dup = 0;
        fuels.forEach(f => { const k = VL.fuelKey(f); if (fk.has(k)) { dup++; return; } fk.add(k); db.fuel.push({ id: uid(), vid, ...f }); nf++; });
        exps.forEach(e => { const k = VL.expKey(e); if (ek.has(k)) { dup++; return; } ek.add(k); db.expenses.push({ id: uid(), vid, ...e }); ne++; });
        db.settings.current = vid;
        save(); ui.tab = 'overview'; render();
        toast(`已匯入加油 ${nf} 筆、費用 ${ne} 筆${dup ? `（略過重複 ${dup} 筆）` : ''}`);
      }
    });
  }

  /* ---------------- 備份 ---------------- */
  const backupName = () => `油耗保養紀錄備份-${VL.todayStr()}.json`;
  function backup() { download(backupName(), backupText(), 'application/json'); }
  async function shareBackup() {
    if (!db.vehicles.length) { toast('還沒有資料可以分享'); return; }
    await shareFile(new File([backupText()], backupName(), { type: 'application/json' }), '油耗保養備份 JSON');
  }
  async function restore(file) {
    try {
      const j = JSON.parse(await file.text());
      const d = j.data || j;
      if (!Array.isArray(d.vehicles) || !Array.isArray(d.fuel) || !Array.isArray(d.expenses)) throw new Error('格式不符');
      if (!confirm(`備份內有 ${d.vehicles.length} 台車、加油 ${d.fuel.length} 筆、費用 ${d.expenses.length} 筆。\n還原會取代目前所有資料，確定嗎？`)) return;
      db = { ...emptyDb(), ...d, settings: { ...emptyDb().settings, ...d.settings } };
      save(); render(); toast('已還原備份');
    } catch (e) { toast('還原失敗：' + e.message); }
  }
  /* ---------- 完整 CSV：分享／下載／覆蓋匯入 ---------- */
  const fullCsvName = () => `油耗保養紀錄完整-${VL.todayStr()}.csv`;
  function downloadFullCsv() {
    if (!db.vehicles.length) { toast('還沒有資料可以匯出'); return; }
    download(fullCsvName(), VL.buildFullCsv(db), 'text/csv');
  }
  async function shareFullCsv() {
    if (!db.vehicles.length) { toast('還沒有資料可以分享'); return; }
    const csv = VL.buildFullCsv(db);
    await shareFile(new File([csv], fullCsvName(), { type: 'text/csv' }), '油耗保養紀錄完整 CSV');
  }
  async function handleFullCsv(file) {
    let parsed;
    try { parsed = VL.parseFullCsv(VL.decodeText(await file.arrayBuffer()), uid); }
    catch (e) { toast(e.message || '讀取失敗'); return; }
    if (!parsed.vehicles.length && !parsed.fuel.length && !parsed.expenses.length) { toast('檔案裡沒有可以匯入的資料'); return; }
    const row = (label, a, b) => `<tr style="cursor:default"><td class="l">${label}</td><td>${a}</td><td>${b}</td></tr>`;
    const body = `
      <p style="margin-top:0">檔案：${esc(file.name)}</p>
      <div class="table-wrap"><table>
        <thead><tr><th class="l"></th><th>目前</th><th>匯入後</th></tr></thead>
        <tbody>${row('車輛', db.vehicles.length, parsed.vehicles.length)}${row('加油紀錄', db.fuel.length, parsed.fuel.length)}${row('費用紀錄', db.expenses.length, parsed.expenses.length)}</tbody>
      </table></div>
      <div class="hint" style="margin-top:12px"><span class="warn">⚠ 目前所有車輛與紀錄會被取代，無法復原。</span> 不確定的話，先按左下角下載目前的資料當備份。</div>
      ${parsed.skipped ? `<div class="hint"><b>略過 ${parsed.skipped} 列：</b><br>${parsed.notes.slice(0, 8).map(esc).join('<br>')}${parsed.notes.length > 8 ? `<br>…還有 ${parsed.notes.length - 8} 列` : ''}</div>` : ''}`;
    openDialog('匯入完整 CSV（覆蓋）', body, {
      submitText: '覆蓋匯入',
      extraLeft: db.vehicles.length ? '<button type="button" class="btn" data-act="csv-download">先下載目前資料</button>' : '',
      onSubmit() {
        const keep = cur();
        const same = keep && parsed.vehicles.find(v => v.name === keep.name);
        db = { ...emptyDb(), vehicles: parsed.vehicles, fuel: parsed.fuel, expenses: parsed.expenses,
          settings: { current: (same || parsed.vehicles[0] || {}).id || null, includePurchase: db.settings.includePurchase } };
        ui.fuelYear = ui.expYear = ui.expCat = 'all'; ui.tab = 'overview';
        save(); render();
        toast(`已覆蓋匯入：${parsed.vehicles.length} 台車、加油 ${parsed.fuel.length} 筆、費用 ${parsed.expenses.length} 筆`);
      }
    });
  }

  function exportCsv() {
    const v = cur(); if (!v) return;
    const fr = VL.computeFuelRows(fuelOf(v.id)).rows;
    const r = VL.round;
    download(`${v.name}-加油.csv`, VL.toCsv([['日期', '金額', '總里程', '本次加油(L)', '本次里程', '本次油耗(km/L)', '油價', '加滿', '備註'],
      ...fr.map(x => [x.date, x.amount, x.odo, x.liters, x.dist, r(x.kmpl, 2), r(x.ppl, 2), x.full === false ? '否' : '是', x.note])]), 'text/csv');
    setTimeout(() => download(`${v.name}-費用.csv`, VL.toCsv([['日期', '分類', '金額', '里程', '備註'],
      ...expOf(v.id).sort(VL.byDateOdo).map(x => [x.date, x.category, x.amount, x.odo, x.note])]), 'text/csv'), 400);
  }

  /* ---------------- 事件 ---------------- */
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type === 'checkbox')) return;
    const id = el.dataset.id;
    switch (el.dataset.act) {
      case 'dlg-cancel': closeDialog(); break;
      case 'fuel-new': fuelForm(); break;
      case 'fuel-scan-new': fuelForm(null, { autoScan: true }); break;
      case 'fuel-scan': scanInvoice(); break;
      case 'fuel-edit': fuelForm(db.fuel.find(f => f.id === id)); break;
      case 'fuel-del':
        if (confirm('確定刪除這筆加油紀錄？')) { db.fuel = db.fuel.filter(f => f.id !== id); save(); closeDialog(); render(); toast('已刪除'); }
        break;
      case 'exp-new': expenseForm(); break;
      case 'exp-edit': expenseForm(db.expenses.find(x => x.id === id)); break;
      case 'exp-del':
        if (confirm('確定刪除這筆費用？')) { db.expenses = db.expenses.filter(x => x.id !== id); save(); closeDialog(); render(); toast('已刪除'); }
        break;
      case 'vehicle-new': vehicleForm(); break;
      case 'vehicle-edit': vehicleForm(db.vehicles.find(x => x.id === id)); break;
      case 'vehicle-del': deleteVehicle(id); break;
      case 'import': $('#fileImport').click(); break;
      case 'backup': backup(); break;
      case 'backup-share': shareBackup(); break;
      case 'restore': $('#fileRestore').click(); break;
      case 'csv': exportCsv(); break;
      case 'csv-share': shareFullCsv(); break;
      case 'csv-download': downloadFullCsv(); break;
      case 'csv-restore': $('#fileFullCsv').click(); break;
      case 'wipe':
        if (confirm('確定清除所有車輛與紀錄？建議先匯出備份。') && confirm('真的要清除嗎？此動作無法復原。')) { db = emptyDb(); save(); render(); toast('已清除'); }
        break;
    }
  });
  document.addEventListener('change', e => {
    const el = e.target;
    switch (el.dataset.act) {
      case 'fuel-year': ui.fuelYear = el.value; render(); break;
      case 'exp-year': ui.expYear = el.value; render(); break;
      case 'exp-cat': ui.expCat = el.value; render(); break;
      case 'toggle-purchase': db.settings.includePurchase = el.checked; save(); render(); break;
    }
  });
  $('#vehicleSel').addEventListener('change', e => {
    if (e.target.value === '__new') { renderVehicleSelect(); vehicleForm(); return; }
    db.settings.current = e.target.value; ui.fuelYear = ui.expYear = ui.expCat = 'all'; save(); render();
  });
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => { ui.tab = b.dataset.tab; render(); window.scrollTo(0, 0); }));
  $('#fileImport').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) handleImportFile(f); });
  $('#fileFullCsv').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) handleFullCsv(f); });
  $('#fileRestore').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) restore(f); });

  render();
  scheduleBackup();   // 啟動時備份一次，也能立刻發現寫入問題
  document.addEventListener('visibilitychange', () => { if (document.hidden && bkTimer) runBackup(); });
  if (!IS_NATIVE && 'serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
