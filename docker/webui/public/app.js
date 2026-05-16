'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let currentView = 'overview';

// Tab switching
$$('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
        $$('.tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        $$('.view').forEach(v => v.classList.remove('active'));
        $(`#view-${btn.dataset.view}`).classList.add('active');
        currentView = btn.dataset.view;
        refresh();
    });
});

function fmtBool(v) {
    return v
        ? '<span class="badge yes">yes</span>'
        : '<span class="badge no">no</span>';
}

function fmtUptime(ms) {
    if (!ms || ms < 1000) return '';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h) return `uptime ${h}ч ${m}м ${r}с`;
    if (m) return `uptime ${m}м ${r}с`;
    return `uptime ${r}с`;
}

function fmtTime(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    return d.toTimeString().split(' ')[0];
}

async function fetchJSON(path) {
    const r = await fetch(path, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
}

function setStatus(online, uptimeMs) {
    $('#status-dot').className = 'dot ' + (online ? 'online' : 'offline');
    $('#status-text').textContent = online ? 'online' : 'offline';
    $('#uptime').textContent = online ? fmtUptime(uptimeMs) : '';
}

async function renderOverview() {
    const s = await fetchJSON('/api/stats');
    setStatus(s.broker_online, s.uptime_ms);
    const st = s.stats || {};
    $('#kpi-conn').textContent      = st.connections ?? '—';
    $('#kpi-queues').textContent    = st.queues ?? '—';
    $('#kpi-exchanges').textContent = st.exchanges ?? '—';
    $('#kpi-messages').textContent  = st.messages_ready ?? '—';

    // Top queues by depth
    const qs = (s.queues || [])
        .filter(q => q.messages > 0 || q.consumers > 0)
        .sort((a, b) => b.messages - a.messages)
        .slice(0, 10);

    const tbody = $('#top-queues tbody');
    if (qs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" class="muted">Активных очередей нет</td></tr>';
    } else {
        tbody.innerHTML = qs.map(q =>
            `<tr><td>${escapeHtml(q.name)}</td><td class="num">${q.messages}</td><td class="num">${q.consumers}</td></tr>`
        ).join('');
    }
}

async function renderQueues() {
    const data = await fetchJSON('/api/queues');
    const tbody = $('#tbl-queues tbody');
    if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="muted">Очередей нет</td></tr>';
        return;
    }
    tbody.innerHTML = data
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(q => `
            <tr>
                <td>${escapeHtml(q.name)}</td>
                <td>${fmtBool(q.durable)}</td>
                <td>${fmtBool(q.exclusive)}</td>
                <td>${fmtBool(q.auto_delete)}</td>
                <td class="num">${q.messages}</td>
                <td class="num">${q.consumers}</td>
            </tr>
        `).join('');
}

async function renderExchanges() {
    const data = await fetchJSON('/api/exchanges');
    const tbody = $('#tbl-exchanges tbody');
    tbody.innerHTML = data
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(ex => `
            <tr>
                <td>${escapeHtml(ex.name)}</td>
                <td><code>${escapeHtml(ex.type)}</code></td>
                <td>${fmtBool(ex.durable)}</td>
                <td>${fmtBool(ex.auto_delete)}</td>
                <td class="num">${ex.bindings}</td>
            </tr>
        `).join('');
}

async function renderConnections() {
    const data = await fetchJSON('/api/connections');
    const tbody = $('#tbl-connections tbody');
    if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="muted">Активных соединений нет</td></tr>';
        return;
    }
    tbody.innerHTML = data
        .sort((a, b) => a.id - b.id)
        .map(c => `
            <tr>
                <td>${c.id}</td>
                <td>${escapeHtml(c.user || '<anon>')}</td>
                <td><code>${escapeHtml(c.peer || '?')}</code></td>
                <td class="num">${c.channels}</td>
                <td>${fmtTime(c.connected_at_ms)}</td>
            </tr>
        `).join('');
}

function escapeHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

async function refresh() {
    try {
        if (currentView === 'overview')         await renderOverview();
        else if (currentView === 'queues')      await renderQueues();
        else if (currentView === 'exchanges')   await renderExchanges();
        else if (currentView === 'connections') await renderConnections();
        // Always update status indicator
        if (currentView !== 'overview') {
            const s = await fetchJSON('/api/overview');
            setStatus(s.broker_online, s.uptime_ms);
        }
    } catch (e) {
        setStatus(false, 0);
        console.error(e);
    }
}

refresh();
setInterval(refresh, 2000);
