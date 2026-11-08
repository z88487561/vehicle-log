/* 掃描電子發票 QR → 取出日期、總計、油品公升數。
 * 相機與解碼流程參考 einvoice-scanner：取景框裁切後交給 jsQR（可取得原始 bytes，Big5 品名才不會亂碼），
 * 瀏覽器支援時再加上原生 BarcodeDetector。 */
(() => {
  'use strict';
  const VL = window.VL;
  const $ = s => document.querySelector(s);
  const dlg = $('#scanDlg');
  const st = { stream: null, raf: 0, detector: null, canvas: null, left: null, right: null, leftAt: 0, busy: false, last: 0, done: false, session: 0, onDone: null };
  let jsQRLoading = null, audio = null;

  const status = t => { $('#scanStatus').textContent = t; };
  const banner = (title, text) => { $('#scanBannerTitle').textContent = title; $('#scanBannerText').textContent = text; $('#scanBanner').style.display = 'block'; };
  const hideBanner = () => { $('#scanBanner').style.display = 'none'; };

  function loadJsQR() {
    if (window.jsQR) return Promise.resolve(window.jsQR);
    if (jsQRLoading) return jsQRLoading;
    jsQRLoading = new Promise((res, rej) => {
      const el = document.createElement('script');
      el.src = 'jsQR.js';
      el.onload = () => (window.jsQR ? res(window.jsQR) : rej(new Error('jsQR 無法使用')));
      el.onerror = () => { el.remove(); jsQRLoading = null; rej(new Error('jsQR 載入失敗')); };
      document.head.appendChild(el);
    });
    return jsQRLoading;
  }

  async function prepareDecoder() {
    if ('BarcodeDetector' in window && !st.detector) {
      try { if ((await BarcodeDetector.getSupportedFormats()).includes('qr_code')) st.detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) {}
    }
    await loadJsQR();
  }

  /** 取景框對應到相機原始畫面的範圍（畫面以 object-fit: cover 顯示，需換算縮放與位移，四周多留 8%） */
  function cropRect(video, wrap, box) {
    const vW = video.videoWidth, vH = video.videoHeight;
    if (!vW || !vH) return null;
    const w = wrap.getBoundingClientRect(), b = box.getBoundingClientRect();
    if (!w.width || !w.height) { const side = Math.min(vW, vH) * 0.65; return { x: (vW - side) / 2 | 0, y: (vH - side) / 2 | 0, w: side | 0, h: side | 0 }; }
    const scale = Math.max(w.width / vW, w.height / vH);
    const ox = (w.width - vW * scale) / 2, oy = (w.height - vH * scale) / 2;
    const pad = b.width * 0.08;
    const l = Math.max(0, b.left - w.left - pad), t = Math.max(0, b.top - w.top - pad);
    const r = Math.min(w.width, b.right - w.left + pad), bt = Math.min(w.height, b.bottom - w.top + pad);
    const x = Math.max(0, Math.round((l - ox) / scale)), y = Math.max(0, Math.round((t - oy) / scale));
    return { x, y, w: Math.min(vW - x, Math.round((r - l) / scale)), h: Math.min(vH - y, Math.round((bt - t) / scale)) };
  }

  async function configureCamera() {
    const track = st.stream && st.stream.getVideoTracks()[0];
    if (!track) return;
    let caps = {};
    try { if (track.getCapabilities) caps = track.getCapabilities(); } catch (e) {}
    if (caps.focusMode && caps.focusMode.includes('continuous')) {
      try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (e) {}
    }
    let any = false;
    if (caps.torch) { $('#scanTorch').hidden = false; any = true; }
    if (caps.zoom && caps.zoom.max > caps.zoom.min) {
      const input = $('#scanZoom');
      input.min = caps.zoom.min; input.max = caps.zoom.max; input.step = caps.zoom.step || 0.1;
      const z = Math.min(caps.zoom.max, Math.max(caps.zoom.min, 1.8)); // 預設放大一點，小 QR 比較容易對焦
      if (z > caps.zoom.min) { try { await track.applyConstraints({ advanced: [{ zoom: z }] }); } catch (e) {} }
      input.value = z;
      $('#scanZoomWrap').hidden = false; any = true;
    }
    $('#scanCameraControls').hidden = !any;
  }

  function prepareAudio() {
    if ('vibrate' in navigator) return;
    try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === 'suspended') audio.resume(); } catch (e) {}
  }
  function feedback() {
    if ('vibrate' in navigator) { navigator.vibrate(120); return; }
    if (!audio) return;
    try {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = 880; g.gain.value = 0.15; o.connect(g); g.connect(audio.destination);
      o.start(); o.stop(audio.currentTime + 0.12);
    } catch (e) {}
  }

  function stop() {
    cancelAnimationFrame(st.raf);
    if (st.stream) st.stream.getTracks().forEach(t => t.stop());
    st.stream = null;
    $('#scanCameraControls').hidden = true; $('#scanTorch').hidden = true; $('#scanZoomWrap').hidden = true;
    $('#scanTorch').setAttribute('aria-pressed', 'false'); $('#scanTorch').textContent = '開啟補光';
    hideBanner();
    $('#scanVideo').srcObject = null;
  }

  function finish(withRight = true) {
    if (st.done || !st.left) return;
    st.done = true;
    const extra = withRight && st.right ? VL.invoiceItems(st.right.fields, st.left.enc) : [];
    const result = VL.fuelFromInvoice(st.left, extra);
    const cb = st.onDone;
    stop();
    dlg.close();
    if (cb) cb(result);
  }

  function handle(codes) {
    const enc = st.left ? st.left.enc : null;
    let gotNew = false;
    codes.forEach(c => {
      const r = VL.parseInvoiceQR(c, enc);
      if (!r) return;
      if (!st[r.kind]) { st[r.kind] = r; gotNew = true; if (r.kind === 'left') st.leftAt = Date.now(); }
    });
    if (gotNew) feedback();
    const l = st.left;
    $('#scanSkip').hidden = !(l && !st.right && VL.needsRightQR(l));
    if (l) {
      const f = VL.fuelFromInvoice(l);
      if (f.liters != null) banner('✅ 讀到了', `${f.date}　$${f.amount}　${f.liters} L`);
      else if (VL.needsRightQR(l)) { banner('✅ 左側 QR 已讀取', '這張發票還有品項在右側，請把框框移到右側 QR'); status('請將框框對準「右側 QR Code」（或按「略過右側」）'); }
      else banner('✅ 已讀取', '發票內沒有找到油量，會只帶入日期和金額');
    } else if (st.right) {
      banner('✅ 右側 QR 已讀取', '請把框框移到「左側 QR」'); status('請將框框對準「左側 QR Code」');
    }
  }

  function loop(ts) {
    if (!st.stream) return;
    st.raf = requestAnimationFrame(loop);
    const v = $('#scanVideo');
    if (st.busy || ts - st.last < 180 || v.readyState < 2 || !v.videoWidth) return;
    st.last = ts; st.busy = true;
    const session = st.session;
    (async () => {
      const crop = cropRect(v, $('#scanVideoWrap'), $('#scanBox'));
      if (!crop || crop.w <= 0 || crop.h <= 0) return;
      const cv = st.canvas || (st.canvas = document.createElement('canvas'));
      const sc = Math.min(1, 480 / Math.max(crop.w, crop.h));
      cv.width = Math.max(1, Math.round(crop.w * sc)); cv.height = Math.max(1, Math.round(crop.h * sc));
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(v, crop.x, crop.y, crop.w, crop.h, 0, 0, cv.width, cv.height);
      const codes = [];
      if (st.detector) { try { (await st.detector.detect(v)).forEach(b => { if (b.rawValue) codes.push(b.rawValue); }); } catch (e) {} }
      const jsQR = window.jsQR || await loadJsQR().catch(() => null);
      if (jsQR) {
        const img = ctx.getImageData(0, 0, cv.width, cv.height);
        const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
        if (r) codes.push(r);
      }
      if (session !== st.session || st.done) return;
      if (codes.length) {
        handle(codes);
        const l = st.left;
        if (!l) return;
        const f = VL.fuelFromInvoice(l, st.right ? VL.invoiceItems(st.right.fields, l.enc) : []);
        // 找到油量就完成；右側還有品項時等使用者掃右側或按「略過」；否則多等 1 秒完成
        if (f.liters != null || (st.right && !st.done) || (!VL.needsRightQR(l) && Date.now() - st.leftAt > 1000)) finish();
      }
    })().catch(e => console.error('scan', e)).finally(() => { if (session === st.session) st.busy = false; });
  }

  async function open(onDone) {
    Object.assign(st, { left: null, right: null, leftAt: 0, busy: false, last: 0, done: false, session: st.session + 1, onDone });
    $('#scanCameraControls').hidden = true; $('#scanSkip').hidden = true; hideBanner();
    prepareAudio();
    status('正在開啟相機…');
    dlg.showModal();
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('需要 HTTPS'), { name: 'NoCamera' });
      st.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      if (!dlg.open) { stop(); return; }
      const v = $('#scanVideo');
      v.srcObject = st.stream;
      await v.play();
      await configureCamera();
      await prepareDecoder();
      status('請把發票左側的 QR Code 放進框內（一次只掃一個）');
      st.raf = requestAnimationFrame(loop);
    } catch (e) {
      console.error('scan', e);
      stop();
      status(e && e.name === 'NotAllowedError' ? '沒有相機權限，請到瀏覽器設定允許存取相機'
        : e && e.name === 'NoCamera' ? '此環境無法使用相機（需要 HTTPS 連線）'
        : /jsQR/.test((e && e.message) || '') ? '辨識元件載入失敗，請確認網路連線後重試'
        : '無法開啟相機（' + ((e && e.name) || '未知錯誤') + '）');
    }
  }

  $('#scanClose').onclick = $('#scanCancel').onclick = () => dlg.close();
  $('#scanSkip').onclick = () => finish(false);
  dlg.addEventListener('close', () => { st.session++; st.done = true; stop(); });
  $('#scanTorch').onclick = async () => {
    const track = st.stream && st.stream.getVideoTracks()[0]; if (!track) return;
    const on = $('#scanTorch').getAttribute('aria-pressed') !== 'true';
    try { await track.applyConstraints({ advanced: [{ torch: on }] }); $('#scanTorch').setAttribute('aria-pressed', String(on)); $('#scanTorch').textContent = on ? '關閉補光' : '開啟補光'; }
    catch (e) { status('無法切換補光，請調整環境光線'); }
  };
  $('#scanZoom').oninput = async e => {
    const track = st.stream && st.stream.getVideoTracks()[0]; if (!track) return;
    try { await track.applyConstraints({ advanced: [{ zoom: Number(e.target.value) }] }); } catch (err) {}
  };

  window.VLScan = { open };
})();
