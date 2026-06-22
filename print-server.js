/**
 * 印表機連線狀態 API
 * - 印表機 1：區網 TCP 9100
 * - 印表機 2：芯烨雲 open.xpyun.net（可從外網檢測）
 * 列印仍用瀏覽器 window.print()
 */
const express = require('express');
const net = require('net');
const crypto = require('crypto');
const path = require('path');
const os = require('os');

const PORT = parseInt(process.env.PRINTER_API_PORT || '3847', 10);
const XPYUN_STATUS_URL = 'https://open.xpyun.net/api/openapi/xprinter/queryPrinterStatus';

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

async function testXpyunPrinter(user, userKey, sn) {
    if (!user || !userKey || !sn) {
        return { ok: false, message: '芯烨雲 API 未填完整（開發者ID / UserKEY / SN）' };
    }
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sign = buildXpyunSign(user, userKey, timestamp);
    try {
        const resp = await fetch(XPYUN_STATUS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json;charset=UTF-8' },
            body: JSON.stringify({ user, timestamp, sign, sn })
        });
        const json = await resp.json().catch(() => ({}));
        if (json.code !== 0) {
            return { ok: false, message: json.msg || `芯烨雲錯誤 (${json.code})` };
        }
        const status = parseInt(json.data, 10);
        if (status === 1) return { ok: true, message: `芯烨雲在線 · ${sn}` };
        if (status === 2) return { ok: false, message: `芯烨雲異常（可能缺紙）· ${sn}` };
        return { ok: false, message: `芯烨雲離線 · ${sn}` };
    } catch (err) {
        return { ok: false, message: '芯烨雲連線失敗：' + (err.message || String(err)) };
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
            String(p.cloudSn || '').trim()
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

const app = express();
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.get('/api/health', (req, res) => {
    res.json({ ok: true, service: 'yongfang-printer-status' });
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
        const { user, userKey, sn } = req.body || {};
        const result = await testXpyunPrinter(user, userKey, sn);
        res.json({ ok: true, online: result.ok, message: result.message, sn });
    } catch (err) {
        res.status(500).json({ ok: false, online: false, error: err.message || String(err) });
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

app.use(express.static(__dirname, { index: 'index.html' }));

app.listen(PORT, '0.0.0.0', () => {
    const ips = getLocalIPv4List();
    console.log('');
    console.log('========================================');
    console.log('  永芳標籤 — 印表機狀態 API');
    console.log('========================================');
    console.log(`  埠號：${PORT}`);
    if (ips.length) {
        ips.forEach(ip => console.log(`  狀態 API：http://${ip}:${PORT}`));
    }
    console.log('  印表機 1：區網 TCP 9100 → 綠燈');
    console.log('  印表機 2：芯烨雲 API → 藍燈');
    console.log('========================================');
    console.log('');
});
