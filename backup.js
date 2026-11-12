/* ==================== 備份目標（BackupTarget）====================
   app.js 只透過 window.Backup 和平台溝通；每個平台各自實作同一組介面：
     kind        'native'（Android App：文件／VehicleLog）｜'web'（瀏覽器：只能下載、分享）
     canAuto     是否支援自動備份
     savedWhere  提示訊息用的存放位置名稱
     status()    -> { text, alert }  text 顯示在「備份與匯出」；alert 有值時首頁顯示警告橫幅
     write(text, day, prune)  Promise<bool>   自動備份：寫 latest 和當日檔；prune 時清除過期檔
     share(file, title)       Promise<'shared'|'cancel'|false>   叫出分享選單；不能分享回傳 false，失敗則丟出錯誤
     download(file)           Promise<string|false>   native：存進 Documents 並回傳檔名；web：觸發瀏覽器下載
   備份格式（JSON）與還原流程在 app.js，兩個平台共用。 */
(() => {
  'use strict';
  const IS_NATIVE = !!(window.Capacitor && typeof Capacitor.isNativePlatform === 'function' && Capacitor.isNativePlatform());
  const DIR = 'VehicleLog', KEEP_DAYS = 7;
  const fileName = d => `vehicle-log_${d}.json`;
  const dayStr = off => {
    const t = new Date(Date.now() - off * 864e5);
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  };

  /* ---------- 瀏覽器：只能手動下載／分享 ---------- */
  function webShare(file, title) {
    // 必須在點擊手勢內同步呼叫 navigator.share，所以這裡不能有 await
    if (!(navigator.canShare && navigator.canShare({ files: [file] }))) return Promise.resolve(false);
    return navigator.share({ files: [file], title }).then(() => 'shared', e => { if (e && e.name === 'AbortError') return 'cancel'; throw e; });
  }
  function anchorDownload(file) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return Promise.resolve(file.name);
  }
  const WebBackup = {
    kind: 'web', canAuto: false, savedWhere: '',
    status: () => ({ text: '資料只存在這台裝置的瀏覽器裡。清除瀏覽器資料或換手機前，請先匯出備份。', alert: null }),
    write: async () => false,
    share: webShare,
    download: anchorDownload
  };

  /* ---------- Android App（Capacitor）：寫到 文件／VehicleLog ----------
     不需要選資料夾、不會過期授權。位置在 App 私有空間之外：清除 App 資料不會刪掉它；
     解除安裝後檔案通常還在，但重裝的 App 讀不到，要用「從備份還原」自己選檔。 */
  let fail = '';                    // 最近一次寫入失敗的原因；空字串＝正常
  const alt = new Set();            // 同名舊檔寫不進去（例如重裝後）而改用別名的檔名
  let plugins = null;
  function getPlugins() {
    if (typeof Capacitor.registerPlugin !== 'function') throw new Error('Capacitor 執行環境未載入（capacitor.js）');
    if (!plugins) plugins = { Filesystem: Capacitor.registerPlugin('Filesystem'), Share: Capacitor.registerPlugin('Share') };
    return plugins;
  }
  async function toBase64(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function instId() {
    try {
      let id = localStorage.getItem('vehicle-log:instId');
      if (!id) { id = Math.random().toString(36).slice(2, 6); localStorage.setItem('vehicle-log:instId', id); }
      return id;
    } catch (e) { return 'x' + Date.now().toString(36).slice(-3); }
  }
  const errText = e => (e && (e.message || e.code)) || '未知錯誤';
  // content：字串（utf8）或 base64（isBase64=true）。成功回傳實際檔名，失敗回傳 null。
  async function put(name, content, isBase64 = false) {
    let Filesystem;
    try { Filesystem = getPlugins().Filesystem; }
    catch (e) { fail = errText(e); console.error('[backup]', e); return null; }
    const write = n => Filesystem.writeFile(Object.assign({ path: DIR + '/' + n, directory: 'DOCUMENTS', data: content, recursive: true }, isBase64 ? {} : { encoding: 'utf8' }));
    const altName = () => name.replace(/(\.\w+)$/, '_' + instId() + '$1');
    try {
      const n = alt.has(name) ? altName() : name;
      await write(n); fail = ''; return n;
    } catch (e1) {
      if (alt.has(name)) { fail = errText(e1); console.error('[backup]', e1); return null; }
      try { const n = altName(); await write(n); alt.add(name); fail = ''; return n; }
      catch (e2) { fail = errText(e2); console.error('[backup]', e2); return null; }
    }
  }
  // 不用 readdir（Android 11–12 會多跳一個讀取權限視窗）：直接刪「過期日期」的檔名，不存在就忽略
  async function prune() {
    const { Filesystem } = getPlugins(), jobs = [];
    for (let i = KEEP_DAYS; i < KEEP_DAYS + 7; i++) jobs.push(Filesystem.deleteFile({ path: DIR + '/' + fileName(dayStr(i)), directory: 'DOCUMENTS' }));
    await Promise.allSettled(jobs);
  }
  const NativeBackup = {
    kind: 'native', canAuto: true, savedWhere: '文件／' + DIR,
    status: () => ({
      text: fail
        ? `⚠️ 無法寫入「文件／${DIR}」（${fail}）。請先用「分享備份」存到雲端硬碟。`
        : `自動備份：每次修改後存到「文件／${DIR}」資料夾（保留最近 ${KEEP_DAYS} 天）。重新安裝 App 後，請用「從備份還原」選取備份檔。`,
      alert: fail ? '自動備份寫入失敗，資料目前只存在 App 內' : null
    }),
    async write(text, day, doPrune) {
      if (!await put(fileName('latest'), text)) return false;
      await put(fileName(day), text);
      if (doPrune) { try { await prune(); } catch (e) {} }
      return true;
    },
    async share(file, title) {
      const { Filesystem, Share } = getPlugins();
      if (!(await Share.canShare()).value) return false;
      // 先寫到 cache（FileProvider 設定涵蓋 cache），再交給系統分享選單
      const path = 'share/' + file.name;
      await Filesystem.writeFile({ path, directory: 'CACHE', data: await toBase64(file), recursive: true });
      const { uri } = await Filesystem.getUri({ path, directory: 'CACHE' });
      try { await Share.share({ title, files: [uri] }); return 'shared'; }
      catch (e) { if (/cancel/i.test(String(e && e.message))) return 'cancel'; throw e; }
    },
    async download(file) {
      try { return (await put(file.name, await toBase64(file), true)) || false; }
      catch (e) { fail = errText(e); return false; }
    }
  };

  window.Backup = IS_NATIVE ? NativeBackup : WebBackup;
  window.IS_NATIVE = IS_NATIVE;
})();
