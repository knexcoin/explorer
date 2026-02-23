/**
 * KnexCore — Core Tab Module for SuperKnet Explorer
 *
 * 3D Globe Topology:
 *   - Validators positioned at real datacenter geographic coordinates
 *   - Node sizes proportional to staked KNEX (sqrt scale)
 *   - Rotating wireframe globe with orthographic projection
 *   - Great-circle arc connections between validators
 *   - Depth-based occlusion (back-hemisphere nodes dimmer/smaller)
 *
 * Also renders:
 *   - Validator cards with tier badges
 *   - Total KNEX staked / PoB status bar
 */

const KnexCore = {
    config: {
        apiUrl: 'https://api.knexcoins.com',
        refreshInterval: 30000,
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

    // Animation state
    rotation: 0,
    animFrame: null,

    // =============================================
    // GEOGRAPHIC REGISTRY — address prefix → location
    // =============================================
    geoRegistry: {
        // V1 — Dallas, TX (HawkHost 198.252.104.24)
        'DuKnng38xov6UthcBck5': { lat: 32.78, lon: -96.81, city: 'Dallas', vnum: 1 },
        '4XE1cufZIHJBWnuBzBPM': { lat: 32.78, lon: -96.81, city: 'Dallas', vnum: 1 },
        // V2 — São Paulo (AWS sa-east-1, 18.228.153.175)
        '4v39kerTmdIvS6VyEZYr': { lat: -23.55, lon: -46.63, city: 'São Paulo', vnum: 2 },
        // V3 — N. California (AWS us-west-1, 3.101.115.76)
        '0AmKBc0lcZPdBZt89jK4': { lat: 37.77, lon: -121.96, city: 'California', vnum: 3 },
        '47icY5pYDda58SNbJk8p': { lat: 37.77, lon: -121.96, city: 'California', vnum: 3 },
        // V4 — Mumbai (AWS ap-south-1, 13.127.144.126)
        '8szAtEjPJb69ki0OKcOa': { lat: 19.08, lon: 72.88, city: 'Mumbai', vnum: 4 },
        // V5 — Sydney (AWS ap-southeast-2, 3.27.85.156)
        'Iw1Ga3SP3PTrMnG6nSAI': { lat: -33.87, lon: 151.21, city: 'Sydney', vnum: 5 },
        'HD7wyf3bRusGCLDzSljH': { lat: -33.87, lon: 151.21, city: 'Sydney', vnum: 5 },
        // V6 — Hong Kong (LeaseWeb HK, 198.252.103.11)
        'G3e0SdNWBYLO5wPAlu1j': { lat: 22.29, lon: 113.94, city: 'Hong Kong', vnum: 6 },
    },

    getGeo(address) {
        if (!address) return this._geoFallback(address || '');
        const prefix = address.slice(0, 20);
        return this.geoRegistry[prefix] || this._geoFallback(address);
    },

    _geoFallback(address) {
        let hash = 0;
        for (let i = 0; i < address.length; i++) {
            hash = ((hash << 5) - hash + address.charCodeAt(i)) | 0;
        }
        const lat = ((hash & 0xFFFF) / 0xFFFF) * 140 - 70;
        const lon = (((hash >> 16) & 0xFFFF) / 0xFFFF) * 360 - 180;
        return { lat, lon, city: '?' };
    },

    // =============================================
    // 3D MATH UTILITIES
    // =============================================
    _latLonToXYZ(lat, lon) {
        const latRad = lat * (Math.PI / 180);
        const lonRad = lon * (Math.PI / 180);
        return {
            x: Math.cos(latRad) * Math.sin(lonRad),  // east = +x
            y: Math.sin(latRad),                       // north = +y
            z: Math.cos(latRad) * Math.cos(lonRad),   // front = lon 0
        };
    },

    _rotatePoint(p, yaw, tilt) {
        // Rotate around Y-axis (yaw = auto-rotation)
        const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
        const x1 = p.x * cosY + p.z * sinY;
        const z1 = -p.x * sinY + p.z * cosY;
        const y1 = p.y;
        // Rotate around X-axis (tilt)
        const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
        const y2 = y1 * cosT - z1 * sinT;
        const z2 = y1 * sinT + z1 * cosT;
        return { x: x1, y: y2, z: z2 };
    },

    _project(p, cx, cy, R) {
        return {
            x: cx + p.x * R,
            y: cy - p.y * R,
            z: p.z,
        };
    },

    _nodeRadius(stakeRaw) {
        const stakeKnex = Number(BigInt(stakeRaw || '0')) / 10000000;
        const sqrtVal = Math.sqrt(Math.max(stakeKnex, 1));
        const maxSqrt = Math.sqrt(15000); // ~122
        const minR = 8;
        const maxR = 32;
        return minR + (Math.min(sqrtVal, maxSqrt) / maxSqrt) * (maxR - minR);
    },

    // =============================================
    // INIT
    // =============================================
    init() {
        document.getElementById('tabCore')?.addEventListener('click', () => {
            if (!this.state.loaded) {
                this.load();
                this.state.loaded = true;
            }
        });
        document.getElementById('refreshCore')?.addEventListener('click', () => this.load());

        // Pause animation when tab hidden
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                if (this.animFrame) {
                    cancelAnimationFrame(this.animFrame);
                    this.animFrame = null;
                }
            } else if (this.state.loaded && !this.animFrame) {
                this.startAnimation();
            }
        });
    },

    async load() {
        await Promise.all([
            this.fetchValidators(),
            this.fetchNetworkStats(),
            this.fetchConsensusInfo(),
        ]);
        this.renderValidatorCards();
        this.renderTopology();
        this.renderPobBar();
        this.renderNerdStats();

        // Start animation on first load
        if (!this.animFrame) this.startAnimation();

        // Auto-refresh data (not animation)
        if (this.state.refreshTimer) clearInterval(this.state.refreshTimer);
        this.state.refreshTimer = setInterval(() => {
            this.fetchValidators().then(() => {
                this.renderValidatorCards();
                this.renderPobBar();
            });
            this.fetchNetworkStats();
            this.fetchConsensusInfo().then(() => this.renderNerdStats());
        }, this.config.refreshInterval);
    },

    // =============================================
    // ANIMATION LOOP
    // =============================================
    startAnimation() {
        const loop = () => {
            this.rotation += 0.003;
            this.renderTopology();
            this.animFrame = requestAnimationFrame(loop);
        };
        this.animFrame = requestAnimationFrame(loop);
    },

    // =============================================
    // DATA FETCHING
    // =============================================
    async fetchValidators() {
        try {
            const resp = await fetch(`${this.config.apiUrl}/api/v1/validators`);
            if (!resp.ok) return;
            const data = await resp.json();
            this.state.validators = data.validators || [];
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

    async fetchConsensusInfo() {
        try {
            const resp = await fetch(`${this.config.apiUrl}/api/v1/consensus/info`);
            if (!resp.ok) return;
            this.state.consensusInfo = await resp.json();
        } catch (e) {
            console.warn('[KnexCore] Failed to fetch consensus info:', e);
        }
    },

    // =============================================
    // 3D GLOBE TOPOLOGY RENDERER
    // =============================================
    renderTopology() {
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
        const R = Math.min(w, h) * 0.42;
        const TILT = -0.4; // ~23° to show both hemispheres
        const yaw = this.rotation;

        // A. Draw globe wireframe
        this._drawGlobeWireframe(ctx, cx, cy, R, yaw, TILT);

        // B. Compute node positions from geographic data
        const validators = this.state.validators.filter(v => v.is_active);
        if (!validators.length) {
            ctx.fillStyle = '#555';
            ctx.font = '12px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('No active validators', cx, cy);
            this._updateConsensusBadge(0);
            return;
        }

        const nodes = validators.map((v, i) => {
            const geo = this.getGeo(v.address);
            const raw3d = this._latLonToXYZ(geo.lat, geo.lon);
            const rotated = this._rotatePoint(raw3d, yaw, TILT);
            const projected = this._project(rotated, cx, cy, R);
            const radius = this._nodeRadius(v.stake);
            return { v, i, geo, raw3d, rotated, projected, radius, z: rotated.z };
        });

        // C. Sort by Z-depth (back to front — painter's algorithm)
        nodes.sort((a, b) => a.z - b.z);

        // D. Draw great-circle arc connections
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                this._drawGreatCircleArc(ctx, nodes[i], nodes[j], cx, cy, R, yaw, TILT);
            }
        }

        // E. Draw validator nodes
        for (const node of nodes) {
            this._drawValidatorNode(ctx, node);
        }

        // F. Floating data particles
        this._drawParticles(ctx, nodes, cx, cy, R, yaw, TILT);

        // Update consensus badge
        this._updateConsensusBadge(validators.length);
    },

    // =============================================
    // GLOBE WIREFRAME (latitude/longitude grid)
    // =============================================
    _drawGlobeWireframe(ctx, cx, cy, R, yaw, tilt) {
        // Outer circle (globe boundary)
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,140,0,0.10)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Subtle fill
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,140,0,0.015)';
        ctx.fill();

        // Latitude lines: -60, -30, 0 (equator), +30, +60
        const latitudes = [-60, -30, 0, 30, 60];
        for (const lat of latitudes) {
            ctx.beginPath();
            let drawing = false;
            for (let lonDeg = 0; lonDeg <= 360; lonDeg += 4) {
                const p = this._latLonToXYZ(lat, lonDeg);
                const r = this._rotatePoint(p, yaw, tilt);
                const proj = this._project(r, cx, cy, R);
                if (r.z >= -0.05) {
                    if (!drawing) { ctx.moveTo(proj.x, proj.y); drawing = true; }
                    else ctx.lineTo(proj.x, proj.y);
                } else {
                    drawing = false;
                }
            }
            ctx.strokeStyle = lat === 0
                ? 'rgba(255,140,0,0.14)'
                : 'rgba(255,140,0,0.06)';
            ctx.lineWidth = lat === 0 ? 0.8 : 0.5;
            ctx.stroke();
        }

        // Longitude lines: every 45°
        for (let lonDeg = 0; lonDeg < 360; lonDeg += 45) {
            ctx.beginPath();
            let drawing = false;
            for (let latDeg = -90; latDeg <= 90; latDeg += 3) {
                const p = this._latLonToXYZ(latDeg, lonDeg);
                const r = this._rotatePoint(p, yaw, tilt);
                const proj = this._project(r, cx, cy, R);
                if (r.z >= -0.05) {
                    if (!drawing) { ctx.moveTo(proj.x, proj.y); drawing = true; }
                    else ctx.lineTo(proj.x, proj.y);
                } else {
                    drawing = false;
                }
            }
            ctx.strokeStyle = 'rgba(255,140,0,0.06)';
            ctx.lineWidth = 0.5;
            ctx.stroke();
        }
    },

    // =============================================
    // GREAT-CIRCLE ARC CONNECTIONS
    // =============================================
    _drawGreatCircleArc(ctx, nodeA, nodeB, cx, cy, R, yaw, tilt) {
        const a = nodeA.raw3d;
        const b = nodeB.raw3d;

        // Angle between points (SLERP parameter)
        const dot = Math.max(-1, Math.min(1, a.x*b.x + a.y*b.y + a.z*b.z));
        const omega = Math.acos(dot);
        if (omega < 0.001) return; // same point

        const sinOmega = Math.sin(omega);
        const steps = 40;

        // Average depth for opacity
        const avgZ = (nodeA.z + nodeB.z) / 2;
        const baseAlpha = Math.max(0.04, Math.min(0.22, (avgZ + 1) / 2.5));

        ctx.beginPath();
        let started = false;

        for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const k1 = Math.sin((1 - t) * omega) / sinOmega;
            const k2 = Math.sin(t * omega) / sinOmega;

            // Interpolated point on sphere surface
            const px = k1 * a.x + k2 * b.x;
            const py = k1 * a.y + k2 * b.y;
            const pz = k1 * a.z + k2 * b.z;

            // Rotate + project
            const rotated = this._rotatePoint({ x: px, y: py, z: pz }, yaw, tilt);
            const proj = this._project(rotated, cx, cy, R);

            if (rotated.z >= -0.08) {
                if (!started) { ctx.moveTo(proj.x, proj.y); started = true; }
                else ctx.lineTo(proj.x, proj.y);
            } else {
                started = false;
            }
        }

        ctx.strokeStyle = `rgba(255,215,0,${baseAlpha.toFixed(3)})`;
        ctx.lineWidth = Math.max(0.5, 1.2 * Math.max(0, (avgZ + 1) / 2));
        ctx.setLineDash([3, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
    },

    // =============================================
    // VALIDATOR NODE DRAWING
    // =============================================
    _drawValidatorNode(ctx, node) {
        const { v, i, geo, projected, radius, z } = node;
        const { x, y } = projected;
        const tier = v.tier || 5;
        const color = this.config.tierColors[tier] || '#bdbdbd';

        // Depth-based occlusion
        const isFront = z >= 0;
        const depthFactor = isFront
            ? 0.7 + 0.3 * z
            : 0.15 + 0.35 * (z + 1);
        const visualRadius = radius * (isFront ? 1.0 : 0.65);

        ctx.save();
        ctx.globalAlpha = Math.max(0.1, depthFactor);

        // Filled translucent circle
        ctx.beginPath();
        ctx.arc(x, y, visualRadius, 0, Math.PI * 2);
        ctx.fillStyle = color + '33';
        ctx.fill();

        // Stroked border
        ctx.beginPath();
        ctx.arc(x, y, visualRadius, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = isFront ? 2 : 1;
        ctx.stroke();

        // V-label inside node
        const fontSize = Math.max(8, Math.round(visualRadius * 0.55));
        ctx.fillStyle = color;
        ctx.font = `bold ${fontSize}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const vnum = geo.vnum || (i + 1);
        ctx.fillText(`V${vnum}`, x, y);

        // City + stake labels (front-facing only, when clear enough)
        if (isFront && depthFactor > 0.55) {
            // City label
            ctx.fillStyle = '#aaa';
            ctx.font = '9px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(geo.city, x, y + visualRadius + 12);

            // Stake amount
            const stakeKnex = this.formatKnex(v.stake);
            ctx.fillStyle = '#666';
            ctx.font = '8px monospace';
            ctx.fillText(`${stakeKnex} KNEX`, x, y + visualRadius + 22);

            // Tier label
            const tierName = v.tier_name || this.config.tierNames[tier] || '';
            ctx.fillStyle = color + '88';
            ctx.font = '7px monospace';
            ctx.fillText(`T${tier} ${tierName}`, x, y + visualRadius + 31);
        }

        // Active pulse ring (front only)
        if (v.is_active && isFront) {
            const pulseR = visualRadius + 4 + Math.sin(this.rotation * 3 + i) * 3;
            ctx.beginPath();
            ctx.arc(x, y, pulseR, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(0,230,118,${(0.12 + Math.sin(this.rotation * 3 + i) * 0.08).toFixed(2)})`;
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        ctx.restore();
    },

    // =============================================
    // FLOATING DATA PARTICLES
    // =============================================
    _drawParticles(ctx, nodes, cx, cy, R, yaw, tilt) {
        if (nodes.length < 2) return;
        const rot = this.rotation;

        // 3 particles traveling along random arcs
        for (let p = 0; p < 3; p++) {
            const ai = p % nodes.length;
            const bi = (p + 1 + Math.floor(p / 2)) % nodes.length;
            const a = nodes[ai].raw3d;
            const b = nodes[bi].raw3d;

            const dot = Math.max(-1, Math.min(1, a.x*b.x + a.y*b.y + a.z*b.z));
            const omega = Math.acos(dot);
            if (omega < 0.01) continue;

            const sinOmega = Math.sin(omega);
            const t = ((rot * 1.5 + p * 2.1) % (Math.PI * 2)) / (Math.PI * 2);
            const k1 = Math.sin((1 - t) * omega) / sinOmega;
            const k2 = Math.sin(t * omega) / sinOmega;

            const px = k1 * a.x + k2 * b.x;
            const py = k1 * a.y + k2 * b.y;
            const pz = k1 * a.z + k2 * b.z;

            const rotated = this._rotatePoint({ x: px, y: py, z: pz }, yaw, tilt);
            if (rotated.z < -0.1) continue;

            const proj = this._project(rotated, cx, cy, R);
            const alpha = Math.max(0.1, 0.3 + 0.3 * rotated.z);

            ctx.beginPath();
            ctx.arc(proj.x, proj.y, 2.5, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255,215,0,${alpha.toFixed(2)})`;
            ctx.fill();
        }
    },

    // =============================================
    // CONSENSUS BADGE
    // =============================================
    _updateConsensusBadge(activeCount) {
        const badge = document.getElementById('coreConsensusStatus');
        if (!badge) return;
        badge.textContent = `${activeCount} validator${activeCount !== 1 ? 's' : ''} active`;
        badge.style.color = activeCount >= 3 ? '#00e676' : '#ff3b3b';
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
            const geo = this.getGeo(v.address);

            const vnum = geo.vnum || (i + 1);
            return `
                <div class="core-validator-card" style="border-left: 3px solid ${tierColor}">
                    <div class="core-validator-header">
                        <span class="core-validator-name">V${vnum}</span>
                        <span class="core-tier-badge" style="background: ${tierColor}20; color: ${tierColor}; border: 1px solid ${tierColor}40">
                            Tier ${v.tier} ${tierName}
                        </span>
                        <span class="core-status-dot ${statusDot}"></span>
                    </div>
                    <div class="core-validator-address" data-address="${v.address || ''}" title="${v.address || ''}">${shortAddr}</div>
                    <div class="core-validator-location" style="font-size:10px;color:#888;margin:2px 0 6px">${geo.city}</div>
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
    // CONSENSUS NERD STATS
    // =============================================
    renderNerdStats() {
        const body = document.getElementById('coreNerdBody');
        if (!body) return;
        const ci = this.state.consensusInfo;
        if (!ci) {
            body.innerHTML = '<div class="feed-empty">Consensus data unavailable</div>';
            return;
        }

        const enforcedColor = ci.consensus_enforced ? '#00e676' : '#ffc107';
        const enforcedLabel = ci.consensus_enforced ? 'Active' : 'Monitor Only';

        // Build tier table rows
        const tierRows = (ci.tiers || []).map((t, i) => {
            const elig = ci.tier_eligibility?.[i] || {};
            const quorumIcon = elig.has_quorum ? '&#x2705;' : '&#x274c;';
            const tierColor = this.config.tierColors[t.level] || '#bdbdbd';
            const stakeDisplay = t.required_stake_knex >= 1000
                ? (t.required_stake_knex / 1000).toLocaleString('en-US') + 'K'
                : t.required_stake_knex.toLocaleString('en-US');
            const attackDisplay = t.attack_cost_knex >= 1000
                ? (t.attack_cost_knex / 1000).toLocaleString('en-US') + 'K'
                : t.attack_cost_knex.toLocaleString('en-US');

            return `<tr>
                <td style="color:${tierColor}">T${t.level} ${t.name}</td>
                <td>${stakeDisplay} KNEX</td>
                <td>${t.reward_multiplier}x</td>
                <td>${elig.eligible_validators || 0}</td>
                <td>${elig.effective_committee_size || 0}</td>
                <td>${elig.required_attestations || 0} <span style="color:#666">(${t.consensus_threshold_pct}%)</span></td>
                <td>${attackDisplay} KNEX</td>
                <td>${quorumIcon}</td>
            </tr>`;
        }).join('');

        body.innerHTML = `
            <div class="core-nerd-grid">
                <div class="core-nerd-item">
                    <span class="core-nerd-label">Consensus Model</span>
                    <span class="core-nerd-value">SPVT</span>
                </div>
                <div class="core-nerd-item">
                    <span class="core-nerd-label">Committee Cap</span>
                    <span class="core-nerd-value">${ci.committee_cap}</span>
                </div>
                <div class="core-nerd-item">
                    <span class="core-nerd-label">Validation Window</span>
                    <span class="core-nerd-value">${ci.validation_window_secs}s</span>
                </div>
                <div class="core-nerd-item">
                    <span class="core-nerd-label">Enforcement</span>
                    <span class="core-nerd-value" style="color:${enforcedColor}">${enforcedLabel}</span>
                </div>
                <div class="core-nerd-item">
                    <span class="core-nerd-label">Total Validators</span>
                    <span class="core-nerd-value">${ci.total_validators}</span>
                </div>
                <div class="core-nerd-item">
                    <span class="core-nerd-label">Active Validators</span>
                    <span class="core-nerd-value" style="color:#00e676">${ci.active_validators}</span>
                </div>
            </div>
            <div class="core-nerd-table-wrap">
                <table class="core-nerd-table">
                    <thead>
                        <tr>
                            <th>Tier</th>
                            <th>Min Stake</th>
                            <th>Reward</th>
                            <th>Eligible</th>
                            <th>Committee</th>
                            <th>Attestations</th>
                            <th>Attack Cost</th>
                            <th>Quorum</th>
                        </tr>
                    </thead>
                    <tbody>${tierRows}</tbody>
                </table>
            </div>
        `;
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
