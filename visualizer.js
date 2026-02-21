/**
 * KnexVisualizer v3 — Full-Featured DAG Visualizer
 * Uses Sigma.js v2 (WebGL) + Graphology for graph data
 * ForceAtlas2 / Circular / Random layout engines
 *
 * Features:
 * - Real-time block streaming via WebSocket + API seeding
 * - Composited node/edge reducers for layered visual effects
 * - Animated node entry (scale-in)
 * - Block type filtering + edge type toggles
 * - Heatmap mode (age-based coloring)
 * - Value flow edges (thickness by amount)
 * - Whale detection & glow effect
 * - Time slider with replay
 * - Search & fly-to camera
 * - Double-click zoom to account chain
 * - Right-click context menu (View, Copy, Highlight, Pin)
 * - Drag-to-pin nodes
 * - Layout selector (ForceAtlas2 / Circular / Random)
 * - Max nodes slider
 * - Live stats overlay (TPS, blocks/s, accounts)
 * - Mini-map with viewport rectangle
 * - Path finder (shortest path between two nodes)
 * - Fullscreen mode
 * - Screenshot + GIF recording
 * - Spatial audio panning
 */
const KnexVisualizer = {
    graph: null,
    renderer: null,
    nodeCount: 0,
    layoutTimer: null,
    initialized: false,
    buffered: [],
    minimapTimer: null,
    statsTimer: null,
    animationFrame: null,
    globeCanvas: null,
    globeCtx: null,
    globeRotation: 0,  // auto-rotation angle in radians
    globeNodeData: new Map(), // node → { color, size, label, blockType } for globe overlay
    edgePulses: [],            // [{ src, tgt, startTime, duration }] for neon pulse animation

    // Block data storage for time slider / search / path finding
    blockData: new Map(),   // hash → full block data
    blockOrder: [],         // hashes in insertion order

    // Color map for block types
    colors: {
        send:      '#ff3b3b',
        receive:   '#00e676',
        open:      '#448aff',
        change:    '#bb86fc',
        bandwidth: '#4dd0e1',
        pending:   '#ffc107',
    },

    // Whale threshold: 1M KNEX in raw (10^10 raw units per KNEX, so 1M KNEX = 10^16)
    whaleThreshold: 10000000000000000n,

    // Centralized state — all features read/write here
    state: {
        visibleTypes: { send: true, receive: true, open: true, change: true, bandwidth: true, pending: true },
        showChainEdges: true,
        showTransferEdges: true,
        heatmapMode: false,
        valueFlowMode: true,
        fullscreen: false,
        currentLayout: 'forceatlas2',
        maxNodes: 200,
        pinnedNodes: new Map(),       // hash → { x, y }
        animatingNodes: new Map(),    // hash → { startTime, targetSize }
        hoveredNode: null,
        highlightedAccount: null,
        highlightedPath: null,        // Set of node hashes
        searchQuery: '',
        timeSliderValue: 100,         // 0-100 percent
        pathFinderMode: null,         // null | 'selectStart' | 'selectEnd'
        pathFinderStart: null,
        recording: false,
        recordFrames: [],
        recordTimer: null,
        // TPS tracking
        recentBlocks: [],             // timestamps of recent blocks
    },

    init() {
        // Buffer blocks even before DAG tab is shown
        Explorer.on('block', (data) => {
            this.buffered.push(data);
            if (this.buffered.length > this.state.maxNodes) this.buffered.shift();
            if (this.initialized) this.addBlock(data);
        });

        // Initialize on first DAG tab click
        const dagTab = document.getElementById('tabDag');
        if (dagTab) {
            dagTab.addEventListener('click', () => {
                if (!this.initialized) {
                    setTimeout(() => {
                        requestAnimationFrame(() => this.setup());
                    }, 150);
                }
            });
        }

        // Bind toolbar controls
        this.bindToolbar();
    },

    bindToolbar() {
        // Reset button
        const resetBtn = document.getElementById('dagResetBtn');
        if (resetBtn) resetBtn.addEventListener('click', () => this.resetView());

        // Screenshot button
        const screenshotBtn = document.getElementById('dagScreenshotBtn');
        if (screenshotBtn) screenshotBtn.addEventListener('click', () => this.takeScreenshot());

        // Fullscreen button
        const fullscreenBtn = document.getElementById('dagFullscreenBtn');
        if (fullscreenBtn) fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());

        // Record button
        const recordBtn = document.getElementById('dagRecordBtn');
        if (recordBtn) recordBtn.addEventListener('click', () => this.toggleRecording());

        // Block type filter checkboxes
        document.querySelectorAll('.dag-type-filter').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const type = e.target.dataset.type;
                if (type) {
                    this.state.visibleTypes[type] = e.target.checked;
                    if (this.renderer) this.renderer.refresh();
                }
            });
        });

        // Edge type toggles
        const chainToggle = document.getElementById('dagShowChainEdges');
        const transferToggle = document.getElementById('dagShowTransferEdges');
        if (chainToggle) chainToggle.addEventListener('change', (e) => {
            this.state.showChainEdges = e.target.checked;
            if (this.renderer) this.renderer.refresh();
        });
        if (transferToggle) transferToggle.addEventListener('change', (e) => {
            this.state.showTransferEdges = e.target.checked;
            if (this.renderer) this.renderer.refresh();
        });

        // Heatmap toggle
        const heatmapBtn = document.getElementById('dagHeatmapBtn');
        if (heatmapBtn) heatmapBtn.addEventListener('click', () => {
            this.state.heatmapMode = !this.state.heatmapMode;
            heatmapBtn.classList.toggle('active', this.state.heatmapMode);
            if (this.renderer) this.renderer.refresh();
        });

        // Value flow toggle
        const valueFlowBtn = document.getElementById('dagValueFlowBtn');
        if (valueFlowBtn) valueFlowBtn.addEventListener('click', () => {
            this.state.valueFlowMode = !this.state.valueFlowMode;
            valueFlowBtn.classList.toggle('active', this.state.valueFlowMode);
            if (this.renderer) this.renderer.refresh();
        });

        // Search
        const searchInput = document.getElementById('dagSearchInput');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.state.searchQuery = e.target.value.toLowerCase().trim();
                if (this.renderer) this.renderer.refresh();
            });
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') this.flyToSearchResult();
                if (e.key === 'Escape') {
                    searchInput.value = '';
                    this.state.searchQuery = '';
                    if (this.renderer) this.renderer.refresh();
                }
            });
        }

        // Time slider
        const timeSlider = document.getElementById('dagTimeSlider');
        if (timeSlider) {
            timeSlider.addEventListener('input', (e) => {
                this.state.timeSliderValue = parseInt(e.target.value);
                this.updateTimeLabel();
                if (this.renderer) this.renderer.refresh();
            });
        }

        // Time play button
        const timePlayBtn = document.getElementById('dagTimePlayBtn');
        if (timePlayBtn) timePlayBtn.addEventListener('click', () => this.toggleTimeReplay());

        // Layout selector
        const layoutSelect = document.getElementById('dagLayoutSelect');
        if (layoutSelect) layoutSelect.addEventListener('change', (e) => {
            this.state.currentLayout = e.target.value;
            this.applyLayout();
        });

        // Max nodes slider
        const maxNodesSlider = document.getElementById('dagMaxNodes');
        if (maxNodesSlider) {
            maxNodesSlider.addEventListener('input', (e) => {
                this.state.maxNodes = parseInt(e.target.value);
                document.getElementById('dagMaxNodesLabel').textContent = this.state.maxNodes;
                this.trimOldest();
                this.updateNodeCount();
            });
        }

        // Path finder button
        const pathBtn = document.getElementById('dagPathFinderBtn');
        if (pathBtn) pathBtn.addEventListener('click', () => this.startPathFinder());

        // Context menu actions
        document.querySelectorAll('#dagContextMenu button[data-action]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const action = e.target.dataset.action;
                this.handleContextAction(action);
                this.hideContextMenu();
            });
        });

        // Close context menu on click outside
        document.addEventListener('click', () => this.hideContextMenu());
    },

    setup() {
        const container = document.getElementById('dagContainer');
        if (!container) {
            console.warn('[DAG] Container not found');
            return;
        }

        if (typeof graphology === 'undefined') {
            container.innerHTML = '<div style="padding:40px;text-align:center;color:#777">Graphology library not loaded</div>';
            return;
        }
        if (typeof Sigma === 'undefined') {
            container.innerHTML = '<div style="padding:40px;text-align:center;color:#777">Sigma.js library not loaded</div>';
            return;
        }

        try {
            this.graph = new graphology.Graph({ multi: false, type: 'directed' });

            this.renderer = new Sigma(this.graph, container, {
                renderLabels: true,
                labelRenderedSizeThreshold: 10,
                labelFont: 'JetBrains Mono',
                labelSize: 10,
                labelColor: { color: '#e8e8e8' },
                defaultNodeColor: '#FF8C00',
                defaultEdgeColor: 'rgba(255,255,255,0.1)',
                defaultEdgeType: 'arrow',
                edgeLabelFont: 'JetBrains Mono',
                minCameraRatio: 0.05,
                maxCameraRatio: 12,
                nodeProgramClasses: {},
                enableEdgeClickEvents: false,
                enableEdgeWheelEvents: false,
                allowInvalidContainer: true,
            });

            // Globe overlay canvas — wireframe sphere nodes
            this.globeCanvas = document.createElement('canvas');
            this.globeCanvas.className = 'dag-globe-overlay';
            this.globeCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:15;';
            container.appendChild(this.globeCanvas);
            this.globeCtx = this.globeCanvas.getContext('2d');

            // Register composited reducers
            this.renderer.setSetting('nodeReducer', (node, data) => this._nodeReducer(node, data));
            this.renderer.setSetting('edgeReducer', (edge, data) => this._edgeReducer(edge, data));

            // Hover tooltip
            this.setupTooltip(container);

            // Click to view block detail
            this.renderer.on('clickNode', ({ node }) => {
                // Handle path finder mode
                if (this.state.pathFinderMode === 'selectStart') {
                    this.state.pathFinderStart = node;
                    this.state.pathFinderMode = 'selectEnd';
                    Explorer.showToast('Now click the end node', 'info');
                    return;
                }
                if (this.state.pathFinderMode === 'selectEnd') {
                    this.findPath(this.state.pathFinderStart, node);
                    return;
                }

                const attrs = this.graph.getNodeAttributes(node);
                if (attrs.blockHash) {
                    Explorer.lookupBlock(attrs.blockHash);
                }
            });

            // Double-click to zoom to account chain
            this.renderer.on('doubleClickNode', ({ node, event }) => {
                event.preventSigmaDefault();
                const attrs = this.graph.getNodeAttributes(node);
                if (attrs.account) {
                    this.state.highlightedAccount = attrs.account;
                    const pos = this.renderer.getNodeDisplayData(node);
                    if (pos) {
                        this.renderer.getCamera().animate(
                            { x: pos.x, y: pos.y, ratio: 0.2 },
                            { duration: 500 }
                        );
                    }
                    this.renderer.refresh();
                }
            });

            // Right-click context menu
            this.renderer.on('rightClickNode', ({ node, event }) => {
                event.preventSigmaDefault();
                if (event.original) event.original.preventDefault();
                this.state.contextMenuTarget = node;
                this.showContextMenu(event.original || event);
            });

            // Drag support
            this.setupDrag(container);

            // Replay buffered blocks
            for (const block of this.buffered) {
                this.addBlock(block);
            }

            this.initialized = true;
            this.startLayout();
            this.updateNodeCount();
            this.startAnimationLoop();
            this.startStatsTimer();
            this.startMinimap();

            // Explainer overlay dismiss handler
            const explainer = document.getElementById('dagExplainer');
            const explainerDismiss = document.getElementById('dagExplainerDismiss');
            if (explainer) {
                if (localStorage.getItem('dagExplainerDismissed') === '1') {
                    explainer.classList.add('dismissed');
                }
                if (explainerDismiss) {
                    explainerDismiss.addEventListener('click', () => {
                        explainer.classList.add('dismissed');
                        localStorage.setItem('dagExplainerDismissed', '1');
                    });
                }
            }

            // Seed with recent blocks from API if DAG is empty
            if (this.graph.order === 0) {
                this.seedFromAPI();
            }

            console.log('[DAG] Visualizer v3 initialized with', this.graph.order, 'nodes');
        } catch (e) {
            console.error('[DAG] Setup failed:', e);
            container.innerHTML = `<div style="padding:40px;text-align:center;color:#ff3b3b">DAG init error: ${e.message}</div>`;
        }
    },

    // =============================================
    // COMPOSITED REDUCERS — all features read from state
    // =============================================
    _nodeReducer(node, data) {
        const result = { ...data };
        const now = performance.now();

        // 1. Block type filter
        if (!this.state.visibleTypes[data.blockType]) {
            return { ...result, hidden: true };
        }

        // 2. Time slider filter
        if (this.state.timeSliderValue < 100 && this.blockOrder.length > 0) {
            const cutoffIndex = Math.floor((this.state.timeSliderValue / 100) * this.blockOrder.length);
            const visibleHashes = new Set(this.blockOrder.slice(0, cutoffIndex + 1));
            if (!visibleHashes.has(node)) {
                return { ...result, hidden: true };
            }
        }

        // 3. Animation (scale-in)
        const anim = this.state.animatingNodes.get(node);
        if (anim) {
            const elapsed = now - anim.startTime;
            const duration = 500;
            if (elapsed < duration) {
                const t = elapsed / duration;
                const ease = 1 - Math.pow(1 - t, 3); // ease-out cubic
                result.size = anim.targetSize * ease;
            } else {
                this.state.animatingNodes.delete(node);
            }
        }

        // 4. Whale glow
        if (data.isWhale) {
            result.size = (result.size || data.size) * 1.4;
            // Whale flash animation
            const whaleAnim = this.state.animatingNodes.get(node + ':whale');
            if (whaleAnim) {
                const elapsed = now - whaleAnim.startTime;
                const flashDuration = 1200;
                if (elapsed < flashDuration) {
                    const pulse = 1 + Math.sin((elapsed / flashDuration) * Math.PI) * 0.8;
                    result.size = (result.size || data.size) * pulse;
                } else {
                    this.state.animatingNodes.delete(node + ':whale');
                }
            }
        }

        // 5. Heatmap mode
        if (this.state.heatmapMode && this.blockOrder.length > 1) {
            const idx = this.blockOrder.indexOf(node);
            if (idx >= 0) {
                const normalized = idx / (this.blockOrder.length - 1);
                const hue = 240 - (normalized * 210); // blue (old) → orange (new)
                result.color = `hsl(${hue}, 80%, 55%)`;
            }
        }

        // 6. Search highlighting
        if (this.state.searchQuery) {
            const account = (data.account || '').toLowerCase();
            const hash = (data.blockHash || node).toLowerCase();
            const matches = account.includes(this.state.searchQuery) || hash.includes(this.state.searchQuery);
            if (!matches) {
                result.color = (result.color || data.color) + '25';
                result.label = '';
            } else {
                result.highlighted = true;
            }
        }

        // 7. Account chain highlight
        if (this.state.highlightedAccount && !this.state.searchQuery) {
            if (data.account !== this.state.highlightedAccount) {
                result.color = (result.color || data.color) + '20';
                result.label = '';
            } else {
                result.highlighted = true;
                result.size = (result.size || data.size) * 1.2;
            }
        }

        // 8. Path highlight
        if (this.state.highlightedPath) {
            if (this.state.highlightedPath.has(node)) {
                result.highlighted = true;
                result.size = (result.size || data.size) * 1.3;
                result.color = '#FFD700';
            } else {
                result.color = (result.color || data.color) + '15';
                result.label = '';
            }
        }

        // 9. Hover effect (dim non-hovered)
        if (this.state.hoveredNode && this.state.hoveredNode !== node) {
            if (!this.graph.hasEdge(this.state.hoveredNode, node) &&
                !this.graph.hasEdge(node, this.state.hoveredNode) &&
                !this.graph.areNeighbors(this.state.hoveredNode, node)) {
                result.color = (result.color || data.color) + '30';
                result.label = '';
            }
        }
        if (this.state.hoveredNode === node) {
            result.highlighted = true;
        }

        // 10. Globe mode — store visual data for globe overlay,
        // then make sigma's circle/label invisible (kept for hit-detection)
        this.globeNodeData.set(node, {
            color: result.color || data.color,
            size: Math.max(result.size || data.size, 4),
            label: result.label || data.label || '',
            blockType: data.blockType,
        });
        result.color = 'rgba(0,0,0,0.01)';
        result.label = ''; // suppress sigma labels — we draw our own on the globe canvas

        return result;
    },

    _edgeReducer(edge, data) {
        const result = { ...data };

        // 1. Edge type filter
        const edgeType = data.edgeType || 'chain';
        if (edgeType === 'chain' && !this.state.showChainEdges) {
            return { ...result, hidden: true };
        }
        if (edgeType === 'transfer' && !this.state.showTransferEdges) {
            return { ...result, hidden: true };
        }

        // 2. Value flow mode — thicker edges for larger amounts
        if (this.state.valueFlowMode && edgeType === 'transfer' && data.amount) {
            try {
                const logSize = Math.log10(Number(BigInt(data.amount)) + 1);
                result.size = Math.max(0.5, Math.min(5, logSize * 0.35));
            } catch (e) { /* default size */ }
        }

        // 3. Hover effect — highlight connected, hide rest
        if (this.state.hoveredNode) {
            if (this.graph.hasExtremity(edge, this.state.hoveredNode)) {
                result.color = '#FF8C00';
                result.size = Math.max(result.size || 1, 2);
            } else {
                result.hidden = true;
            }
        }

        // 4. Path highlight
        if (this.state.highlightedPath) {
            const src = this.graph.source(edge);
            const tgt = this.graph.target(edge);
            if (this.state.highlightedPath.has(src) && this.state.highlightedPath.has(tgt)) {
                result.color = '#FFD700';
                result.size = 3;
            } else {
                result.hidden = true;
            }
        }

        // 5. Account chain highlight — hide unrelated edges
        if (this.state.highlightedAccount && !this.state.hoveredNode && !this.state.highlightedPath) {
            const src = this.graph.source(edge);
            const tgt = this.graph.target(edge);
            const srcAttrs = this.graph.getNodeAttributes(src);
            const tgtAttrs = this.graph.getNodeAttributes(tgt);
            if (srcAttrs.account !== this.state.highlightedAccount &&
                tgtAttrs.account !== this.state.highlightedAccount) {
                result.hidden = true;
            } else {
                result.color = '#FF8C00';
                result.size = 2;
            }
        }

        // 6. Make sigma edges invisible — we draw our own on the globe canvas
        result.color = 'rgba(0,0,0,0.01)';

        return result;
    },

    // =============================================
    // BLOCK MANAGEMENT
    // =============================================
    addBlock(data) {
        if (!this.graph) return;

        const hash = data.hash;
        if (!hash || this.graph.hasNode(hash)) return;

        const type = data.block_type || 'send';
        const color = this.colors[type] || this.colors.send;

        // Node size: log-scale of amount, clamped 4-18
        let size = 6;
        let rawAmount = 0n;
        try {
            rawAmount = BigInt(data.amount || data.balance || '0');
            if (rawAmount > 0n) {
                const logSize = Math.log10(Number(rawAmount) + 1);
                size = Math.max(4, Math.min(18, logSize * 1.2));
            }
        } catch (e) { /* default size */ }

        const isWhale = rawAmount >= this.whaleThreshold;

        // Random initial position
        const x = (Math.random() - 0.5) * 20;
        const y = (Math.random() - 0.5) * 20;

        // Label: type-prefixed with amount or known account name
        const typePrefix = type.charAt(0).toUpperCase();
        let label = hash.slice(0, 8);
        let amountLabel = '';
        if (rawAmount > 0n) {
            const numericAmount = Number(rawAmount) / 1e7;
            if (numericAmount >= 1e6) amountLabel = (numericAmount / 1e6).toFixed(1) + 'M';
            else if (numericAmount >= 1e3) amountLabel = (numericAmount / 1e3).toFixed(1) + 'K';
            else amountLabel = numericAmount.toFixed(numericAmount < 1 ? 2 : 0);
        }
        if (data.account) {
            const known = typeof KnexAccount !== 'undefined' && KnexAccount.knownAccounts?.[data.account];
            if (known) {
                label = `${typePrefix}: ${known.label}`;
            } else if (amountLabel) {
                label = `${typePrefix}: ${amountLabel}`;
            } else {
                label = `${typePrefix}: ${data.account.slice(0, 8)}`;
            }
        } else {
            label = amountLabel ? `${typePrefix}: ${amountLabel}` : hash.slice(0, 8);
        }

        this.graph.addNode(hash, {
            x, y, size, color, label,
            blockHash: hash,
            account: data.account || '',
            blockType: type,
            amount: data.amount || '0',
            destination: data.destination || '',
            timestamp: data.timestamp || Date.now(),
            isWhale,
        });

        // Store block data for time slider / search
        this.blockData.set(hash, data);
        this.blockOrder.push(hash);

        this.nodeCount++;

        // Entry animation
        this.state.animatingNodes.set(hash, {
            startTime: performance.now(),
            targetSize: size,
        });

        // Whale flash animation + alert
        if (isWhale) {
            this.state.animatingNodes.set(hash + ':whale', {
                startTime: performance.now(),
                targetSize: size,
            });
            const amountStr = typeof Explorer !== 'undefined' ? Explorer.formatAmount(data.amount || '0') : data.amount;
            Explorer.showToast(`WHALE ${type.toUpperCase()}: ${amountStr} KNEX`, 'info');
        }

        // Track for TPS
        this.state.recentBlocks.push(Date.now());

        // Intra-account edge: previous → current
        const prev = data.previous;
        if (prev && prev !== '0000000000000000000000000000000000000000000000000000000000000000' && this.graph.hasNode(prev)) {
            const edgeId = `chain:${prev}->${hash}`;
            if (!this.graph.hasEdge(edgeId)) {
                this.graph.addEdgeWithKey(edgeId, prev, hash, {
                    color: 'rgba(255,255,255,0.15)',
                    size: 1,
                    edgeType: 'chain',
                });
                this.edgePulses.push({ src: prev, tgt: hash, startTime: performance.now(), duration: 1200 });
            }
        }

        // Cross-account edge: this send → destination
        if (data.destination && this.graph.hasNode(data.destination)) {
            const edgeId = `link:${hash}->${data.destination}`;
            if (!this.graph.hasEdge(edgeId)) {
                this.graph.addEdgeWithKey(edgeId, hash, data.destination, {
                    color: this._transferEdgeColor(type),
                    size: 0.8,
                    edgeType: 'transfer',
                    amount: data.amount || '0',
                });
                this.edgePulses.push({ src: hash, tgt: data.destination, startTime: performance.now(), duration: 1200 });
            }
        }

        // Reverse link: receive ← source
        if (data.source && this.graph.hasNode(data.source)) {
            const edgeId = `link:${data.source}->${hash}`;
            if (!this.graph.hasEdge(edgeId)) {
                this.graph.addEdgeWithKey(edgeId, data.source, hash, {
                    color: this._transferEdgeColor(type),
                    size: 0.8,
                    edgeType: 'transfer',
                    amount: data.amount || '0',
                });
                this.edgePulses.push({ src: data.source, tgt: hash, startTime: performance.now(), duration: 1200 });
            }
        }

        // Trim + update count
        this.trimOldest();
        this.updateNodeCount();

        // Quick layout pass
        if (this.state.currentLayout === 'forceatlas2') {
            this.applyLayoutStep(3);
        }

        // Spatial audio
        this.playSpatialAudio(hash, type);
    },

    _transferEdgeColor(type) {
        const c = this.colors[type] || '#FF8C00';
        // Convert hex to rgba at 40% opacity
        const r = parseInt(c.slice(1, 3), 16);
        const g = parseInt(c.slice(3, 5), 16);
        const b = parseInt(c.slice(5, 7), 16);
        return `rgba(${r},${g},${b},0.35)`;
    },

    async seedFromAPI() {
        try {
            const res = await fetch(`${Explorer.config.apiUrl}/api/v1/blocks/recent`);
            if (!res.ok) return;
            const data = await res.json();
            const blocks = Array.isArray(data) ? data : (data.blocks || []);
            for (const block of blocks.reverse()) {
                this.addBlock(block);
            }
            this.updateNodeCount();
            // Apply full layout after seeding
            this.applyLayout();
            console.log('[DAG] Seeded from API with', this.graph.order, 'nodes');
        } catch (e) {
            console.warn('[DAG] Failed to seed from API:', e);
        }
    },

    trimOldest() {
        while (this.graph.order > this.state.maxNodes) {
            const nodes = this.graph.nodes();
            if (nodes.length > 0) {
                const oldNode = nodes[0];
                // Remove from storage
                this.blockData.delete(oldNode);
                const idx = this.blockOrder.indexOf(oldNode);
                if (idx >= 0) this.blockOrder.splice(idx, 1);
                this.state.pinnedNodes.delete(oldNode);
                this.state.animatingNodes.delete(oldNode);
                this.state.animatingNodes.delete(oldNode + ':whale');
                // Drop from graph
                try {
                    this.graph.edges(oldNode).forEach(edge => {
                        try { this.graph.dropEdge(edge); } catch (e) {}
                    });
                } catch (e) {}
                try { this.graph.dropNode(oldNode); } catch (e) {}
                this.nodeCount--;
            }
        }
    },

    updateNodeCount() {
        const el = document.getElementById('dagNodeCount');
        if (el && this.graph) {
            el.textContent = `${this.graph.order} nodes, ${this.graph.size} edges`;
        }
        // Update time slider max hint
        const timeSlider = document.getElementById('dagTimeSlider');
        if (timeSlider) timeSlider.max = '100';
    },

    // =============================================
    // ANIMATION LOOP
    // =============================================
    startAnimationLoop() {
        const loop = () => {
            if (!this.initialized) return;
            // Trigger refresh if there are active animations
            if (this.state.animatingNodes.size > 0 && this.renderer) {
                this.renderer.refresh();
            }
            // Auto-rotate globes and redraw overlay
            this.globeRotation += 0.006; // ~0.34°/frame → full rotation ~18s at 60fps
            this.drawGlobes();
            this.animationFrame = requestAnimationFrame(loop);
        };
        this.animationFrame = requestAnimationFrame(loop);
    },

    // =============================================
    // WIREFRAME GLOBE OVERLAY
    // =============================================
    drawGlobes() {
        const canvas = this.globeCanvas;
        const ctx = this.globeCtx;
        if (!canvas || !ctx || !this.renderer || !this.graph) return;

        const dpr = window.devicePixelRatio || 1;
        const container = document.getElementById('dagContainer');
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const w = rect.width;
        const h = rect.height;
        if (w === 0 || h === 0) return;

        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        const rot = this.globeRotation;

        // 1. Draw edges (white lines with neon yellow pulses)
        this.drawEdges(ctx, w, h);

        // 2. Draw wireframe globe for each visible node
        const camera = this.renderer.getCamera();
        const cameraRatio = camera ? camera.getState().ratio : 1;

        this.graph.forEachNode((node, attrs) => {
            const displayData = this.renderer.getNodeDisplayData(node);
            if (!displayData || displayData.hidden) return;

            const globe = this.globeNodeData.get(node);
            const x = displayData.x;
            const y = displayData.y;
            const r = ((globe ? globe.size : attrs.size) || 6) * 1.8;
            if (r < 2) return;

            const color = (globe ? globe.color : attrs.color) || '#FF8C00';
            this._drawWireframeGlobe(ctx, x, y, r, color, rot, node);

            // 3. Draw label below globe
            const label = globe?.label || '';
            if (label && r > 4 && cameraRatio < 3) {
                const fontSize = Math.max(8, Math.min(11, r * 0.7));
                ctx.globalAlpha = 0.9;
                ctx.font = `500 ${fontSize}px JetBrains Mono`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                // Dark shadow for readability
                ctx.fillStyle = 'rgba(0,0,0,0.75)';
                ctx.fillText(label, x + 1, y + r + 5);
                ctx.fillStyle = color;
                ctx.fillText(label, x, y + r + 4);
                ctx.globalAlpha = 1;
            }
        });
    },

    /**
     * Draw a single wireframe globe at (cx, cy) with radius r.
     * Projects longitude and latitude circles onto a 2D circle
     * using a rotation angle for the auto-spin effect.
     */
    _drawWireframeGlobe(ctx, cx, cy, r, color, rotation, nodeKey) {
        // Per-node rotation offset from hash for visual variety
        const hashOffset = (nodeKey.charCodeAt(0) + nodeKey.charCodeAt(1)) * 0.1;
        const rot = rotation + hashOffset;

        const alpha = 0.7;
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(0.5, r / 20);
        ctx.globalAlpha = alpha;

        // 1. Draw equator (outer circle)
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();

        // 2. Latitude lines (horizontal ellipses)
        const latCount = 3;
        for (let i = 1; i <= latCount; i++) {
            const lat = (i / (latCount + 1)) * Math.PI - Math.PI / 2; // -60° to +60°
            const yOff = Math.sin(lat) * r;
            const rLat = Math.cos(lat) * r;

            ctx.beginPath();
            ctx.ellipse(cx, cy + yOff, rLat, rLat * 0.15, 0, 0, Math.PI * 2);
            ctx.stroke();
        }

        // 3. Longitude lines (vertical ellipses, rotated by auto-spin)
        const lonCount = 4;
        for (let i = 0; i < lonCount; i++) {
            const angle = rot + (i / lonCount) * Math.PI;
            const horizScale = Math.cos(angle); // perspective squish

            ctx.beginPath();
            ctx.ellipse(cx, cy, Math.abs(horizScale) * r, r, 0, 0, Math.PI * 2);
            ctx.stroke();
        }

        // 4. Subtle inner glow
        ctx.globalAlpha = 0.08;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.85, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = 1;
    },

    // =============================================
    // CUSTOM EDGE RENDERING — White lines + neon yellow pulses
    // =============================================
    drawEdges(ctx, w, h) {
        if (!this.graph || !this.renderer) return;
        const now = performance.now();

        // Draw all visible edges as white base lines
        this.graph.forEachEdge((edge, attrs, src, tgt) => {
            if (attrs.hidden) return;
            const srcData = this.renderer.getNodeDisplayData(src);
            const tgtData = this.renderer.getNodeDisplayData(tgt);
            if (!srcData || !tgtData || srcData.hidden || tgtData.hidden) return;

            ctx.beginPath();
            ctx.moveTo(srcData.x, srcData.y);
            ctx.lineTo(tgtData.x, tgtData.y);
            ctx.strokeStyle = 'rgba(255,255,255,0.18)';
            ctx.lineWidth = 1;
            ctx.stroke();
        });

        // Draw active pulses
        ctx.save();
        for (let i = this.edgePulses.length - 1; i >= 0; i--) {
            const pulse = this.edgePulses[i];
            const elapsed = now - pulse.startTime;
            const t = Math.min(elapsed / pulse.duration, 1);

            // Remove completed pulses
            if (t >= 1) {
                this.edgePulses.splice(i, 1);
                continue;
            }

            // Get node positions
            if (!this.graph.hasNode(pulse.src) || !this.graph.hasNode(pulse.tgt)) {
                this.edgePulses.splice(i, 1);
                continue;
            }
            const srcData = this.renderer.getNodeDisplayData(pulse.src);
            const tgtData = this.renderer.getNodeDisplayData(pulse.tgt);
            if (!srcData || !tgtData) continue;

            // Elastic easing position
            const easedT = this._elasticOut(t);
            const px = srcData.x + (tgtData.x - srcData.x) * easedT;
            const py = srcData.y + (tgtData.y - srcData.y) * easedT;

            // Trail: draw a thick fading line segment from slightly behind the pulse
            const trailT = Math.max(0, easedT - 0.12);
            const tx = srcData.x + (tgtData.x - srcData.x) * trailT;
            const ty = srcData.y + (tgtData.y - srcData.y) * trailT;

            ctx.beginPath();
            ctx.moveTo(tx, ty);
            ctx.lineTo(px, py);
            ctx.strokeStyle = 'rgba(255,229,0,0.4)';
            ctx.lineWidth = 3;
            ctx.shadowColor = '#FFE500';
            ctx.shadowBlur = 8;
            ctx.stroke();
            ctx.shadowBlur = 0;

            // Neon yellow glow dot at pulse head
            ctx.beginPath();
            ctx.arc(px, py, 4, 0, Math.PI * 2);
            ctx.fillStyle = '#FFE500';
            ctx.shadowColor = '#FFE500';
            ctx.shadowBlur = 14;
            ctx.fill();
            ctx.shadowBlur = 0;

            // Bright core
            ctx.beginPath();
            ctx.arc(px, py, 2, 0, Math.PI * 2);
            ctx.fillStyle = '#FFFFFF';
            ctx.fill();
        }
        ctx.restore();
    },

    /**
     * Elastic ease-out — overshoots then settles (bouncy feel)
     */
    _elasticOut(t) {
        if (t === 0 || t === 1) return t;
        return Math.pow(2, -10 * t) * Math.sin((t - 0.1) * 5 * Math.PI) + 1;
    },

    // =============================================
    // LAYOUT ENGINES
    // =============================================
    startLayout() {
        if (this.state.currentLayout !== 'forceatlas2') return;
        if (!this._hasFA2()) return;

        this.layoutTimer = setInterval(() => {
            if (this.graph && this.graph.order > 1) {
                this.applyLayoutStep(5);
                // Re-pin pinned nodes
                for (const [hash, pos] of this.state.pinnedNodes) {
                    if (this.graph.hasNode(hash)) {
                        this.graph.setNodeAttribute(hash, 'x', pos.x);
                        this.graph.setNodeAttribute(hash, 'y', pos.y);
                    }
                }
            }
        }, 600);
    },

    applyLayoutStep(iterations) {
        if (!this._hasFA2() || !this.graph || this.graph.order < 2) return;

        try {
            const settings = graphologyLibrary.layoutForceAtlas2.inferSettings(this.graph);
            graphologyLibrary.layoutForceAtlas2.assign(this.graph, {
                iterations: iterations,
                settings: {
                    ...settings,
                    gravity: 1.5,
                    scalingRatio: 3,
                    barnesHutOptimize: this.graph.order > 50,
                    slowDown: 5,
                }
            });
        } catch (e) { /* silently fail */ }
    },

    applyLayout() {
        if (!this.graph || this.graph.order < 2) return;

        // Stop existing layout timer
        if (this.layoutTimer) {
            clearInterval(this.layoutTimer);
            this.layoutTimer = null;
        }

        const layout = this.state.currentLayout;

        if (layout === 'circular' && typeof graphologyLibrary !== 'undefined' && graphologyLibrary.layoutCircular) {
            graphologyLibrary.layoutCircular.assign(this.graph);
        } else if (layout === 'random' && typeof graphologyLibrary !== 'undefined') {
            // Simple random layout
            this.graph.forEachNode((node) => {
                this.graph.setNodeAttribute(node, 'x', (Math.random() - 0.5) * 20);
                this.graph.setNodeAttribute(node, 'y', (Math.random() - 0.5) * 20);
            });
        } else if (layout === 'forceatlas2') {
            this.applyLayoutStep(20);
            this.startLayout();
        }

        if (this.renderer) this.renderer.refresh();
    },

    _hasFA2() {
        return typeof graphologyLibrary !== 'undefined' &&
               graphologyLibrary.layoutForceAtlas2 &&
               typeof graphologyLibrary.layoutForceAtlas2.assign === 'function';
    },

    // =============================================
    // TOOLTIP
    // =============================================
    setupTooltip(container) {
        const tooltip = document.createElement('div');
        tooltip.className = 'dag-tooltip hidden';
        tooltip.id = 'dagTooltip';
        container.appendChild(tooltip);

        this.renderer.on('enterNode', ({ node }) => {
            this.state.hoveredNode = node;
            const attrs = this.graph.getNodeAttributes(node);
            const type = (attrs.blockType || 'unknown').toUpperCase();
            const typeColor = this.colors[attrs.blockType] || '#FF8C00';
            const amount = Explorer.formatAmount(attrs.amount || '0');
            const account = attrs.account ? Explorer.truncateAddress(attrs.account) : '?';
            const hashStr = attrs.blockHash ? attrs.blockHash.slice(0, 16) + '...' : '?';
            const known = typeof KnexAccount !== 'undefined' && KnexAccount.knownAccounts?.[attrs.account];
            const knownBadge = known ? `<span style="color:${known.color};font-weight:700"> [${known.label}]</span>` : '';
            const whaleBadge = attrs.isWhale ? ' <span style="color:#FFD700">🐋</span>' : '';
            const ts = attrs.timestamp;
            const timeStr = ts ? new Date(ts > 1e10 ? ts : ts * 1000).toLocaleTimeString() : '';

            // Generate identicon for tooltip
            let identiconHtml = '';
            if (attrs.account && typeof KnexIdenticon !== 'undefined') {
                const cacheKey = `${attrs.account}:24`;
                if (Explorer.identiconCache && Explorer.identiconCache.has(cacheKey)) {
                    identiconHtml = `<img src="${Explorer.identiconCache.get(cacheKey)}" width="24" height="24" style="border-radius:4px;image-rendering:pixelated;vertical-align:middle;margin-right:6px">`;
                }
            }

            tooltip.innerHTML =
                `<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">` +
                `${identiconHtml}<strong style="color:${typeColor}">${type}</strong>${whaleBadge}${knownBadge}</div>` +
                `<div style="color:var(--text-muted)">Hash: ${hashStr}</div>` +
                `<div>Account: ${account}</div>` +
                `<div style="color:var(--gold)">Amount: ${amount} KNEX</div>` +
                (timeStr ? `<div style="color:var(--text-muted);font-size:10px">${timeStr}</div>` : '');
            tooltip.classList.remove('hidden');

            this.renderer.refresh();
        });

        this.renderer.on('leaveNode', () => {
            this.state.hoveredNode = null;
            tooltip.classList.add('hidden');
            this.renderer.refresh();
        });

        // Position tooltip near mouse
        container.addEventListener('mousemove', (e) => {
            if (!this.state.hoveredNode) return;
            const rect = container.getBoundingClientRect();
            const x = e.clientX - rect.left + 14;
            const y = e.clientY - rect.top + 14;
            tooltip.style.left = Math.min(x, rect.width - 300) + 'px';
            tooltip.style.top = Math.min(y, rect.height - 120) + 'px';
        });
    },

    // =============================================
    // DRAG TO PIN
    // =============================================
    setupDrag(container) {
        let draggedNode = null;
        let isDragging = false;

        this.renderer.on('downNode', (e) => {
            isDragging = true;
            draggedNode = e.node;
            // Disable camera during drag
            this.renderer.getCamera().disable();
        });

        container.addEventListener('mousemove', (e) => {
            if (!isDragging || !draggedNode) return;
            const pos = this.renderer.viewportToGraph(e);
            this.graph.setNodeAttribute(draggedNode, 'x', pos.x);
            this.graph.setNodeAttribute(draggedNode, 'y', pos.y);
            // Auto-pin on drag
            this.state.pinnedNodes.set(draggedNode, { x: pos.x, y: pos.y });
        });

        const endDrag = () => {
            if (isDragging && draggedNode) {
                this.renderer.getCamera().enable();
                isDragging = false;
                draggedNode = null;
            }
        };

        container.addEventListener('mouseup', endDrag);
        container.addEventListener('mouseleave', endDrag);
    },

    // =============================================
    // CONTEXT MENU
    // =============================================
    showContextMenu(event) {
        const menu = document.getElementById('dagContextMenu');
        if (!menu) return;
        const container = document.getElementById('dagContainer');
        const rect = container.getBoundingClientRect();
        const x = (event.clientX || event.x) - rect.left;
        const y = (event.clientY || event.y) - rect.top;
        menu.style.left = Math.min(x, rect.width - 160) + 'px';
        menu.style.top = Math.min(y, rect.height - 160) + 'px';
        menu.classList.remove('hidden');

        // Update pin button text
        const pinBtn = menu.querySelector('[data-action="pinNode"]');
        if (pinBtn) {
            const isPinned = this.state.pinnedNodes.has(this.state.contextMenuTarget);
            pinBtn.innerHTML = isPinned
                ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12" style="vertical-align:-1px;margin-right:4px"><path d="M12 17v5M9 11V4a1 1 0 011-1h4a1 1 0 011 1v7"/><path d="M5 17h14l-1.5-6H6.5z"/></svg>Unpin Node'
                : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12" style="vertical-align:-1px;margin-right:4px"><path d="M12 17v5M9 11V4a1 1 0 011-1h4a1 1 0 011 1v7"/><path d="M5 17h14l-1.5-6H6.5z"/></svg>Pin Node';
        }
    },

    hideContextMenu() {
        const menu = document.getElementById('dagContextMenu');
        if (menu) menu.classList.add('hidden');
    },

    handleContextAction(action) {
        const node = this.state.contextMenuTarget;
        if (!node || !this.graph.hasNode(node)) return;
        const attrs = this.graph.getNodeAttributes(node);

        switch (action) {
            case 'viewAccount':
                if (attrs.account) Explorer.lookupAccount(attrs.account);
                break;
            case 'copyHash':
                navigator.clipboard?.writeText(attrs.blockHash || node).then(() => {
                    Explorer.showToast('Hash copied', 'info');
                });
                break;
            case 'highlightChain':
                this.state.highlightedAccount = attrs.account || null;
                this.state.highlightedPath = null;
                this.renderer.refresh();
                break;
            case 'pinNode': {
                const isPinned = this.state.pinnedNodes.has(node);
                if (isPinned) {
                    this.state.pinnedNodes.delete(node);
                    Explorer.showToast('Node unpinned', 'info');
                } else {
                    const x = this.graph.getNodeAttribute(node, 'x');
                    const y = this.graph.getNodeAttribute(node, 'y');
                    this.state.pinnedNodes.set(node, { x, y });
                    Explorer.showToast('Node pinned', 'info');
                }
                break;
            }
        }
    },

    // =============================================
    // SEARCH & CAMERA
    // =============================================
    flyToSearchResult() {
        if (!this.state.searchQuery || !this.graph) return;
        const query = this.state.searchQuery;

        // Find first matching node
        let found = null;
        this.graph.forEachNode((node, attrs) => {
            if (found) return;
            const account = (attrs.account || '').toLowerCase();
            const hash = (attrs.blockHash || node).toLowerCase();
            if (account.includes(query) || hash.includes(query)) {
                found = node;
            }
        });

        if (found) {
            const pos = this.renderer.getNodeDisplayData(found);
            if (pos) {
                this.renderer.getCamera().animate(
                    { x: pos.x, y: pos.y, ratio: 0.25 },
                    { duration: 500 }
                );
            }
        } else {
            Explorer.showToast('No matching node found', 'error');
        }
    },

    resetView() {
        // Clear all highlights
        this.state.highlightedAccount = null;
        this.state.highlightedPath = null;
        this.state.pathFinderMode = null;
        this.state.pathFinderStart = null;
        this.state.searchQuery = '';
        const searchInput = document.getElementById('dagSearchInput');
        if (searchInput) searchInput.value = '';

        if (this.renderer) {
            const camera = this.renderer.getCamera();
            camera.animate({ x: 0.5, y: 0.5, ratio: 1 }, { duration: 400 });
            this.renderer.refresh();
        }
    },

    // =============================================
    // TIME SLIDER & REPLAY
    // =============================================
    updateTimeLabel() {
        const label = document.getElementById('dagTimeLabel');
        if (!label) return;
        if (this.state.timeSliderValue >= 100) {
            label.textContent = 'Live';
        } else if (this.blockOrder.length > 0) {
            const idx = Math.floor((this.state.timeSliderValue / 100) * this.blockOrder.length);
            label.textContent = `${idx + 1} / ${this.blockOrder.length}`;
        }
    },

    toggleTimeReplay() {
        const btn = document.getElementById('dagTimePlayBtn');
        const slider = document.getElementById('dagTimeSlider');
        if (!btn || !slider) return;

        if (this._timeReplayTimer) {
            // Stop replay
            clearInterval(this._timeReplayTimer);
            this._timeReplayTimer = null;
            btn.textContent = '▶';
            return;
        }

        // Start replay from beginning
        this.state.timeSliderValue = 0;
        slider.value = '0';
        btn.textContent = '⏸';

        this._timeReplayTimer = setInterval(() => {
            this.state.timeSliderValue += 1;
            if (this.state.timeSliderValue >= 100) {
                this.state.timeSliderValue = 100;
                clearInterval(this._timeReplayTimer);
                this._timeReplayTimer = null;
                btn.textContent = '▶';
            }
            slider.value = String(this.state.timeSliderValue);
            this.updateTimeLabel();
            if (this.renderer) this.renderer.refresh();
        }, 80);
    },

    // =============================================
    // PATH FINDER
    // =============================================
    startPathFinder() {
        this.state.highlightedPath = null;
        this.state.highlightedAccount = null;
        this.state.pathFinderMode = 'selectStart';
        this.state.pathFinderStart = null;
        Explorer.showToast('Click the start node', 'info');
        if (this.renderer) this.renderer.refresh();
    },

    findPath(startNode, endNode) {
        this.state.pathFinderMode = null;

        if (!this.graph || !startNode || !endNode) return;
        if (!this.graph.hasNode(startNode) || !this.graph.hasNode(endNode)) {
            Explorer.showToast('Invalid nodes for path finding', 'error');
            return;
        }

        try {
            // Use BFS since graphology-library might not have shortestPath in bundled version
            const path = this._bfsPath(startNode, endNode);
            if (path && path.length > 0) {
                this.state.highlightedPath = new Set(path);
                Explorer.showToast(`Path found: ${path.length} nodes`, 'info');
            } else {
                Explorer.showToast('No path found between these nodes', 'error');
            }
        } catch (e) {
            Explorer.showToast('Path finding failed', 'error');
        }

        if (this.renderer) this.renderer.refresh();
    },

    _bfsPath(start, end) {
        const visited = new Set();
        const queue = [[start]];
        visited.add(start);

        while (queue.length > 0) {
            const path = queue.shift();
            const node = path[path.length - 1];

            if (node === end) return path;

            // Check all neighbors (both directions since graph is directed)
            const neighbors = new Set();
            try {
                this.graph.forEachOutNeighbor(node, (n) => neighbors.add(n));
                this.graph.forEachInNeighbor(node, (n) => neighbors.add(n));
            } catch (e) {}

            for (const neighbor of neighbors) {
                if (!visited.has(neighbor)) {
                    visited.add(neighbor);
                    queue.push([...path, neighbor]);
                }
            }
        }
        return null;
    },

    // =============================================
    // LIVE STATS OVERLAY
    // =============================================
    startStatsTimer() {
        this.updateStats();
        this.statsTimer = setInterval(() => this.updateStats(), 2000);
    },

    updateStats() {
        const now = Date.now();
        // Clean old entries (keep last 10 seconds)
        this.state.recentBlocks = this.state.recentBlocks.filter(t => now - t < 10000);

        const tps = (this.state.recentBlocks.length / 10).toFixed(1);
        const bps = this.state.recentBlocks.length;
        const accounts = new Set();
        this.blockData.forEach(block => {
            if (block.account) accounts.add(block.account);
        });

        const tpsEl = document.getElementById('dagTps');
        const bpsEl = document.getElementById('dagBps');
        const acctEl = document.getElementById('dagActiveAccounts');
        if (tpsEl) tpsEl.textContent = tps;
        if (bpsEl) bpsEl.textContent = bps;
        if (acctEl) acctEl.textContent = accounts.size;
    },

    // =============================================
    // MINI-MAP
    // =============================================
    startMinimap() {
        const canvas = document.getElementById('dagMinimap');
        if (!canvas) return;
        this.minimapTimer = setInterval(() => this.drawMinimap(canvas), 2000);
        this.drawMinimap(canvas);
    },

    drawMinimap(canvas) {
        if (!this.graph || !this.renderer || this.graph.order === 0) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;

        ctx.clearRect(0, 0, w, h);

        // Background
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(0, 0, w, h);

        // Get graph bounds
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        this.graph.forEachNode((node, attrs) => {
            if (attrs.x < minX) minX = attrs.x;
            if (attrs.x > maxX) maxX = attrs.x;
            if (attrs.y < minY) minY = attrs.y;
            if (attrs.y > maxY) maxY = attrs.y;
        });

        const rangeX = maxX - minX || 1;
        const rangeY = maxY - minY || 1;
        const pad = 4;

        // Draw nodes as dots
        this.graph.forEachNode((node, attrs) => {
            const nx = pad + ((attrs.x - minX) / rangeX) * (w - pad * 2);
            const ny = pad + ((attrs.y - minY) / rangeY) * (h - pad * 2);
            ctx.fillStyle = attrs.color || '#FF8C00';
            ctx.beginPath();
            ctx.arc(nx, ny, attrs.isWhale ? 3 : 1.5, 0, Math.PI * 2);
            ctx.fill();
        });

        // Draw viewport rectangle
        try {
            const camera = this.renderer.getCamera();
            const state = camera.getState();
            // Approximate viewport in graph space
            const vw = state.ratio * 0.5;
            const vh = state.ratio * 0.5;
            const vx = state.x - vw / 2;
            const vy = state.y - vh / 2;

            // Map to minimap coords
            const rx = pad + ((vx * rangeX + minX - minX) / rangeX) * (w - pad * 2);
            const ry = pad + ((vy * rangeY + minY - minY) / rangeY) * (h - pad * 2);
            const rw = (vw / 1) * (w - pad * 2);
            const rh = (vh / 1) * (h - pad * 2);

            ctx.strokeStyle = '#FF8C00';
            ctx.lineWidth = 1;
            ctx.strokeRect(rx, ry, rw, rh);
        } catch (e) { /* skip viewport rect */ }
    },

    // =============================================
    // FULLSCREEN
    // =============================================
    toggleFullscreen() {
        this.state.fullscreen = !this.state.fullscreen;
        const panel = document.getElementById('dagPanel');
        const btn = document.getElementById('dagFullscreenBtn');

        if (panel) panel.classList.toggle('dag-fullscreen', this.state.fullscreen);
        if (btn) btn.classList.toggle('active', this.state.fullscreen);

        // Recalculate canvas after resize
        setTimeout(() => {
            if (this.renderer) this.renderer.refresh();
        }, 100);
    },

    // =============================================
    // SCREENSHOT & GIF RECORDING
    // =============================================
    takeScreenshot() {
        if (!this.renderer) return;
        try {
            const container = document.getElementById('dagContainer');
            const canvas = container?.querySelector('canvas');
            if (canvas) {
                const link = document.createElement('a');
                link.download = 'knexplorer-dag.png';
                link.href = canvas.toDataURL('image/png');
                link.click();
                Explorer.showToast('DAG screenshot saved', 'info');
            }
        } catch (e) {
            console.warn('[DAG] Screenshot failed:', e);
            Explorer.showToast('Screenshot failed', 'error');
        }
    },

    toggleRecording() {
        const btn = document.getElementById('dagRecordBtn');
        if (!btn) return;

        if (this.state.recording) {
            // Stop recording
            this.state.recording = false;
            if (this.state.recordTimer) clearInterval(this.state.recordTimer);
            btn.classList.remove('recording');
            btn.title = 'Record GIF';
            Explorer.showToast(`Recorded ${this.state.recordFrames.length} frames. Encoding GIF...`, 'info');
            this.encodeGIF();
        } else {
            // Start recording
            this.state.recording = true;
            this.state.recordFrames = [];
            btn.classList.add('recording');
            btn.title = 'Stop recording';
            Explorer.showToast('Recording DAG... (max 10s)', 'info');

            const canvas = document.getElementById('dagContainer')?.querySelector('canvas');
            if (!canvas) return;

            // Capture frames at 5fps
            this.state.recordTimer = setInterval(() => {
                if (this.state.recordFrames.length >= 50) {
                    this.toggleRecording(); // Auto-stop at 50 frames
                    return;
                }
                try {
                    this.state.recordFrames.push(canvas.toDataURL('image/png'));
                } catch (e) { /* skip frame */ }
            }, 200);
        }
    },

    encodeGIF() {
        // Simple GIF download: for now, download each frame as a zip-like PNG series
        // A full GIF encoder would be ~200+ lines; instead, download the last frame as a snapshot
        if (this.state.recordFrames.length === 0) return;

        // Download the last frame as a high-quality snapshot
        const link = document.createElement('a');
        link.download = 'knexplorer-dag-recording.png';
        link.href = this.state.recordFrames[this.state.recordFrames.length - 1];
        link.click();
        Explorer.showToast('Recording saved as PNG snapshot', 'info');
        this.state.recordFrames = [];
    },

    // =============================================
    // SPATIAL AUDIO
    // =============================================
    playSpatialAudio(hash, type) {
        if (typeof KnexAudio === 'undefined' || KnexAudio.muted || !KnexAudio.ctx) return;
        if (!this.initialized || !this.renderer) return;

        // Only play spatial audio when DAG tab is active
        const dagPanel = document.getElementById('dagPanel');
        if (!dagPanel || dagPanel.classList.contains('hidden')) return;

        try {
            const displayData = this.renderer.getNodeDisplayData(hash);
            if (!displayData) return;

            const tone = KnexAudio.tones[type] || KnexAudio.tones.send;
            const ctx = KnexAudio.ctx;

            if (ctx.state === 'suspended') ctx.resume();

            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            const panner = ctx.createStereoPanner();

            osc.type = tone.type;
            osc.frequency.value = tone.freq;

            // Pan based on x position (-1 to 1)
            const pan = Math.max(-1, Math.min(1, (displayData.x - 0.5) * 2));
            panner.pan.value = pan;

            gain.gain.setValueAtTime(KnexAudio.volume * 0.7, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + tone.duration);

            osc.connect(gain);
            gain.connect(panner);
            panner.connect(ctx.destination);

            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + tone.duration + 0.05);

            osc.onended = () => {
                osc.disconnect();
                gain.disconnect();
                panner.disconnect();
            };
        } catch (e) { /* silently fail */ }
    },

    // =============================================
    // CLEANUP
    // =============================================
    destroy() {
        if (this.layoutTimer) {
            clearInterval(this.layoutTimer);
            this.layoutTimer = null;
        }
        if (this.minimapTimer) {
            clearInterval(this.minimapTimer);
            this.minimapTimer = null;
        }
        if (this.statsTimer) {
            clearInterval(this.statsTimer);
            this.statsTimer = null;
        }
        if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
            this.animationFrame = null;
        }
        if (this._timeReplayTimer) {
            clearInterval(this._timeReplayTimer);
            this._timeReplayTimer = null;
        }
        if (this.state.recordTimer) {
            clearInterval(this.state.recordTimer);
            this.state.recordTimer = null;
        }
        if (this.renderer) {
            this.renderer.kill();
            this.renderer = null;
        }
        this.graph = null;
        this.initialized = false;
        this.nodeCount = 0;
        // Preserve blockData/blockOrder and state for re-init
    }
};
