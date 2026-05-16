'use strict';

// Web UI sidecar для Broko.
// Не имеет AMQP-зависимостей. Читает stats.json, который пишет брокер,
// и отдаёт его через HTTP API + статическую HTML-страницу.

const fs = require('fs');
const path = require('path');
const express = require('express');
const basicAuth = require('basic-auth');

const PORT = parseInt(process.env.PORT || '15672', 10);
const STATS_FILE = process.env.STATS_FILE || '/var/lib/broko/stats.json';
const USER = process.env.WEBUI_USER || 'admin';
const PASS = process.env.WEBUI_PASS || 'admin';

const app = express();

// HTTP Basic Auth — простая защита панели управления.
app.use((req, res, next) => {
    const cred = basicAuth(req);
    if (!cred || cred.name !== USER || cred.pass !== PASS) {
        res.set('WWW-Authenticate', 'Basic realm="Broko Management"');
        return res.status(401).send('Authentication required');
    }
    next();
});

function readStats() {
    try {
        const raw = fs.readFileSync(STATS_FILE, 'utf8');
        const data = JSON.parse(raw);
        data.broker_online = (Date.now() - (data.timestamp_ms || 0)) < 10000;
        return data;
    } catch (e) {
        return { broker_online: false, error: e.message };
    }
}

app.get('/api/overview', (_req, res) => {
    const s = readStats();
    res.json({
        version: s.version || null,
        broker_online: s.broker_online,
        uptime_ms: s.uptime_ms || 0,
        stats: s.stats || {},
        timestamp_ms: s.timestamp_ms || 0,
    });
});

app.get('/api/queues',      (_req, res) => res.json(readStats().queues || []));
app.get('/api/exchanges',   (_req, res) => res.json(readStats().exchanges || []));
app.get('/api/connections', (_req, res) => res.json(readStats().connections || []));
app.get('/api/stats',       (_req, res) => res.json(readStats()));

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
    console.log(`[webui] Broko management UI on http://0.0.0.0:${PORT}  (user=${USER})`);
    console.log(`[webui] reading stats from ${STATS_FILE}`);
});
