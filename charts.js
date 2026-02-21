/**
 * KnexStats v3 — Full Network Statistics Dashboard
 *
 * Features:
 * - Sliding window TPS/BPM (30s window, not cumulative)
 * - Average block time tracking
 * - Peak TPS (1m, 5m, session)
 * - Total & circulating supply with progress bar
 * - Transaction volume this session
 * - Block type distribution donut chart
 * - Top active accounts this session
 * - Largest transaction seen
 * - Supply concentration (top accounts %)
 * - Network pulse animation
 * - Real-time sparklines
 *
 * Also handles: View tab switching logic
 */
const KnexStats = {
    // Sparkline data (rolling 60-point windows)
    tpsData: [],
    bpmData: [],
    blockTimeData: [],
    maxDataPoints: 60,

    // Session tracking
    blocksSinceStart: 0,
    startTime: Date.now(),
    statsInterval: null,

    // Sliding window for real TPS (30s window)
    blockTimestamps: [],    // timestamps of blocks received
    windowSize: 30000,      // 30 seconds

    // Block time tracking
    lastBlockTime: null,
    blockIntervals: [],     // last 100 intervals in ms

    // Peak TPS tracking
    peakTps1m: 0,
    peakTps5m: 0,
    peakTpsSession: 0,
    tpsHistory1m: [],       // TPS samples for 1m window
    tpsHistory5m: [],       // TPS samples for 5m window

    // Volume tracking
    sessionVolume: 0n,
    largestTx: { amount: 0n, hash: '', type: '' },

    // Block type counts
    typeCounts: { send: 0, receive: 0, open: 0, change: 0, bandwidth: 0, pending: 0 },

    // Top accounts
    accountActivity: new Map(), // account → { sends, receives, volume }

    // Supply constants
    totalSupply: 1000000000000000n, // 100M KNEX in raw
    genesisHash: '929e612805b48c7b865f67bd25a96e44faeb069a1cb04d9677ef715b5b8a1fd4',

    // Network pulse
    pulseActive: false,

    init() {
        this.initViewTabs();
        this.renderStatsGrid();
        Explorer.on('block', (data) => this.onBlock(data));
        Explorer.on('ws:status', (status) => this.updateHealth(status));
        this.statsInterval = setInterval(() => this.updateMetrics(), 2000);
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
            tabCore: 'corePanel',
        };

        document.querySelectorAll('.view-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const panelId = tabMap[tab.id];
                if (!panelId) return;
                document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                Explorer.showPanel(panelId);
            });
        });
    },

    // =============================================
    // STATS GRID — Renders all cards
    // =============================================
    renderStatsGrid() {
        const grid = document.getElementById('statsGrid');
        if (!grid) return;

        grid.innerHTML = `
            <!-- Row 1: Key metrics -->
            <div class="stat-card stat-card-wide">
                <div class="stat-card-label">Network Health</div>
                <div class="stats-health-indicator" id="healthIndicator">
                    <span class="health-dot green"></span>
                    <span class="health-label">Healthy</span>
                </div>
                <div class="stat-card-sub" id="healthSub">WebSocket connected</div>
                <div class="network-pulse" id="networkPulse"></div>
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
                <div class="stat-card-label">Avg Block Time</div>
                <div class="stat-card-value" id="avgBlockTime">--</div>
                <div class="stat-card-sub" id="avgBlockTimeSub">Waiting for blocks...</div>
                <canvas class="stats-sparkline" id="blockTimeSparkline"></canvas>
            </div>

            <!-- Row 2: Counts & Supply -->
            <div class="stat-card">
                <div class="stat-card-label">Total Blocks</div>
                <div class="stat-card-value" id="statTotalBlocks">--</div>
                <div class="stat-card-sub">Since network genesis</div>
            </div>

            <div class="stat-card">
                <div class="stat-card-label">Known Accounts</div>
                <div class="stat-card-value" id="statKnownAccounts">--</div>
                <div class="stat-card-sub" id="knownAccountsSub">Accounts with history</div>
            </div>

            <div class="stat-card">
                <div class="stat-card-label">Total Supply</div>
                <div class="stat-card-value" style="font-size:18px">100,000,000 <span style="font-size:12px;color:var(--text-muted)">KNEX</span></div>
                <div class="stat-card-sub">Genesis block: ${this.genesisHash.slice(0, 12)}...</div>
            </div>

            <div class="stat-card">
                <div class="stat-card-label">Node Uptime</div>
                <div class="stat-card-value" id="statNodeUptime">--</div>
                <div class="stat-card-sub" id="statNodeUptimeSub">API node</div>
            </div>

            <!-- Row 3: Session Analytics -->
            <div class="stat-card">
                <div class="stat-card-label">Session Blocks</div>
                <div class="stat-card-value" id="sessionBlockCount">0</div>
                <div class="stat-card-sub" id="sessionDuration">Since page load</div>
            </div>

            <div class="stat-card">
                <div class="stat-card-label">Session Volume</div>
                <div class="stat-card-value" id="sessionVolume" style="font-size:18px">0 KNEX</div>
                <div class="stat-card-sub">Total KNEX moved this session</div>
            </div>

            <div class="stat-card">
                <div class="stat-card-label">Largest Transaction</div>
                <div class="stat-card-value" id="largestTxValue" style="font-size:16px">--</div>
                <div class="stat-card-sub" id="largestTxSub">Waiting for transactions...</div>
            </div>

            <div class="stat-card">
                <div class="stat-card-label">Peak TPS</div>
                <div class="stat-card-value" id="peakTpsValue">0.0</div>
                <div class="stat-card-sub" id="peakTpsSub">
                    <span id="peakTps1m">1m: 0.0</span> &middot;
                    <span id="peakTps5m">5m: 0.0</span>
                </div>
            </div>

            <!-- Row 4: Distribution & Top Accounts -->
            <div class="stat-card stat-card-wide">
                <div class="stat-card-label">Block Type Distribution</div>
                <div class="type-distribution" id="typeDistribution">
                    <canvas id="typeDonutChart" width="120" height="120"></canvas>
                    <div class="type-distribution-legend" id="typeDistLegend"></div>
                </div>
            </div>

            <div class="stat-card stat-card-wide">
                <div class="stat-card-label">Top Accounts This Session</div>
                <div class="top-accounts-list" id="topAccountsList">
                    <div class="stat-card-sub">Waiting for activity...</div>
                </div>
            </div>
        `;
    },

    // =============================================
    // BLOCK EVENT HANDLER
    // =============================================
    onBlock(data) {
        const now = Date.now();
        this.blocksSinceStart++;

        // Sliding window timestamps
        this.blockTimestamps.push(now);

        // Block interval tracking
        if (this.lastBlockTime) {
            const interval = now - this.lastBlockTime;
            this.blockIntervals.push(interval);
            if (this.blockIntervals.length > 100) this.blockIntervals.shift();
        }
        this.lastBlockTime = now;

        // Session block count
        const el = document.getElementById('sessionBlockCount');
        if (el) el.textContent = this.blocksSinceStart.toLocaleString();

        // Volume tracking
        if (data) {
            try {
                const amount = BigInt(data.amount || '0');
                this.sessionVolume += amount;

                // Largest transaction
                if (amount > this.largestTx.amount) {
                    this.largestTx = {
                        amount,
                        hash: data.hash || '',
                        type: data.block_type || 'send',
                    };
                }
            } catch (e) { /* ignore */ }

            // Block type counts
            const type = data.block_type || 'send';
            if (this.typeCounts[type] !== undefined) {
                this.typeCounts[type]++;
            }

            // Account activity
            if (data.account) {
                const acct = this.accountActivity.get(data.account) || { sends: 0, receives: 0, volume: 0n, lastType: '' };
                if (type === 'send') acct.sends++;
                else acct.receives++;
                try { acct.volume += BigInt(data.amount || '0'); } catch (e) {}
                acct.lastType = type;
                this.accountActivity.set(data.account, acct);
            }
        }

        // Network pulse animation
        this.triggerPulse();
    },

    // =============================================
    // METRICS UPDATE (every 2s)
    // =============================================
    updateMetrics() {
        const now = Date.now();
        const elapsedSec = (now - this.startTime) / 1000;

        // Clean old timestamps from sliding window
        this.blockTimestamps = this.blockTimestamps.filter(t => now - t < this.windowSize);

        // Sliding window TPS (blocks in last 30s / 30)
        const tps = this.blockTimestamps.length / (this.windowSize / 1000);
        this.tpsData.push(tps);
        if (this.tpsData.length > this.maxDataPoints) this.tpsData.shift();

        // Peak TPS tracking
        this.tpsHistory1m.push(tps);
        this.tpsHistory5m.push(tps);
        // Keep 1m worth of 2s samples = 30 samples
        if (this.tpsHistory1m.length > 30) this.tpsHistory1m.shift();
        // Keep 5m worth of 2s samples = 150 samples
        if (this.tpsHistory5m.length > 150) this.tpsHistory5m.shift();

        const peak1m = Math.max(...this.tpsHistory1m, 0);
        const peak5m = Math.max(...this.tpsHistory5m, 0);
        if (tps > this.peakTpsSession) this.peakTpsSession = tps;

        // Update TPS display
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

        // Average block time
        if (this.blockIntervals.length > 0) {
            const avgMs = this.blockIntervals.reduce((a, b) => a + b, 0) / this.blockIntervals.length;
            const avgSec = avgMs / 1000;
            this.blockTimeData.push(avgSec);
            if (this.blockTimeData.length > this.maxDataPoints) this.blockTimeData.shift();

            const avgEl = document.getElementById('avgBlockTime');
            if (avgEl) avgEl.textContent = avgSec < 1 ? `${Math.round(avgMs)}ms` : `${avgSec.toFixed(1)}s`;

            const avgSubEl = document.getElementById('avgBlockTimeSub');
            if (avgSubEl) avgSubEl.textContent = `Last ${this.blockIntervals.length} blocks`;
        }

        // Peak TPS
        const peakEl = document.getElementById('peakTpsValue');
        if (peakEl) peakEl.textContent = this.peakTpsSession.toFixed(2);
        const peak1mEl = document.getElementById('peakTps1m');
        if (peak1mEl) peak1mEl.textContent = `1m: ${peak1m.toFixed(1)}`;
        const peak5mEl = document.getElementById('peakTps5m');
        if (peak5mEl) peak5mEl.textContent = `5m: ${peak5m.toFixed(1)}`;

        // Session duration
        const durEl = document.getElementById('sessionDuration');
        if (durEl) {
            const mins = Math.floor(elapsedSec / 60);
            const secs = Math.floor(elapsedSec % 60);
            durEl.textContent = mins > 0 ? `${mins}m ${secs}s session` : `${secs}s session`;
        }

        // Total blocks and accounts from header stats
        const blockCountEl = document.getElementById('statTotalBlocks');
        if (blockCountEl) {
            const headerVal = document.getElementById('blockCount')?.textContent;
            if (headerVal && headerVal !== '--') blockCountEl.textContent = headerVal;
        }

        // Known accounts — try header first, fall back to tracked accounts
        const accCountEl = document.getElementById('statKnownAccounts');
        if (accCountEl) {
            const headerVal = document.getElementById('accountCount')?.textContent;
            if (headerVal && headerVal !== '--') {
                accCountEl.textContent = headerVal;
            } else if (this.accountActivity.size > 0) {
                accCountEl.textContent = this.accountActivity.size.toLocaleString();
                const sub = document.getElementById('knownAccountsSub');
                if (sub) sub.textContent = 'Active this session';
            }
        }

        // Node uptime
        const uptimeEl = document.getElementById('statNodeUptime');
        if (uptimeEl) {
            const headerVal = document.getElementById('nodeUptime')?.textContent;
            if (headerVal && headerVal !== '--') uptimeEl.textContent = headerVal;
        }

        // Session volume
        const volEl = document.getElementById('sessionVolume');
        if (volEl && typeof Explorer !== 'undefined') {
            volEl.textContent = Explorer.formatAmount(this.sessionVolume.toString()) + ' KNEX';
        }

        // Largest transaction
        if (this.largestTx.amount > 0n) {
            const ltxEl = document.getElementById('largestTxValue');
            const ltxSub = document.getElementById('largestTxSub');
            if (ltxEl && typeof Explorer !== 'undefined') {
                ltxEl.textContent = Explorer.formatAmount(this.largestTx.amount.toString()) + ' KNEX';
            }
            if (ltxSub) {
                const typeColor = {
                    send: '#ff3b3b', receive: '#00e676', open: '#448aff',
                    change: '#bb86fc', bandwidth: '#4dd0e1', pending: '#ffc107',
                }[this.largestTx.type] || '#FF8C00';
                ltxSub.innerHTML = `<span style="color:${typeColor}">${this.largestTx.type.toUpperCase()}</span> &middot; ${this.largestTx.hash.slice(0, 12)}...`;
            }
        }

        // Draw sparklines
        this.drawSparkline('tpsSparkline', this.tpsData, '#FF8C00');
        this.drawSparkline('bpmSparkline', this.bpmData, '#FFD700');
        this.drawSparkline('blockTimeSparkline', this.blockTimeData, '#4dd0e1');

        // Draw type distribution donut
        this.drawTypeDonut();

        // Update top accounts
        this.renderTopAccounts();
    },

    // =============================================
    // HEALTH INDICATOR
    // =============================================
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

    // =============================================
    // NETWORK PULSE — visual heartbeat on new block
    // =============================================
    triggerPulse() {
        const el = document.getElementById('networkPulse');
        if (!el) return;
        el.classList.remove('pulse-animate');
        // Force reflow to restart animation
        void el.offsetWidth;
        el.classList.add('pulse-animate');
    },

    // =============================================
    // TYPE DISTRIBUTION DONUT CHART
    // =============================================
    drawTypeDonut() {
        const canvas = document.getElementById('typeDonutChart');
        if (!canvas) return;

        const total = Object.values(this.typeCounts).reduce((a, b) => a + b, 0);
        if (total === 0) return;

        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const size = 120;

        if (canvas.width !== size * dpr) {
            canvas.width = size * dpr;
            canvas.height = size * dpr;
            ctx.scale(dpr, dpr);
        }

        ctx.clearRect(0, 0, size, size);

        const cx = size / 2;
        const cy = size / 2;
        const outerR = 50;
        const innerR = 30;

        const colors = {
            send: '#ff3b3b', receive: '#00e676', open: '#448aff',
            change: '#bb86fc', bandwidth: '#4dd0e1', pending: '#ffc107',
        };

        let startAngle = -Math.PI / 2;

        for (const [type, count] of Object.entries(this.typeCounts)) {
            if (count === 0) continue;
            const sliceAngle = (count / total) * Math.PI * 2;

            ctx.beginPath();
            ctx.arc(cx, cy, outerR, startAngle, startAngle + sliceAngle);
            ctx.arc(cx, cy, innerR, startAngle + sliceAngle, startAngle, true);
            ctx.closePath();
            ctx.fillStyle = colors[type] || '#777';
            ctx.fill();

            startAngle += sliceAngle;
        }

        // Center text
        ctx.fillStyle = 'var(--text, #e8e8e8)';
        ctx.font = '700 16px JetBrains Mono';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#e8e8e8';
        ctx.fillText(total.toString(), cx, cy - 4);
        ctx.font = '500 8px JetBrains Mono';
        ctx.fillStyle = '#888';
        ctx.fillText('blocks', cx, cy + 10);

        // Update legend
        const legend = document.getElementById('typeDistLegend');
        if (legend) {
            legend.innerHTML = Object.entries(this.typeCounts)
                .filter(([, count]) => count > 0)
                .map(([type, count]) => {
                    const pct = ((count / total) * 100).toFixed(0);
                    return `<div class="type-dist-item">
                        <span class="legend-dot" style="background:${colors[type]}"></span>
                        <span>${type}</span>
                        <span class="type-dist-count">${count} (${pct}%)</span>
                    </div>`;
                }).join('');
        }
    },

    // =============================================
    // TOP ACCOUNTS
    // =============================================
    renderTopAccounts() {
        const container = document.getElementById('topAccountsList');
        if (!container || this.accountActivity.size === 0) return;

        // Sort by total activity (sends + receives)
        const sorted = [...this.accountActivity.entries()]
            .map(([addr, data]) => ({ addr, total: data.sends + data.receives, ...data }))
            .sort((a, b) => b.total - a.total)
            .slice(0, 5);

        const known = typeof KnexAccount !== 'undefined' ? KnexAccount.knownAccounts : {};

        container.innerHTML = sorted.map((acct, i) => {
            const k = known[acct.addr];
            const label = k ? `<span style="color:${k.color}">${k.label}</span>` :
                `<span class="address-link" data-address="${acct.addr}" style="cursor:pointer">${acct.addr.slice(0, 8)}...${acct.addr.slice(-6)}</span>`;
            const vol = typeof Explorer !== 'undefined' ? Explorer.formatAmount(acct.volume.toString()) : '0';
            return `<div class="top-account-row">
                <span class="top-account-rank">#${i + 1}</span>
                ${label}
                <span class="top-account-stats">
                    <span style="color:#ff3b3b">${acct.sends}s</span>
                    <span style="color:#00e676">${acct.receives}r</span>
                    <span style="color:var(--gold)">${vol}</span>
                </span>
            </div>`;
        }).join('');

        // Bind click handlers
        container.querySelectorAll('.address-link').forEach(el => {
            el.addEventListener('click', () => {
                const addr = el.dataset.address;
                if (addr && typeof Explorer !== 'undefined') Explorer.lookupAccount(addr);
            });
        });
    },

    // =============================================
    // SPARKLINE RENDERER
    // =============================================
    drawSparkline(canvasId, data, color) {
        const canvas = document.getElementById(canvasId);
        if (!canvas || data.length < 2) return;

        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.offsetWidth;
        const h = canvas.offsetHeight;

        if (w === 0 || h === 0) return;

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

        // Endpoint dot
        if (data.length > 0) {
            const lastX = (data.length - 1) * stepX;
            const lastY = h - (data[data.length - 1] / max) * (h - 4);
            ctx.beginPath();
            ctx.arc(lastX, lastY, 2.5, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
        }
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

        // 2. QR Code (PWA-style glass container, centered)
        if (typeof qrcode !== 'undefined') {
            try {
                const qr = qrcode(0, 'M');
                qr.addData(address);
                qr.make();

                const qrContainer = document.createElement('div');
                qrContainer.className = 'qr-container';

                const qrBox = document.createElement('div');
                qrBox.className = 'account-qr';
                qrBox.innerHTML = qr.createImgTag(3, 0);

                qrContainer.appendChild(qrBox);
                container.appendChild(qrContainer);
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

/**
 * KnexCore — Validator Topology Section
 * Renders an orbital topology diagram and validator cards
 * Fetches from /api/v1/validators and /api/v1/pob/status
 */
const KnexCore = {
    validators: [],
    pobStatus: null,
    rotation: 0,
    animFrame: null,
    loaded: false,

    init() {
        const tab = document.getElementById('tabCore');
        if (tab) {
            tab.addEventListener('click', () => {
                if (!this.loaded) {
                    this.loaded = true;
                    this.fetchAndRender();
                    this.startAnimation();
                }
            });
        }
        const refreshBtn = document.getElementById('refreshCore');
        if (refreshBtn) refreshBtn.addEventListener('click', () => this.fetchAndRender());
    },

    async fetchAndRender() {
        try {
            const [valRes, pobRes] = await Promise.all([
                fetch(`${Explorer.config.apiUrl}/api/v1/validators`),
                fetch(`${Explorer.config.apiUrl}/api/v1/pob/status`),
            ]);

            if (valRes.ok) {
                const data = await valRes.json();
                this.validators = data.validators || [];
            }
            if (pobRes.ok) {
                this.pobStatus = await pobRes.json();
            }

            this.renderValidatorCards();
            this.renderPobBar();
            this.updateConsensusBadge();
            this.drawTopology();
        } catch (e) {
            console.warn('[Core] Failed to fetch:', e);
        }
    },

    // =============================================
    // CONSENSUS BADGE
    // =============================================
    updateConsensusBadge() {
        const el = document.getElementById('coreConsensusStatus');
        if (!el) return;
        const active = this.validators.filter(v => v.is_active).length;
        const total = this.validators.length;
        if (active >= 2) {
            el.textContent = `Active (${active}/${total})`;
            el.style.color = 'var(--green)';
        } else if (active >= 1) {
            el.textContent = `Degraded (${active}/${total})`;
            el.style.color = '#ffc107';
        } else {
            el.textContent = 'Offline';
            el.style.color = 'var(--red)';
        }
    },

    // =============================================
    // VALIDATOR CARDS
    // =============================================
    renderValidatorCards() {
        const grid = document.getElementById('coreValidatorsGrid');
        if (!grid) return;

        if (this.validators.length === 0) {
            grid.innerHTML = '<div class="stat-card-sub" style="padding:20px;text-align:center">No validators registered</div>';
            return;
        }

        const known = typeof KnexAccount !== 'undefined' ? KnexAccount.knownAccounts : {};

        grid.innerHTML = this.validators.map((v, i) => {
            const k = known[v.address];
            const label = k ? k.label : `Validator ${i + 1}`;
            const labelColor = k ? k.color : 'var(--orange)';
            const statusColor = v.is_active ? 'var(--green)' : 'var(--red)';
            const statusText = v.is_active ? 'Active' : 'Inactive';
            const reliableText = v.is_reliable ? 'Reliable' : 'Unreliable';
            const reliableColor = v.is_reliable ? 'var(--green)' : '#ffc107';

            // Format stake from raw to KNEX
            const stakeKnex = typeof Explorer !== 'undefined' ?
                Explorer.formatAmount(v.stake) : v.stake;

            // Uptime formatting
            const upH = Math.floor(v.uptime_seconds / 3600);
            const upM = Math.floor((v.uptime_seconds % 3600) / 60);
            const uptimeStr = upH > 0 ? `${upH}h ${upM}m` : `${upM}m`;

            // Identicon
            let identicon = '';
            if (typeof KnexIdenticon !== 'undefined' && Explorer.identiconCache) {
                const cacheKey = `${v.address}:32`;
                if (Explorer.identiconCache.has(cacheKey)) {
                    identicon = `<img src="${Explorer.identiconCache.get(cacheKey)}" width="32" height="32" style="border-radius:6px;image-rendering:pixelated">`;
                } else {
                    // Generate identicon on the fly
                    try {
                        const url = KnexIdenticon.generate(v.address, 32);
                        Explorer.identiconCache.set(cacheKey, url);
                        identicon = `<img src="${url}" width="32" height="32" style="border-radius:6px;image-rendering:pixelated">`;
                    } catch (e) {}
                }
            }

            return `<div class="core-validator-card">
                <div class="core-validator-header">
                    ${identicon}
                    <div>
                        <div class="core-validator-label" style="color:${labelColor}">${label}</div>
                        <div class="core-validator-addr address-link" data-address="${v.address}">${v.address.slice(0, 10)}...${v.address.slice(-6)}</div>
                    </div>
                    <span class="core-status-dot" style="background:${statusColor}" title="${statusText}"></span>
                </div>
                <div class="core-validator-stats">
                    <div class="core-vstat">
                        <span class="core-vstat-label">Stake</span>
                        <span class="core-vstat-value">${stakeKnex} <span style="font-size:10px;color:var(--text-muted)">KNEX</span></span>
                    </div>
                    <div class="core-vstat">
                        <span class="core-vstat-label">Reputation</span>
                        <span class="core-vstat-value">${v.reputation}<span style="font-size:10px;color:var(--text-muted)">/100</span></span>
                    </div>
                    <div class="core-vstat">
                        <span class="core-vstat-label">Uptime</span>
                        <span class="core-vstat-value">${uptimeStr}</span>
                    </div>
                    <div class="core-vstat">
                        <span class="core-vstat-label">Validations</span>
                        <span class="core-vstat-value">${v.validations_count.toLocaleString()}</span>
                    </div>
                    <div class="core-vstat">
                        <span class="core-vstat-label">Failures</span>
                        <span class="core-vstat-value" style="color:${v.failures_count > 0 ? 'var(--red)' : 'var(--text)'}">${v.failures_count}</span>
                    </div>
                    <div class="core-vstat">
                        <span class="core-vstat-label">Status</span>
                        <span class="core-vstat-value" style="color:${reliableColor}">${reliableText}</span>
                    </div>
                </div>
                <div class="core-rep-bar">
                    <div class="core-rep-fill" style="width:${v.reputation}%;background:${v.reputation >= 80 ? 'var(--green)' : v.reputation >= 50 ? '#ffc107' : 'var(--red)'}"></div>
                </div>
            </div>`;
        }).join('');

        // Bind address links
        grid.querySelectorAll('.address-link').forEach(el => {
            el.addEventListener('click', () => {
                const addr = el.dataset.address;
                if (addr && typeof Explorer !== 'undefined') Explorer.lookupAccount(addr);
            });
        });
    },

    // =============================================
    // PoB STATUS BAR
    // =============================================
    renderPobBar() {
        const bar = document.getElementById('corePobBar');
        if (!bar || !this.pobStatus) return;

        const p = this.pobStatus;
        bar.innerHTML = `
            <div class="core-pob-item">
                <span class="core-pob-label">Protocol</span>
                <span class="core-pob-value">Proof of Balance (PoB)</span>
            </div>
            <div class="core-pob-item">
                <span class="core-pob-label">Validators</span>
                <span class="core-pob-value">${p.active_validators} / ${p.validator_count} active</span>
            </div>
            <div class="core-pob-item">
                <span class="core-pob-label">Node Version</span>
                <span class="core-pob-value">v${p.node_version}</span>
            </div>
            <div class="core-pob-item">
                <span class="core-pob-label">Epoch Duration</span>
                <span class="core-pob-value">${p.epoch_duration}s</span>
            </div>
        `;
    },

    // =============================================
    // TOPOLOGY CANVAS — Orbital wireframe diagram
    // =============================================
    startAnimation() {
        const loop = () => {
            this.rotation += 0.004;
            this.drawTopology();
            this.animFrame = requestAnimationFrame(loop);
        };
        this.animFrame = requestAnimationFrame(loop);
    },

    drawTopology() {
        const canvas = document.getElementById('coreTopologyCanvas');
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.offsetWidth || 800;
        const h = canvas.offsetHeight || 400;

        if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
            canvas.width = w * dpr;
            canvas.height = h * dpr;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        const cx = w / 2;
        const cy = h / 2;
        const orbitRx = Math.min(w, h) * 0.35;
        const orbitRy = orbitRx * 0.35; // perspective squish
        const rot = this.rotation;

        // Draw orbital rings
        for (let ring = 0; ring < 3; ring++) {
            const scale = 0.7 + ring * 0.2;
            const rx = orbitRx * scale;
            const ry = orbitRy * scale;
            ctx.beginPath();
            ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(255,140,0,${0.08 + ring * 0.04})`;
            ctx.lineWidth = 0.5;
            ctx.stroke();
        }

        // Draw radial lines from center to edges
        for (let i = 0; i < 8; i++) {
            const angle = (i / 8) * Math.PI * 2 + rot * 0.5;
            const ex = cx + Math.cos(angle) * orbitRx;
            const ey = cy + Math.sin(angle) * orbitRy;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(ex, ey);
            ctx.strokeStyle = 'rgba(255,140,0,0.04)';
            ctx.lineWidth = 0.5;
            ctx.stroke();
        }

        // Central wireframe globe (the network core)
        this._drawWireframeGlobe(ctx, cx, cy, 30, '#FF8C00', rot, 0.6);

        // "CORE" text at center
        ctx.font = '600 10px JetBrains Mono';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(255,140,0,0.5)';
        ctx.fillText('CORE', cx, cy + 40);

        // Draw validators orbiting
        const valCount = this.validators.length;
        if (valCount === 0) return;

        // Connection lines between all validators
        const positions = [];
        for (let i = 0; i < valCount; i++) {
            const angle = rot + (i / valCount) * Math.PI * 2;
            const vx = cx + Math.cos(angle) * orbitRx * 0.85;
            const vy = cy + Math.sin(angle) * orbitRy * 0.85;
            positions.push({ x: vx, y: vy });
        }

        // Draw connections (mesh lines between validators)
        for (let i = 0; i < positions.length; i++) {
            for (let j = i + 1; j < positions.length; j++) {
                ctx.beginPath();
                ctx.moveTo(positions[i].x, positions[i].y);
                ctx.lineTo(positions[j].x, positions[j].y);
                ctx.strokeStyle = 'rgba(255,215,0,0.12)';
                ctx.lineWidth = 1;
                ctx.setLineDash([4, 4]);
                ctx.stroke();
                ctx.setLineDash([]);
            }
            // Connection line to core
            ctx.beginPath();
            ctx.moveTo(positions[i].x, positions[i].y);
            ctx.lineTo(cx, cy);
            ctx.strokeStyle = 'rgba(255,140,0,0.15)';
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        // Draw validator nodes as wireframe globes
        for (let i = 0; i < valCount; i++) {
            const v = this.validators[i];
            const { x, y } = positions[i];
            const nodeColor = v.is_active ? '#00e676' : '#ff3b3b';
            const nodeR = 18 + (v.reputation / 100) * 8;
            this._drawWireframeGlobe(ctx, x, y, nodeR, nodeColor, rot, i * 1.3);

            // Validator label
            ctx.font = '500 9px JetBrains Mono';
            ctx.textAlign = 'center';
            ctx.fillStyle = nodeColor;
            const known = typeof KnexAccount !== 'undefined' && KnexAccount.knownAccounts?.[v.address];
            const label = known ? known.label : `V${i + 1}`;
            ctx.fillText(label, x, y + nodeR + 14);

            // Active pulse ring
            if (v.is_active) {
                const pulseR = nodeR + 4 + Math.sin(rot * 3 + i) * 3;
                ctx.beginPath();
                ctx.arc(x, y, pulseR, 0, Math.PI * 2);
                ctx.strokeStyle = `rgba(0,230,118,${0.15 + Math.sin(rot * 3 + i) * 0.1})`;
                ctx.lineWidth = 1;
                ctx.stroke();
            }
        }

        // Floating data particles along connection lines
        for (let i = 0; i < positions.length; i++) {
            const t = ((rot * 2 + i * 1.5) % (Math.PI * 2)) / (Math.PI * 2);
            const px = cx + (positions[i].x - cx) * t;
            const py = cy + (positions[i].y - cy) * t;
            ctx.beginPath();
            ctx.arc(px, py, 2, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255,215,0,0.4)';
            ctx.fill();
        }
    },

    /**
     * Draw a wireframe globe (same style as DAG nodes)
     */
    _drawWireframeGlobe(ctx, cx, cy, r, color, rotation, hashOffset) {
        const rot = rotation + (hashOffset || 0);
        const alpha = 0.7;
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(0.5, r / 20);
        ctx.globalAlpha = alpha;

        // Outer circle
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();

        // Latitude lines
        for (let i = 1; i <= 3; i++) {
            const lat = (i / 4) * Math.PI - Math.PI / 2;
            const yOff = Math.sin(lat) * r;
            const rLat = Math.cos(lat) * r;
            ctx.beginPath();
            ctx.ellipse(cx, cy + yOff, rLat, rLat * 0.15, 0, 0, Math.PI * 2);
            ctx.stroke();
        }

        // Longitude lines (rotating)
        for (let i = 0; i < 4; i++) {
            const angle = rot + (i / 4) * Math.PI;
            const horizScale = Math.cos(angle);
            ctx.beginPath();
            ctx.ellipse(cx, cy, Math.abs(horizScale) * r, r, 0, 0, Math.PI * 2);
            ctx.stroke();
        }

        // Subtle inner glow
        ctx.globalAlpha = 0.06;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.85, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = 1;
    },
};
