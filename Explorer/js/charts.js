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
    typeCounts: { send: 0, receive: 0, open: 0, change: 0, bandwidth: 0, pending: 0, stake: 0, unstake: 0 },

    // Top accounts
    accountActivity: new Map(), // account -> { sends, receives, volume }

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
        // Refresh staking/validator stats every 30 seconds
        setInterval(() => this.fetchNetworkStats(), 30000);
    },

    // =============================================
    // VIEW TAB SWITCHING
    // =============================================
    initViewTabs() {
        const tabMap = {
            tabFeed: 'liveFeedPanel',
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

            <!-- Row 5: Staking & Validator Stats -->
            <div class="stat-card">
                <div class="stat-card-label">Total Staked</div>
                <div class="stat-card-value" id="statTotalStaked">--</div>
                <div class="stat-card-sub" id="statStakingRatio">--% of supply</div>
            </div>

            <div class="stat-card">
                <div class="stat-card-label">Active Validators</div>
                <div class="stat-card-value" id="statActiveValidators" style="color:#e040fb">--</div>
                <div class="stat-card-sub" id="statTotalValidators">-- total registered</div>
            </div>

            <div class="stat-card stat-card-wide">
                <div class="stat-card-label">Validators by Tier</div>
                <div class="tier-breakdown" id="tierBreakdown"></div>
                <div class="tier-breakdown-legend" id="tierBreakdownLegend"></div>
            </div>

            <div class="stat-card">
                <div class="stat-card-label">Network Security</div>
                <div class="stat-card-value" id="statSecurityScore">--</div>
                <div class="stat-card-sub" id="statSecuritySub">Consensus status</div>
            </div>
        `;

        // Fetch staking stats immediately
        this.fetchNetworkStats();
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
    // NETWORK STATS — Staking & Validators
    // =============================================
    async fetchNetworkStats() {
        try {
            const res = await Explorer.fetchApi(`${Explorer.config.apiUrl}/api/v1/network/stats`);
            if (!res.ok) return;
            const data = await res.json();

            // Total Staked
            const stakedEl = document.getElementById('statTotalStaked');
            if (stakedEl) {
                stakedEl.textContent = (data.total_staked_knex || 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' KNEX';
            }

            // Staking ratio (% of 100M supply)
            const ratioEl = document.getElementById('statStakingRatio');
            if (ratioEl) {
                const ratio = ((data.total_staked_knex || 0) / 100000000 * 100).toFixed(4);
                ratioEl.textContent = ratio + '% of supply';
            }

            // Active validators
            const activeEl = document.getElementById('statActiveValidators');
            if (activeEl) activeEl.textContent = data.active_validators || 0;

            const totalEl = document.getElementById('statTotalValidators');
            if (totalEl) totalEl.textContent = (data.total_validators || 0) + ' total registered';

            // Tier breakdown
            if (data.validators_by_tier) {
                this.renderTierBreakdown(data.validators_by_tier);
            }

            // Security score — based on consensus quorum
            this.updateSecurityScore();
        } catch (e) {
            // Silently fail
        }
    },

    renderTierBreakdown(tiers) {
        const bar = document.getElementById('tierBreakdown');
        const legend = document.getElementById('tierBreakdownLegend');
        if (!bar || !legend) return;

        const tierColors = KnexCore?.config?.tierColors || { 1: '#00ff00', 2: '#33cc33', 3: '#00e676', 4: '#29b6f6', 5: '#bdbdbd' };
        const total = tiers.reduce((sum, t) => sum + t.count, 0);

        if (total === 0) {
            bar.innerHTML = '<div style="color:#555;font-size:11px;padding:8px 0">No active validators</div>';
            legend.innerHTML = '';
            return;
        }

        bar.innerHTML = '<div class="tier-bar">' + tiers.map(t => {
            const pct = Math.max((t.count / total * 100), t.count > 0 ? 8 : 0);
            const color = tierColors[t.tier] || '#bdbdbd';
            return `<div class="tier-bar-segment" style="width:${pct}%;background:${color}" title="T${t.tier} ${t.name}: ${t.count} validators"></div>`;
        }).join('') + '</div>';

        legend.innerHTML = tiers.filter(t => t.count > 0).map(t => {
            const color = tierColors[t.tier] || '#bdbdbd';
            const stakedDisplay = t.total_staked_knex >= 1000
                ? (t.total_staked_knex / 1000).toFixed(0) + 'K'
                : (t.total_staked_knex || 0).toFixed(0);
            return `<span class="tier-legend-item"><span class="tier-legend-dot" style="background:${color}"></span>T${t.tier} ${t.name} (${t.count}) — ${stakedDisplay} KNEX</span>`;
        }).join('');
    },

    async updateSecurityScore() {
        try {
            const res = await Explorer.fetchApi(`${Explorer.config.apiUrl}/api/v1/consensus/info`);
            if (!res.ok) return;
            const ci = await res.json();

            const scoreEl = document.getElementById('statSecurityScore');
            const subEl = document.getElementById('statSecuritySub');
            if (!scoreEl) return;

            const tiers = ci.tier_eligibility || [];
            const quorumCount = tiers.filter(t => t.has_quorum).length;
            const totalTiers = tiers.length;

            if (quorumCount === totalTiers) {
                scoreEl.textContent = 'Full Quorum';
                scoreEl.style.color = '#00e676';
                if (subEl) subEl.textContent = `All ${totalTiers} tiers have quorum`;
            } else if (quorumCount > 0) {
                scoreEl.textContent = `${quorumCount}/${totalTiers} Tiers`;
                scoreEl.style.color = '#33ff33';
                if (subEl) subEl.textContent = `${totalTiers - quorumCount} tier(s) need validators`;
            } else {
                scoreEl.textContent = 'No Quorum';
                scoreEl.style.color = '#ff3d3d';
                if (subEl) subEl.textContent = 'Insufficient validators';
            }
        } catch (e) { /* ignore */ }
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
                    change: '#bb86fc', bandwidth: '#4dd0e1', pending: '#33ff33',
                }[this.largestTx.type] || '#00ff00';
                ltxSub.innerHTML = `<span style="color:${typeColor}">${this.largestTx.type.toUpperCase()}</span> &middot; ${this.largestTx.hash.slice(0, 12)}...`;
            }
        }

        // Draw sparklines
        this.drawSparkline('tpsSparkline', this.tpsData, '#00ff00');
        this.drawSparkline('bpmSparkline', this.bpmData, '#33ff33');
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
            change: '#bb86fc', bandwidth: '#4dd0e1', pending: '#33ff33',
            stake: '#e040fb', unstake: '#00ff00',
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
                    <span style="color:var(--green)">${vol}</span>
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
            color: '#33ff33',
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
        grad.addColorStop(0, 'rgba(51,255,51,0.2)');
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
        ctx.strokeStyle = '#33ff33';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Endpoint dot
        if (data.length > 0) {
            const lastX = (data.length - 1) * stepX;
            const lastY = h - ((data[data.length - 1] - min) / range) * (h - 6);
            ctx.beginPath();
            ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
            ctx.fillStyle = '#33ff33';
            ctx.fill();
        }
    },
};

/* KnexCore topology moved to core.js — removed from charts.js to resolve duplicate declaration */
