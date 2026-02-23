/**
 * KnexCore — Core Tab Module for SuperKnet Explorer
 *
 * Renders:
 *   - 2D canvas topology with validators (colored) and nodes (white wireframe, 1/4 size)
 *   - Validator cards with tier badges (Tier 1 Mega ... Tier 5 Micro)
 *   - Total KNEX staked across system
 *   - Network stats (validators by tier)
 */

const KnexCore = {
    config: {
        apiUrl: 'https://api.knexcoins.com',
        refreshInterval: 30000, // 30s auto-refresh
        // Tier colors
        tierColors: {
            1: '#ffc107', // Mega — gold
            2: '#ff9800', // Large — orange
            3: '#4fc3f7', // Standard — light blue
            4: '#66bb6a', // Small — green
            5: '#bdbdbd', // Micro — gray
        },
        tierNames: {
            1: 'Mega',
            2: 'Large',
            3: 'Standard',
            4: 'Small',
            5: 'Micro',
        },
    },

    state: {
        validators: [],
        networkStats: null,
        refreshTimer: null,
        loaded: false,
    },

    init() {
        // Bind Core tab click to lazy-load
        document.getElementById('tabCore')?.addEventListener('click', () => {
            if (!this.state.loaded) {
                this.load();
                this.state.loaded = true;
            }
        });

        // Refresh button
        document.getElementById('refreshCore')?.addEventListener('click', () => this.load());
    },

    async load() {
        await Promise.all([
            this.fetchValidators(),
            this.fetchNetworkStats(),
        ]);
        this.renderValidatorCards();
        this.renderTopology();
        this.renderPobBar();

        // Auto-refresh
        if (this.state.refreshTimer) clearInterval(this.state.refreshTimer);
        this.state.refreshTimer = setInterval(() => this.load(), this.config.refreshInterval);
    },

    async fetchValidators() {
        try {
            const resp = await fetch(`${this.config.apiUrl}/api/v1/validators`);
            if (!resp.ok) return;
            const data = await resp.json();
            this.state.validators = data.validators || [];
            // Also update Explorer's validator cache
            if (typeof Explorer !== 'undefined') {
                Explorer.state.validatorAddresses = new Set();
                Explorer.state.validatorData = this.state.validators;
                for (const v of this.state.validators) {
                    if (v.address) Explorer.state.validatorAddresses.add(v.address);
                }
            }
        } catch (e) {
            console.warn('[KnexCore] Failed to fetch validators:', e);
        }
    },

    async fetchNetworkStats() {
        try {
            const resp = await fetch(`${this.config.apiUrl}/api/v1/network/stats`);
            if (!resp.ok) return;
            this.state.networkStats = await resp.json();
        } catch (e) {
            console.warn('[KnexCore] Failed to fetch network stats:', e);
        }
    },

    // =============================================
    // VALIDATOR CARDS
    // =============================================
    renderValidatorCards() {
        const grid = document.getElementById('coreValidatorsGrid');
        if (!grid) return;

        const validators = this.state.validators;
        if (!validators.length) {
            grid.innerHTML = '<div class="feed-empty">No validators registered</div>';
            return;
        }

        // Sort: active first, then by tier (1=Mega first), then by stake desc
        const sorted = [...validators].sort((a, b) => {
            if (a.is_active !== b.is_active) return b.is_active ? 1 : -1;
            if (a.tier !== b.tier) return a.tier - b.tier;
            return BigInt(b.stake) > BigInt(a.stake) ? 1 : -1;
        });

        grid.innerHTML = sorted.map((v, i) => {
            const tierColor = this.config.tierColors[v.tier] || '#bdbdbd';
            const tierName = v.tier_name || this.config.tierNames[v.tier] || 'Unknown';
            const stakeKnex = this.formatKnex(v.stake);
            const shortAddr = v.address ? (v.address.slice(0, 8) + '...' + v.address.slice(-6)) : '---';
            const statusDot = v.is_active ? 'status-active' : 'status-inactive';
            const rewardMult = v.reward_multiplier ? `${v.reward_multiplier}x` : '---';

            return `
                <div class="core-validator-card" style="border-left: 3px solid ${tierColor}">
                    <div class="core-validator-header">
                        <span class="core-validator-name">V${i + 1}</span>
                        <span class="core-tier-badge" style="background: ${tierColor}20; color: ${tierColor}; border: 1px solid ${tierColor}40">
                            Tier ${v.tier} ${tierName}
                        </span>
                        <span class="core-status-dot ${statusDot}"></span>
                    </div>
                    <div class="core-validator-address" data-address="${v.address || ''}" title="${v.address || ''}">${shortAddr}</div>
                    <div class="core-validator-stats">
                        <div class="core-stat">
                            <span class="core-stat-label">Staked</span>
                            <span class="core-stat-value">${stakeKnex} KNEX</span>
                        </div>
                        <div class="core-stat">
                            <span class="core-stat-label">Reward</span>
                            <span class="core-stat-value">${rewardMult}</span>
                        </div>
                        <div class="core-stat">
                            <span class="core-stat-label">Rep</span>
                            <span class="core-stat-value">${v.reputation}/100</span>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    },

    // =============================================
    // POB BAR (Total Staked + Tier Breakdown)
    // =============================================
    renderPobBar() {
        const bar = document.getElementById('corePobBar');
        if (!bar) return;

        const stats = this.state.networkStats;
        const totalStaked = stats ? this.formatKnex(stats.total_staked) : '---';
        const activeCount = stats ? stats.active_validators : 0;

        // Tier breakdown
        let tierBreakdown = '';
        if (stats && stats.validators_by_tier) {
            tierBreakdown = stats.validators_by_tier
                .filter(t => t.count > 0)
                .map(t => {
                    const color = this.config.tierColors[t.tier] || '#bdbdbd';
                    return `<span class="core-tier-chip" style="color: ${color}">T${t.tier} ${t.name}: ${t.count}</span>`;
                })
                .join(' ');
        }

        bar.innerHTML = `
            <div class="core-pob-stats">
                <div class="core-pob-stat">
                    <span class="core-pob-label">Total Staked</span>
                    <span class="core-pob-value">${totalStaked} KNEX</span>
                </div>
                <div class="core-pob-stat">
                    <span class="core-pob-label">Active Validators</span>
                    <span class="core-pob-value">${activeCount}</span>
                </div>
                <div class="core-pob-tiers">${tierBreakdown}</div>
            </div>
        `;
    },

    // =============================================
    // TOPOLOGY CANVAS
    // =============================================
    renderTopology() {
        const canvas = document.getElementById('coreTopologyCanvas');
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        const W = canvas.width;
        const H = canvas.height;

        ctx.clearRect(0, 0, W, H);

        // Background
        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(0, 0, W, H);

        const validators = this.state.validators.filter(v => v.is_active);
        if (!validators.length) {
            ctx.fillStyle = '#666';
            ctx.font = '14px monospace';
            ctx.textAlign = 'center';
            ctx.fillText('No active validators', W / 2, H / 2);
            return;
        }

        // Layout validators in a circle
        const centerX = W / 2;
        const centerY = H / 2;
        const radius = Math.min(W, H) * 0.35;
        const validatorRadius = 20;
        const nodeRadius = 6; // 1/4 size for non-validator nodes

        const positions = [];

        // Position validators around the circle
        for (let i = 0; i < validators.length; i++) {
            const angle = (2 * Math.PI * i) / validators.length - Math.PI / 2;
            const x = centerX + radius * Math.cos(angle);
            const y = centerY + radius * Math.sin(angle);
            positions.push({ x, y, validator: validators[i], index: i });
        }

        // Draw connections between validators (mesh)
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1;
        for (let i = 0; i < positions.length; i++) {
            for (let j = i + 1; j < positions.length; j++) {
                ctx.beginPath();
                ctx.moveTo(positions[i].x, positions[i].y);
                ctx.lineTo(positions[j].x, positions[j].y);
                ctx.stroke();
            }
        }

        // Draw validators
        for (const pos of positions) {
            const v = pos.validator;
            const tier = v.tier || 5;
            const color = this.config.tierColors[tier] || '#bdbdbd';
            const tierName = v.tier_name || this.config.tierNames[tier] || 'Micro';

            // Filled circle
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, validatorRadius, 0, 2 * Math.PI);
            ctx.fillStyle = color + '33'; // translucent fill
            ctx.fill();
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.stroke();

            // Label inside circle
            ctx.fillStyle = color;
            ctx.font = 'bold 10px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`V${pos.index + 1}`, pos.x, pos.y);

            // Tier label below
            ctx.fillStyle = '#888';
            ctx.font = '9px monospace';
            ctx.fillText(`T${tier} ${tierName}`, pos.x, pos.y + validatorRadius + 12);

            // Stake amount below tier
            const stakeKnex = this.formatKnex(v.stake);
            ctx.fillStyle = '#555';
            ctx.font = '8px monospace';
            ctx.fillText(`${stakeKnex} KNEX`, pos.x, pos.y + validatorRadius + 22);
        }

        // Update consensus badge
        const badge = document.getElementById('coreConsensusStatus');
        if (badge) {
            const activeCount = validators.length;
            badge.textContent = `${activeCount} validator${activeCount !== 1 ? 's' : ''} active`;
            badge.style.color = activeCount >= 3 ? '#00e676' : '#ff3b3b';
        }
    },

    // =============================================
    // HELPERS
    // =============================================
    formatKnex(raw) {
        if (!raw) return '0';
        try {
            const val = BigInt(raw);
            const knex = Number(val) / 10000000;
            if (knex >= 1000) return knex.toLocaleString('en-US', { maximumFractionDigits: 0 });
            if (knex >= 1) return knex.toLocaleString('en-US', { maximumFractionDigits: 2 });
            return knex.toLocaleString('en-US', { maximumFractionDigits: 7 });
        } catch {
            return '0';
        }
    },
};
