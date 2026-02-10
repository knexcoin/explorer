/**
 * KnexStats — Network statistics dashboard + Account enrichment
 * v2: Improved sparklines, account lifetime stats, QR codes,
 * known account badges, TPS/BPM tracking, health indicator
 *
 * Also handles: View tab switching logic
 */
const KnexStats = {
    tpsData: [],
    bpmData: [],
    maxDataPoints: 60,
    blocksSinceStart: 0,
    startTime: Date.now(),
    statsInterval: null,

    init() {
        this.initViewTabs();
        this.renderStatsGrid();
        Explorer.on('block', () => this.onBlock());
        this.statsInterval = setInterval(() => this.updateMetrics(), 3000);
    },

    // =============================================
    // VIEW TAB SWITCHING
    // =============================================
    initViewTabs() {
        const tabMap = {
            tabFeed: 'liveFeedPanel',
            tabDag: 'dagPanel',
            tabStats: 'statsPanel',
            tabRichList: 'richListPanel',
            tabBlocks: 'blocksPanel',
        };

        document.querySelectorAll('.view-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const panelId = tabMap[tab.id];
                if (!panelId) return;

                // Update tab active state
                document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');

                // Show the correct panel
                Explorer.showPanel(panelId);
            });
        });
    },

    // =============================================
    // STATS GRID
    // =============================================
    renderStatsGrid() {
        const grid = document.getElementById('statsGrid');
        if (!grid) return;

        grid.innerHTML = `
            <div class="stat-card">
                <div class="stat-card-label">Network Health</div>
                <div class="stats-health-indicator" id="healthIndicator">
                    <span class="health-dot green"></span>
                    <span class="health-label">Healthy</span>
                </div>
                <div class="stat-card-sub" id="healthSub">WebSocket connected</div>
            </div>

            <div class="stat-card">
                <div class="stat-card-label">Transactions/sec</div>
                <div class="stat-card-value" id="tpsValue">0.0</div>
                <div class="stats-tps-gauge">
                    <div class="tps-gauge-fill" id="tpsGauge" style="width: 0%"></div>
                </div>
                <canvas class="stats-sparkline" id="tpsSparkline"></canvas>
            </div>

            <div class="stat-card">
                <div class="stat-card-label">Blocks/min</div>
                <div class="stat-card-value" id="bpmValue">0.0</div>
                <canvas class="stats-sparkline" id="bpmSparkline"></canvas>
            </div>

            <div class="stat-card">
                <div class="stat-card-label">Total Blocks</div>
                <div class="stat-card-value" id="statTotalBlocks">--</div>
                <div class="stat-card-sub">Since network genesis</div>
            </div>

            <div class="stat-card">
                <div class="stat-card-label">Known Accounts</div>
                <div class="stat-card-value" id="statKnownAccounts">--</div>
                <div class="stat-card-sub">Accounts with history</div>
            </div>

            <div class="stat-card">
                <div class="stat-card-label">Session Blocks</div>
                <div class="stat-card-value" id="sessionBlockCount">0</div>
                <div class="stat-card-sub" id="sessionDuration">Since page load</div>
            </div>
        `;

        // Listen for WS status changes to update health
        Explorer.on('ws:status', (status) => this.updateHealth(status));
    },

    onBlock() {
        this.blocksSinceStart++;
        const el = document.getElementById('sessionBlockCount');
        if (el) el.textContent = this.blocksSinceStart.toLocaleString();
    },

    updateMetrics() {
        const elapsedSec = (Date.now() - this.startTime) / 1000;

        // TPS
        const tps = elapsedSec > 0 ? (this.blocksSinceStart / elapsedSec) : 0;
        this.tpsData.push(tps);
        if (this.tpsData.length > this.maxDataPoints) this.tpsData.shift();

        const tpsEl = document.getElementById('tpsValue');
        if (tpsEl) tpsEl.textContent = tps.toFixed(2);

        // TPS gauge (max assumed 10 TPS)
        const gauge = document.getElementById('tpsGauge');
        if (gauge) gauge.style.width = Math.min(tps / 10 * 100, 100) + '%';

        // BPM
        const bpm = tps * 60;
        this.bpmData.push(bpm);
        if (this.bpmData.length > this.maxDataPoints) this.bpmData.shift();

        const bpmEl = document.getElementById('bpmValue');
        if (bpmEl) bpmEl.textContent = bpm.toFixed(1);

        // Draw sparklines
        this.drawSparkline('tpsSparkline', this.tpsData, '#FF8C00');
        this.drawSparkline('bpmSparkline', this.bpmData, '#FFD700');

        // Session duration
        const durEl = document.getElementById('sessionDuration');
        if (durEl) {
            const mins = Math.floor(elapsedSec / 60);
            const secs = Math.floor(elapsedSec % 60);
            durEl.textContent = `${mins}m ${secs}s session`;
        }

        // Update total blocks and accounts from header stats
        const blockCountEl = document.getElementById('statTotalBlocks');
        if (blockCountEl) {
            const headerVal = document.getElementById('blockCount')?.textContent;
            if (headerVal && headerVal !== '--') blockCountEl.textContent = headerVal;
        }

        const accCountEl = document.getElementById('statKnownAccounts');
        if (accCountEl) {
            const headerVal = document.getElementById('accountCount')?.textContent;
            if (headerVal && headerVal !== '--') accCountEl.textContent = headerVal;
        }
    },

    updateHealth(status) {
        const indicator = document.getElementById('healthIndicator');
        const sub = document.getElementById('healthSub');
        if (!indicator || !sub) return;

        switch (status) {
            case 'connected':
                indicator.innerHTML = '<span class="health-dot green"></span><span class="health-label">Healthy</span>';
                sub.textContent = 'WebSocket connected';
                break;
            case 'disconnected':
                indicator.innerHTML = '<span class="health-dot red"></span><span class="health-label">Disconnected</span>';
                sub.textContent = 'Attempting to reconnect...';
                break;
            case 'connecting':
                indicator.innerHTML = '<span class="health-dot yellow"></span><span class="health-label">Connecting</span>';
                sub.textContent = 'Establishing WebSocket...';
                break;
        }
    },

    drawSparkline(canvasId, data, color) {
        const canvas = document.getElementById(canvasId);
        if (!canvas || data.length < 2) return;

        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.offsetWidth;
        const h = canvas.offsetHeight;

        if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
            canvas.width = w * dpr;
            canvas.height = h * dpr;
            ctx.scale(dpr, dpr);
        }

        ctx.clearRect(0, 0, w, h);

        const max = Math.max(...data, 0.1);
        const stepX = w / (data.length - 1);

        // Fill gradient
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, color + '30');
        grad.addColorStop(1, 'transparent');

        ctx.beginPath();
        ctx.moveTo(0, h);
        data.forEach((val, i) => {
            const x = i * stepX;
            const y = h - (val / max) * (h - 4);
            ctx.lineTo(x, y);
        });
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        // Line
        ctx.beginPath();
        data.forEach((val, i) => {
            const x = i * stepX;
            const y = h - (val / max) * (h - 4);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
    },
};

/**
 * KnexAccount — Account enrichment (QR, known badges, lifetime stats, sparkline)
 */
const KnexAccount = {
    // Known accounts registry
    knownAccounts: {
        'IrYbu3tpxqOL7athJChfpP2U8PCNeYcBshYEMASdcR35iKpVKE': {
            label: 'Genesis',
            color: '#FFD700',
            badgeClass: 'badge-genesis',
        },
    },

    init() {
        Explorer.on('account:loaded', (data) => this.enrichAccount(data));
    },

    enrichAccount({ info, history, address }) {
        const container = document.getElementById('accountEnrichment');
        if (!container) return;
        container.innerHTML = '';

        // 1. Known account badge
        const known = this.knownAccounts[address];
        if (known) {
            const badge = document.createElement('span');
            badge.className = `known-badge ${known.badgeClass || ''}`;
            badge.style.borderColor = known.color;
            badge.style.color = known.color;
            badge.textContent = known.label;
            container.appendChild(badge);
        }

        // 2. QR Code
        if (typeof qrcode !== 'undefined') {
            try {
                const qr = qrcode(0, 'M');
                qr.addData(address);
                qr.make();

                const qrDiv = document.createElement('div');
                qrDiv.className = 'account-qr';
                qrDiv.innerHTML = qr.createImgTag(3, 0);
                container.appendChild(qrDiv);
            } catch (e) {
                console.warn('[QR] Generation failed:', e);
            }
        }

        // 3. Lifetime stats
        if (history && history.length > 0) {
            let totalSent = 0n;
            let totalReceived = 0n;
            let sendCount = 0;
            let receiveCount = 0;

            for (const tx of history) {
                const amount = BigInt(tx.amount || tx.balance || '0');
                if (tx.type === 'send') {
                    totalSent += amount;
                    sendCount++;
                } else if (tx.type === 'receive' || tx.type === 'open') {
                    totalReceived += amount;
                    receiveCount++;
                }
            }

            const statsDiv = document.createElement('div');
            statsDiv.className = 'account-lifetime-stats';
            statsDiv.innerHTML = `
                <div class="lifetime-stat">
                    <span class="lifetime-label">Total Sent</span>
                    <span class="lifetime-value negative">${Explorer.formatAmount(totalSent.toString())} KNEX</span>
                </div>
                <div class="lifetime-stat">
                    <span class="lifetime-label">Total Received</span>
                    <span class="lifetime-value positive">${Explorer.formatAmount(totalReceived.toString())} KNEX</span>
                </div>
                <div class="lifetime-stat">
                    <span class="lifetime-label">Sends</span>
                    <span class="lifetime-value">${sendCount}</span>
                </div>
                <div class="lifetime-stat">
                    <span class="lifetime-label">Receives</span>
                    <span class="lifetime-value">${receiveCount}</span>
                </div>
            `;
            container.appendChild(statsDiv);

            // 4. Balance sparkline
            if (history.length > 2) {
                const wrapper = document.createElement('div');
                wrapper.className = 'account-sparkline-wrapper';
                wrapper.innerHTML = '<div class="sparkline-label">Balance History</div>';

                const canvas = document.createElement('canvas');
                canvas.className = 'account-sparkline';
                wrapper.appendChild(canvas);
                container.appendChild(wrapper);

                // Build balance series from history (newest first, so reverse)
                requestAnimationFrame(() => {
                    const balances = [];
                    let running = 0n;
                    const reversed = [...history].reverse();
                    for (const tx of reversed) {
                        const amt = BigInt(tx.amount || tx.balance || '0');
                        if (tx.type === 'receive' || tx.type === 'open') {
                            running += amt;
                        } else if (tx.type === 'send') {
                            running -= amt;
                        }
                        balances.push(Number(running));
                    }
                    this.drawAccountSparkline(canvas, balances);
                });
            }
        }
    },

    drawAccountSparkline(canvas, data) {
        if (!canvas || data.length < 2) return;

        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.offsetWidth;
        const h = canvas.offsetHeight;

        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.scale(dpr, dpr);

        const max = Math.max(...data, 1);
        const min = Math.min(...data, 0);
        const range = max - min || 1;
        const stepX = w / (data.length - 1);

        // Gradient fill
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, 'rgba(255,215,0,0.2)');
        grad.addColorStop(1, 'transparent');

        ctx.beginPath();
        ctx.moveTo(0, h);
        data.forEach((val, i) => {
            const x = i * stepX;
            const y = h - ((val - min) / range) * (h - 6);
            ctx.lineTo(x, y);
        });
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        // Line
        ctx.beginPath();
        data.forEach((val, i) => {
            const x = i * stepX;
            const y = h - ((val - min) / range) * (h - 6);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = '#FFD700';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Endpoint dot
        if (data.length > 0) {
            const lastX = (data.length - 1) * stepX;
            const lastY = h - ((data[data.length - 1] - min) / range) * (h - 6);
            ctx.beginPath();
            ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
            ctx.fillStyle = '#FFD700';
            ctx.fill();
        }
    },
};
