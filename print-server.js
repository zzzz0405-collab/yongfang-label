/**
 * 印表機連線狀態 API
 * - 印表機 1：區網 TCP 9100
 * - 印表機 2：芯烨雲（條碼雲 open-barcode / 開放平台 open.xpyun）
 * 列印：瀏覽器 window.print()；雲端標籤 API 經 /api/xpyun-print-label 代理
 */
const express = require('express');
const net = require('net');
const crypto = require('crypto');
const path = require('path');
const os = require('os');

const PORT = parseInt(process.env.PORT || process.env.PRINTER_API_PORT || '3847', 10);
const CLOUD_PROXY_ONLY = process.env.CLOUD_PROXY_ONLY === '1' || process.env.CLOUD_PROXY_ONLY === 'true';

const XPYUN_PLATFORMS = {
    barcode: {
        label: '條碼雲',
        verifyUrl: 'https://open-barcode.xpyun.net/api/openapi/sprinter/verifyPrinter',
        statusUrl: 'https://open-barcode.xpyun.net/api/openapi/sprinter/queryPrinterStatus',
        printLabelUrl: 'https://open-barcode.xpyun.net/api/openapi/sprinter/printLabel',
        printDocumentUrl: 'https://open-barcode.xpyun.net/api/openapi/sprinter/printDocument',
        printImageUrl: 'https://open-barcode.xpyun.net/api/openapi/sprinter/printImage'
    },
    open: {
        label: '芯烨雲開放平台',
        statusUrl: 'https://open.xpyun.net/api/openapi/xprinter/queryPrinterStatus',
        printLabelUrl: 'https://open.xpyun.net/api/openapi/xprinter/printLabel'
    }
};

function resolveXpyunPlatform(platform) {
    return XPYUN_PLATFORMS[platform === 'open' ? 'open' : 'barcode'];
}

function getLocalIPv4List() {
    const ips = [];
    const nets = os.networkInterfaces();
    Object.keys(nets).forEach(name => {
        (nets[name] || []).forEach(net => {
            if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
        });
    });
    return ips;
}

function testPrinterTcp(ip, port, timeoutMs = 2500) {
    return new Promise(resolve => {
        if (!ip || !port) return resolve(false);
        const socket = new net.Socket();
        let settled = false;
        const finish = ok => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
        socket.connect(port, ip);
    });
}

function buildXpyunSign(user, userKey, timestamp) {
    return crypto.createHash('sha1').update(String(user) + String(userKey) + String(timestamp)).digest('hex');
}

function buildXpyunAuth(user, userKey) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    return {
        user: String(user).trim(),
        timestamp,
        sign: buildXpyunSign(String(user).trim(), String(userKey).trim(), timestamp)
    };
}

function formatXpyunApiError(json, platform) {
    const label = resolveXpyunPlatform(platform).label;
    const code = json?.code;
    const msg = json?.msg || json?.message || '';
    if (code === -2 || /REQUEST_PARAM_INVALID/i.test(msg)) {
        return `${label}參數或 XML 格式不符，請確認條碼雲 XML 與 direct 參數`;
    }
    if (code === -3 || /SIGN_FAILED/i.test(msg)) {
        return `${label}簽名驗證失敗：請確認開發者 ID、UserKEY 無前後空格，且來自正確平台後台`;
    }
    if (code === 1002 || /NOT_REGISTER/i.test(msg)) {
        return '印表機 SN 未在雲端註冊，請在後台加入設備';
    }
    if (code === 1003 || /OFFLINE/i.test(msg)) {
        return '印表機離線，請確認電源與網路';
    }
    return msg || `${label}錯誤 (${code != null ? code : 'unknown'})`;
}

function isBarcodeSnValid(sn) {
    const text = String(sn || '').trim();
    return text.length === 15;
}

async function postXpyunJson(url, payload) {
    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        body: JSON.stringify(payload)
    });
    return resp.json().catch(() => ({}));
}

async function verifyBarcodePrinter(user, userKey, sn) {
    if (!isBarcodeSnValid(sn)) {
        return { ok: false, message: `條碼雲 SN 須為 15 碼（目前 ${String(sn).trim().length} 碼）` };
    }
    const auth = buildXpyunAuth(user, userKey);
    const json = await postXpyunJson(resolveXpyunPlatform('barcode').verifyUrl, {
        ...auth,
        sn: String(sn).trim(),
        name: '永芳標籤機'
    });
    if (json.code !== 0) {
        return { ok: false, message: formatXpyunApiError(json, 'barcode') };
    }
    if (json.data === true) return { ok: true, message: '條碼雲 SN 已驗證' };
    return { ok: false, message: '條碼雲 SN 未註冊，請在 platform-barcode.xpyun.net 加入印表機' };
}

function parseXpyunStatusCode(json, platform) {
    if (!json || json.code !== 0) return null;
    if (platform === 'barcode' && json.data && typeof json.data === 'object') {
        return parseInt(json.data.status, 10);
    }
    return parseInt(json.data, 10);
}

function formatXpyunStatusMessage(platform, sn, status) {
    const label = resolveXpyunPlatform(platform).label;
    if (status === 1) return `${label}在線 · ${sn}`;
    if (status === 2) return `${label}異常（可能缺紙）· ${sn}`;
    return `${label}離線 · ${sn}`;
}

async function postBarcodeImagePrint(url, payload) {
    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        body: JSON.stringify(payload)
    });
    const json = await resp.json().catch(() => ({}));
    return json;
}

async function sendXpyunPrintDocument(user, userKey, sn, imageBase64, options = {}) {
    if (!user || !userKey || !sn) {
        return { ok: false, code: -1, message: '雲端 API 未填完整（開發者ID / UserKEY / SN）' };
    }
    const content = String(imageBase64 || '').replace(/^data:image\/\w+;base64,/, '').trim();
    if (!content) {
        return { ok: false, code: -1, message: '列印圖片內容為空' };
    }
    if (content.length > XPYUN_DIRECT_CONTENT_LIMIT) {
        return {
            ok: false,
            code: 1007,
            message: `圖片資料過大（${content.length} 字元），條碼雲透傳上限約 65535 字元`
        };
    }
    const platform = options.platform === 'open' ? 'open' : 'barcode';
    if (platform !== 'barcode') {
        return { ok: false, code: -1, message: '圖片列印目前僅支援條碼雲' };
    }
    const urls = resolveXpyunPlatform('barcode');
    const auth = buildXpyunAuth(user, userKey);
    const paperWidth = options.paperWidth || 800;
    const paperHeight = options.paperHeight || 480;
    const basePayload = {
        ...auth,
        sn: String(sn).trim(),
        content,
        paperWidth,
        paperHeight,
        paperType: 'W',
        blackOffsetLength: 0,
        direct: true
    };
    if (options.idempotent) basePayload.idempotent = String(options.idempotent);
    const left = parseInt(options.leftOffset, 10);
    const top = parseInt(options.topOffset, 10);
    if (Number.isFinite(left) && left >= 0) basePayload.leftOffset = left;
    if (Number.isFinite(top) && top >= 0) basePayload.topOffset = top;

    const attempts = [
        {
            label: 'printImage',
            url: urls.printImageUrl,
            payload: { ...basePayload, compress: false }
        },
        {
            label: 'printDocument',
            url: urls.printDocumentUrl,
            payload: { ...basePayload, printFormat: 0 }
        }
    ];

    let lastError = null;
    for (const attempt of attempts) {
        if (!attempt.url) continue;
        try {
            const json = await postBarcodeImagePrint(attempt.url, attempt.payload);
            if (json.code === 0) {
                return {
                    ok: true,
                    code: 0,
                    message: json.msg || 'ok',
                    orderId: json.data || null,
                    via: attempt.label
                };
            }
            lastError = {
                code: json.code,
                message: formatXpyunApiError(json, platform) + `（${attempt.label}）`
            };
            if (json.code !== -2 && !/REQUEST_PARAM_INVALID/i.test(json.msg || '')) {
                break;
            }
        } catch (err) {
            lastError = { code: -1, message: `${attempt.label} 失敗：` + (err.message || String(err)) };
        }
    }
    return {
        ok: false,
        code: lastError?.code ?? -1,
        message: lastError?.message || '條碼雲圖片列印失敗',
        orderId: null
    };
}

async function sendXpyunPrintLabel(user, userKey, sn, content, options = {}) {
    if (!user || !userKey || !sn) {
        return { ok: false, code: -1, message: '雲端 API 未填完整（開發者ID / UserKEY / SN）' };
    }
    if (!content || !String(content).trim()) {
        return { ok: false, code: -1, message: '列印內容為空' };
    }
    const platform = options.platform === 'open' ? 'open' : 'barcode';
    const urls = resolveXpyunPlatform(platform);
    const auth = buildXpyunAuth(user, userKey);
    const payload = {
        ...auth,
        sn: String(sn).trim(),
        content: String(content)
    };
    if (platform === 'open') {
        payload.voice = options.voice != null ? options.voice : 1;
        payload.copies = options.copies || 1;
        payload.mode = options.mode != null ? options.mode : 1;
    } else {
        payload.direct = options.direct !== false;
    }
    if (options.idempotent) payload.idempotent = String(options.idempotent);
    try {
        const resp = await fetch(urls.printLabelUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json;charset=UTF-8' },
            body: JSON.stringify(payload)
        });
        const json = await resp.json().catch(() => ({}));
        if (json.code !== 0) {
            return {
                ok: false,
                code: json.code,
                message: formatXpyunApiError(json, platform),
                orderId: null
            };
        }
        return {
            ok: true,
            code: 0,
            message: json.msg || 'ok',
            orderId: json.data || null
        };
    } catch (err) {
        return { ok: false, code: -1, message: '芯烨雲列印失敗：' + (err.message || String(err)) };
    }
}

async function testXpyunPrinter(user, userKey, sn, platform) {
    const cleanUser = String(user || '').trim();
    const cleanKey = String(userKey || '').trim();
    const cleanSn = String(sn || '').trim();
    if (!cleanUser || !cleanKey || !cleanSn) {
        return { ok: false, message: '雲端 API 未填完整（開發者ID / UserKEY / SN）' };
    }
    const resolved = platform === 'open' ? 'open' : 'barcode';
    const urls = resolveXpyunPlatform(resolved);
    try {
        if (resolved === 'barcode' && !isBarcodeSnValid(cleanSn)) {
            return { ok: false, message: `條碼雲 SN 須為 15 碼（目前 ${cleanSn.length} 碼）` };
        }
        if (resolved === 'barcode') {
            const verified = await verifyBarcodePrinter(cleanUser, cleanKey, cleanSn);
            if (!verified.ok) return verified;
        }
        const auth = buildXpyunAuth(cleanUser, cleanKey);
        const json = await postXpyunJson(urls.statusUrl, { ...auth, sn: cleanSn });
        if (json.code !== 0) {
            return { ok: false, message: formatXpyunApiError(json, resolved) };
        }
        const status = parseXpyunStatusCode(json, resolved);
        if (status === 1) return { ok: true, message: formatXpyunStatusMessage(resolved, cleanSn, status) };
        if (status === 2) return { ok: false, message: formatXpyunStatusMessage(resolved, cleanSn, status) };
        return { ok: false, message: formatXpyunStatusMessage(resolved, cleanSn, status) };
    } catch (err) {
        return { ok: false, message: '雲端連線失敗：' + (err.message || String(err)) };
    }
}

async function checkOnePrinter(p) {
    const id = p.id;
    const name = p.name || `印表機 ${id}`;
    if (p.enabled === false) {
        return { id, name, ok: false, message: '未啟用', mode: p.mode || 'tcp' };
    }
    const mode = p.mode || 'tcp';
    if (mode === 'xpyun') {
        const result = await testXpyunPrinter(
            String(p.cloudUser || '').trim(),
            String(p.cloudUserKey || '').trim(),
            String(p.cloudSn || '').trim(),
            p.platform
        );
        return { id, name, mode: 'xpyun', sn: p.cloudSn, ...result };
    }
    const ip = String(p.ip || '').trim();
    if (!ip) {
        return { id, name, ok: false, message: '未設定 IP', mode: 'tcp' };
    }
    const port = parseInt(p.port, 10) || 9100;
    const ok = await testPrinterTcp(ip, port);
    return {
        id,
        name,
        mode: 'tcp',
        ip,
        port,
        ok,
        message: ok ? `區網在線 ${ip}:${port}` : `無法連線 ${ip}:${port}`
    };
}

async function checkPrinters(printers) {
    const list = Array.isArray(printers) ? printers : [];
    const results = [];
    for (const p of list) {
        results.push(await checkOnePrinter(p));
    }
    return results;
}

const PROXY_JSON_LIMIT = '12mb';
const XPYUN_DIRECT_CONTENT_LIMIT = 60000;

const app = express();
app.use(express.json({ limit: PROXY_JSON_LIMIT }));

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        service: CLOUD_PROXY_ONLY ? 'yongfang-cloud-print-proxy' : 'yongfang-printer-status',
        rev: 3,
        features: ['xpyun-print-label', 'xpyun-print-document'],
        cloudProxyOnly: CLOUD_PROXY_ONLY
    });
});

app.get('/', (req, res) => {
    if (CLOUD_PROXY_ONLY) {
        return res.json({
            ok: true,
            service: 'yongfang-cloud-print-proxy',
            message: '芯烨雲列印 HTTPS 代理（供 GitHub Pages / 手機使用）',
            health: '/api/health'
        });
    }
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/printers-status', async (req, res) => {
    try {
        const printers = await checkPrinters(req.body && req.body.printers);
        res.json({ ok: true, printers });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message || String(err) });
    }
});

app.post('/api/xpyun-status', async (req, res) => {
    try {
        const { user, userKey, sn, platform } = req.body || {};
        const result = await testXpyunPrinter(user, userKey, sn, platform);
        res.json({ ok: true, online: result.ok, message: result.message, sn });
    } catch (err) {
        res.status(500).json({ ok: false, online: false, error: err.message || String(err) });
    }
});

app.post('/api/xpyun-print-document', async (req, res) => {
    try {
        const { user, userKey, sn, content, platform, paperWidth, paperHeight, idempotent, leftOffset, topOffset } = req.body || {};
        const result = await sendXpyunPrintDocument(user, userKey, sn, content, {
            platform, paperWidth, paperHeight, idempotent, leftOffset, topOffset
        });
        res.json({
            ok: result.ok,
            code: result.code,
            message: result.message,
            orderId: result.orderId,
            sn
        });
    } catch (err) {
        res.status(500).json({ ok: false, code: -1, message: err.message || String(err), orderId: null });
    }
});

app.post('/api/xpyun-print-label', async (req, res) => {
    try {
        const { user, userKey, sn, content, copies, mode, voice, idempotent, platform, direct } = req.body || {};
        const result = await sendXpyunPrintLabel(user, userKey, sn, content, {
            copies, mode, voice, idempotent, platform, direct
        });
        res.json({
            ok: result.ok,
            code: result.code,
            message: result.message,
            orderId: result.orderId,
            sn
        });
    } catch (err) {
        res.status(500).json({ ok: false, code: -1, message: err.message || String(err), orderId: null });
    }
});

app.get('/api/status', async (req, res) => {
    const ip = req.query.ip;
    const port = parseInt(req.query.port || '9100', 10);
    if (!ip) {
        return res.status(400).json({ ok: false, error: '缺少 ip 參數' });
    }
    const printerOk = await testPrinterTcp(ip, port);
    res.json({
        ok: true,
        printer: printerOk,
        printerIp: ip,
        printerPort: port,
        message: printerOk ? `連線正常 ${ip}:${port}` : `無法連線 ${ip}:${port}`
    });
});

if (!CLOUD_PROXY_ONLY) {
    app.use(express.static(__dirname, { index: 'index.html' }));
}

const server = app.listen(PORT, '0.0.0.0', () => {
    const ips = getLocalIPv4List();
    console.log('');
    console.log('========================================');
    if (CLOUD_PROXY_ONLY) {
        console.log('  永芳標籤 — 雲端列印代理（GitHub / 手機）');
        console.log('========================================');
        console.log(`  HTTPS 代理已啟動（埠 ${PORT}）`);
        console.log('  請把此網址填入手機「API 代理網址」');
        console.log('  列印路徑：GitHub/手機 → 本代理 → 芯烨雲 → WiFi 標籤機');
    } else {
        console.log('  永芳標籤 — 印表機狀態 API');
        console.log('========================================');
        console.log(`  埠號：${PORT}`);
        console.log(`  網頁＋API：http://localhost:${PORT}`);
        if (ips.length) {
            ips.forEach(ip => console.log(`  區網：http://${ip}:${PORT}`));
        }
        console.log('  印表機 1：區網 TCP 9100 → 綠燈');
        console.log('  印表機 2：條碼雲 / 芯烨雲 API → 藍燈');
        console.log('  服務版本：rev 3（含圖片列印 API）');
    }
    console.log('========================================');
    console.log('');
});

server.on('error', (err) => {
    console.log('');
    if (err && err.code === 'EADDRINUSE') {
        console.log('========================================');
        console.log('  [提示] 埠號 ' + PORT + ' 已在運行中');
        console.log('========================================');
        console.log('');
        console.log('  服務可能已經開著，不必再啟動一次。');
        console.log('  請直接用瀏覽器開：http://localhost:' + PORT);
        console.log('');
        console.log('  若要重啟：先關閉舊的黑色命令視窗，');
        console.log('  或工作管理員結束 node.exe 後再執行本 bat。');
        console.log('');
    } else {
        console.error('[錯誤] 無法啟動服務：', err.message || err);
    }
    process.exit(1);
});
