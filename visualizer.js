/**
 * KnexVisualizer — Real-time DAG Visualizer
 * Uses Sigma.js v2 (WebGL) + Graphology for graph data
 * ForceAtlas2 layout for organic node positioning
 *
 * Nodes = blocks (colored by type, sized by amount)
 * Edges = intra-account (previous→current) + cross-account (send→receive)
 *
 * Improvements v2:
 * - Fixed memory leak: properly drops edges when trimming nodes
 * - Node count display
 * - Screenshot button
 * - Better tooltip positioning
 * - Configurable max nodes
 */
const KnexVisualizer = {
    graph: null,
    renderer: null,
    nodeCount: 0,
    maxNodes: 200,
    layoutTimer: null,
    initialized: false,
    buffered: [],

    // Color map for block types
    colors: {
        send:      '#ff3b3b',
        receive:   '#00e676',
        open:      '#448aff',
        change:    '#bb86fc',
        bandwidth: '#4dd0e1',
        pending:   '#ffc107',
    },

    init() {
        // Buffer blocks even before DAG tab is shown
        Explorer.on('block', (data) => {
            this.buffered.push(data);
            if (this.buffered.length > this.maxNodes) this.buffered.shift();
            if (this.initialized) this.addBlock(data);
        });

        // Initialize on first DAG tab click
        const dagTab = document.getElementById('tabDag');
        if (dagTab) {
            dagTab.addEventListener('click', () => {
                if (!this.initialized) {
                    setTimeout(() => this.setup(), 50);
                }
            });
        }

        // Reset button
        const resetBtn = document.getElementById('dagResetBtn');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => this.resetView());
        }

        // Screenshot button
        const screenshotBtn = document.getElementById('dagScreenshotBtn');
        if (screenshotBtn) {
            screenshotBtn.addEventListener('click', () => this.takeScreenshot());
        }
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
                labelRenderedSizeThreshold: 12,
                labelFont: 'JetBrains Mono',
                labelSize: 10,
                labelColor: { color: '#e8e8e8' },
                defaultNodeColor: '#FF8C00',
                defaultEdgeColor: 'rgba(255,255,255,0.1)',
                defaultEdgeType: 'arrow',
                edgeLabelFont: 'JetBrains Mono',
                minCameraRatio: 0.08,
                maxCameraRatio: 10,
                nodeProgramClasses: {},
                enableEdgeClickEvents: false,
                enableEdgeWheelEvents: false,
                allowInvalidContainer: true,
            });

            // Hover tooltip
            this.setupTooltip(container);

            // Click to view block detail
            this.renderer.on('clickNode', ({ node }) => {
                const attrs = this.graph.getNodeAttributes(node);
                if (attrs.blockHash) {
                    Explorer.lookupBlock(attrs.blockHash);
                }
            });

            // Replay buffered blocks
            for (const block of this.buffered) {
                this.addBlock(block);
            }

            this.initialized = true;
            this.startLayout();
            this.updateNodeCount();

            console.log('[DAG] Visualizer initialized with', this.graph.order, 'nodes');
        } catch (e) {
            console.error('[DAG] Setup failed:', e);
            container.innerHTML = `<div style="padding:40px;text-align:center;color:#ff3b3b">DAG init error: ${e.message}</div>`;
        }
    },

    addBlock(data) {
        if (!this.graph) return;

        const hash = data.hash;
        if (!hash || this.graph.hasNode(hash)) return;

        const type = data.block_type || 'send';
        const color = this.colors[type] || this.colors.send;

        // Node size: log-scale of amount, clamped 4-18
        let size = 6;
        try {
            const rawAmount = BigInt(data.amount || data.balance || '0');
            if (rawAmount > 0n) {
                const logSize = Math.log10(Number(rawAmount) + 1);
                size = Math.max(4, Math.min(18, logSize * 1.2));
            }
        } catch (e) { /* default size */ }

        // Random initial position
        const x = (Math.random() - 0.5) * 20;
        const y = (Math.random() - 0.5) * 20;

        // Short label
        const label = data.account ? data.account.slice(0, 6) + '..' : hash.slice(0, 8);

        this.graph.addNode(hash, {
            x, y, size, color, label,
            blockHash: hash,
            account: data.account || '',
            blockType: type,
            amount: data.amount || '0',
            destination: data.destination || '',
            timestamp: data.timestamp || 0,
        });

        this.nodeCount++;

        // Intra-account edge: previous → current
        const prev = data.previous;
        if (prev && prev !== '0000000000000000000000000000000000000000000000000000000000000000' && this.graph.hasNode(prev)) {
            const edgeId = `chain:${prev}->${hash}`;
            if (!this.graph.hasEdge(edgeId)) {
                this.graph.addEdgeWithKey(edgeId, prev, hash, {
                    color: 'rgba(255,255,255,0.12)',
                    size: 1,
                });
            }
        }

        // Cross-account edge: this send → destination
        if (data.destination && this.graph.hasNode(data.destination)) {
            const edgeId = `link:${hash}->${data.destination}`;
            if (!this.graph.hasEdge(edgeId)) {
                this.graph.addEdgeWithKey(edgeId, hash, data.destination, {
                    color: 'rgba(255,140,0,0.2)',
                    size: 0.8,
                });
            }
        }

        // Reverse link: receive ← source
        if (data.source && this.graph.hasNode(data.source)) {
            const edgeId = `link:${data.source}->${hash}`;
            if (!this.graph.hasEdge(edgeId)) {
                this.graph.addEdgeWithKey(edgeId, data.source, hash, {
                    color: 'rgba(255,140,0,0.2)',
                    size: 0.8,
                });
            }
        }

        // FIX: Properly trim nodes + their edges to prevent memory leak
        this.trimOldest();
        this.updateNodeCount();

        // Quick layout pass
        this.applyLayoutStep(3);
    },

    trimOldest() {
        while (this.graph.order > this.maxNodes) {
            const nodes = this.graph.nodes();
            if (nodes.length > 0) {
                const oldNode = nodes[0];
                // FIX: dropNode in graphology already drops connected edges
                // but we explicitly clear edges first for safety
                try {
                    this.graph.edges(oldNode).forEach(edge => {
                        try { this.graph.dropEdge(edge); } catch (e) {}
                    });
                } catch (e) {}
                try {
                    this.graph.dropNode(oldNode);
                } catch (e) {}
                this.nodeCount--;
            }
        }
    },

    updateNodeCount() {
        const el = document.getElementById('dagNodeCount');
        if (el && this.graph) {
            el.textContent = `${this.graph.order} nodes, ${this.graph.size} edges`;
        }
    },

    startLayout() {
        if (!this._hasFA2()) return;

        this.layoutTimer = setInterval(() => {
            if (this.graph && this.graph.order > 1) {
                this.applyLayoutStep(5);
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
        } catch (e) {
            // Silently fail on layout errors
        }
    },

    _hasFA2() {
        return typeof graphologyLibrary !== 'undefined' &&
               graphologyLibrary.layoutForceAtlas2 &&
               typeof graphologyLibrary.layoutForceAtlas2.assign === 'function';
    },

    setupTooltip(container) {
        const tooltip = document.createElement('div');
        tooltip.className = 'dag-tooltip hidden';
        container.appendChild(tooltip);

        let hoveredNode = null;

        this.renderer.on('enterNode', ({ node }) => {
            hoveredNode = node;
            const attrs = this.graph.getNodeAttributes(node);
            const type = (attrs.blockType || 'unknown').toUpperCase();
            const typeColor = this.colors[attrs.blockType] || '#FF8C00';
            const amount = Explorer.formatAmount(attrs.amount || '0');
            const account = attrs.account ? Explorer.truncateAddress(attrs.account) : '?';
            const hashStr = attrs.blockHash ? attrs.blockHash.slice(0, 16) + '...' : '?';

            tooltip.innerHTML =
                `<div><strong style="color:${typeColor}">${type}</strong></div>` +
                `<div>Hash: ${hashStr}</div>` +
                `<div>Account: ${account}</div>` +
                `<div>Amount: ${amount} KNEX</div>`;
            tooltip.classList.remove('hidden');

            // Highlight node and connected edges
            this.renderer.setSetting('nodeReducer', (n, data) => {
                if (n === node) return { ...data, highlighted: true };
                return { ...data, color: data.color + '60' };
            });
            this.renderer.setSetting('edgeReducer', (edge, data) => {
                if (this.graph.hasExtremity(edge, node)) return { ...data, color: '#FF8C00', size: 2 };
                return { ...data, hidden: true };
            });
        });

        this.renderer.on('leaveNode', () => {
            hoveredNode = null;
            tooltip.classList.add('hidden');
            this.renderer.setSetting('nodeReducer', null);
            this.renderer.setSetting('edgeReducer', null);
        });

        // Position tooltip near mouse
        container.addEventListener('mousemove', (e) => {
            if (!hoveredNode) return;
            const rect = container.getBoundingClientRect();
            const x = e.clientX - rect.left + 14;
            const y = e.clientY - rect.top + 14;
            tooltip.style.left = Math.min(x, rect.width - 280) + 'px';
            tooltip.style.top = Math.min(y, rect.height - 100) + 'px';
        });
    },

    resetView() {
        if (this.renderer) {
            const camera = this.renderer.getCamera();
            camera.animate({ x: 0.5, y: 0.5, ratio: 1 }, { duration: 400 });
        }
    },

    takeScreenshot() {
        if (!this.renderer) return;
        try {
            // Get the canvas element from the sigma container
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

    // Cleanup method for SPA navigation
    destroy() {
        if (this.layoutTimer) {
            clearInterval(this.layoutTimer);
            this.layoutTimer = null;
        }
        if (this.renderer) {
            this.renderer.kill();
            this.renderer = null;
        }
        this.graph = null;
        this.initialized = false;
        this.nodeCount = 0;
    }
};
