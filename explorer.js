/**
 * Knexplorer v2.0 - KnexCoin Block Explorer
 * Live-listening block explorer with WebSocket feed
 * Improvements: pagination, filtering, rich list, block list,
 * keyboard shortcuts, breadcrumbs, error recovery, toast notifications,
 * address resolution for hex destinations, search suggestions
 */

const Explorer = {
    // Configuration
    config: {
        apiUrl: 'https://testnet-api.knexcoins.com',
        wsUrl: 'wss://testnet-api.knexcoins.com/ws',
        decimals: 7,
        symbol: 'KNEX',
        maxFeedItems: 200,
        reconnectDelay: 3000,
        reconnectMaxDelay: 30000,
        statsInterval: 15000,
        historyPageSize: 25,
    },

    // State
    state: {
        ws: null,
        feedPaused: false,
        feedItems: [],
        feedFilter: 'all',
        currentView: 'feed',
        reconnectAttempts: 0,
        reconnectTimer: null,
        statsTimer: null,
        listeners: {},
        // Account pagination
        historyPage: 0,
        historyData: [],
        historyFilter: 'all',
        currentAccount: null,
        // Navigation stack
        navStack: [],
        // Search history
        searchHistory: [],
        // Error state
        lastError: null,
        lastErrorAction: null,
    },

    // =============================================
    // IDENTICON CACHE & HELPERS
    // =============================================
    identiconCache: new Map(),

    async createIdenticon(address, size = 16) {
        if (!address || !this.isValidAddress(address)) return null;

        const cacheKey = `${address}:${size}`;
        const wrapper = document.createElement('span');
        wrapper.className = size >= 48 ? 'identicon-account' : 'identicon-inline';

        // Check cache for pre-rendered data URL
        if (this.identiconCache.has(cacheKey)) {
            const img = document.createElement('img');
            img.src = this.identiconCache.get(cacheKey);
            img.width = size;
            img.height = size;
            img.className = 'identicon-img';
            img.alt = '';
            wrapper.appendChild(img);
            return wrapper;
        }

        // Generate fresh
        if (typeof KnexIdenticon === 'undefined') return null;
        const temp = document.createElement('span');
        try {
            await KnexIdenticon.generate(address, temp, size);
        } catch (e) {
            return null;
        }
        const canvas = temp.querySelector('canvas');
        if (canvas) {
            const dataUrl = canvas.toDataURL('image/png');

            // Evict oldest entries if cache is too large
            if (this.identiconCache.size > 500) {
                const keys = [...this.identiconCache.keys()];
                for (let i = 0; i < 100; i++) {
                    this.identiconCache.delete(keys[i]);
                }
            }

            this.identiconCache.set(cacheKey, dataUrl);

            const img = document.createElement('img');
            img.src = dataUrl;
            img.width = size;
            img.height = size;
            img.className = 'identicon-img';
            img.alt = '';
            wrapper.appendChild(img);
        }
        return wrapper;
    },

    attachIdenticons(containerEl, size = 16) {
        const addressEls = containerEl.querySelectorAll('.feed-address[data-address]');
        for (const addrEl of addressEls) {
            const address = addrEl.dataset.address;
            if (!address || !this.isValidAddress(address)) continue;
            this.createIdenticon(address, size).then(icon => {
                if (icon && addrEl.parentNode) {
                    addrEl.insertBefore(icon, addrEl.firstChild);
                }
            });
        }
    },

    // =============================================
    // EVENT DISPATCH
    // =============================================
    on(event, callback) {
        if (!this.state.listeners[event]) this.state.listeners[event] = [];
        this.state.listeners[event].push(callback);
    },

    emit(event, data) {
        const cbs = this.state.listeners[event] || [];
        for (const cb of cbs) {
            try { cb(data); } catch (e) { console.warn('[Event]', event, e); }
        }
    },

    // =============================================
    // INIT
    // =============================================
    init() {
        this.loadSearchHistory();
        this.bindEvents();
        this.bindKeyboardShortcuts();
        this.connectWebSocket();
        this.fetchNodeStats();
        this.state.statsTimer = setInterval(() => this.fetchNodeStats(), this.config.statsInterval);

        // Handle URL hash for deep linking
        this.handleHashRoute();
        window.addEventListener('hashchange', () => this.handleHashRoute());

        // Initialize feature modules (guarded for graceful degradation)
        if (typeof KnexTheme !== 'undefined') KnexTheme.init();
        if (typeof KnexAudio !== 'undefined') KnexAudio.init();
        if (typeof KnexStats !== 'undefined') KnexStats.init();
        if (typeof KnexAccount !== 'undefined') KnexAccount.init();
        if (typeof KnexFlow !== 'undefined') KnexFlow.init();
        if (typeof KnexVisualizer !== 'undefined') KnexVisualizer.init();
        if (typeof KnexCore !== 'undefined') KnexCore.init();

        // Error banner bindings
        const retryBtn = document.getElementById('errorRetryBtn');
        const closeBtn = document.getElementById('errorCloseBtn');
        if (retryBtn) retryBtn.addEventListener('click', () => this.retryLastAction());
        if (closeBtn) closeBtn.addEventListener('click', () => this.hideError());

        // Breadcrumb navigation
        document.querySelectorAll('.breadcrumb-item[data-action="home"]').forEach(btn => {
            btn.addEventListener('click', () => this.showFeed());
        });
    },

    // =============================================
    // KEYBOARD SHORTCUTS
    // =============================================
    bindKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Don't handle shortcuts when typing in input
            const active = document.activeElement;
            const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);

            if (e.key === 'Escape') {
                const modal = document.getElementById('shortcutsModal');
                if (modal && !modal.classList.contains('hidden')) {
                    modal.classList.add('hidden');
                    return;
                }
                if (isInput) {
                    active.blur();
                    return;
                }
                this.showFeed();
                return;
            }

            if (isInput) return;

            switch (e.key) {
                case '/':
                    e.preventDefault();
                    document.getElementById('searchInput')?.focus();
                    break;
                case 't':
                case 'T':
                    document.getElementById('themeToggle')?.click();
                    break;
                case 's':
                case 'S':
                    document.getElementById('soundToggle')?.click();
                    break;
                case 'p':
                case 'P':
                    this.togglePause();
                    break;
                case '1':
                    document.getElementById('tabFeed')?.click();
                    break;
                case '2':
                    document.getElementById('tabDag')?.click();
                    break;
                case '3':
                    document.getElementById('tabStats')?.click();
                    break;
                case '4':
                    document.getElementById('tabRichList')?.click();
                    break;
                case '5':
                    document.getElementById('tabBlocks')?.click();
                    break;
                case '6':
                    document.getElementById('tabCore')?.click();
                    break;
                case '?':
                    e.preventDefault();
                    this.toggleShortcutsModal();
                    break;
            }
        });
    },

    toggleShortcutsModal() {
        const modal = document.getElementById('shortcutsModal');
        if (modal) modal.classList.toggle('hidden');
        const closeBtn = document.getElementById('closeShortcuts');
        if (closeBtn) closeBtn.onclick = () => modal.classList.add('hidden');
    },

    bindEvents() {
        // Search
        const searchInput = document.getElementById('searchInput');
        const searchBtn = document.getElementById('searchBtn');
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                this.handleSearch();
                this.hideSearchSuggestions();
            }
        });
        searchInput.addEventListener('input', () => this.onSearchInput());
        searchInput.addEventListener('focus', () => this.onSearchFocus());
        searchInput.addEventListener('blur', () => setTimeout(() => this.hideSearchSuggestions(), 200));
        searchBtn.addEventListener('click', () => this.handleSearch());

        // Feed controls
        document.getElementById('pauseBtn').addEventListener('click', () => this.togglePause());
        document.getElementById('clearBtn').addEventListener('click', () => this.clearFeed());

        // Copy address
        document.getElementById('copyAccountAddr').addEventListener('click', () => {
            const addr = document.getElementById('accountAddress').textContent;
            this.copyToClipboard(addr);
        });

        // Feed filter chips
        document.getElementById('feedFilterGroup')?.addEventListener('click', (e) => {
            const chip = e.target.closest('.filter-chip');
            if (!chip) return;
            document.querySelectorAll('#feedFilterGroup .filter-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            this.state.feedFilter = chip.dataset.filter;
            this.applyFeedFilter();
        });

        // History filter chips
        document.getElementById('historyFilterGroup')?.addEventListener('click', (e) => {
            const chip = e.target.closest('.filter-chip');
            if (!chip) return;
            document.querySelectorAll('#historyFilterGroup .filter-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            this.state.historyFilter = chip.dataset.filter;
            this.state.historyPage = 0;
            this.renderPaginatedHistory();
        });

        // Pagination buttons
        document.getElementById('historyPrev')?.addEventListener('click', () => {
            if (this.state.historyPage > 0) {
                this.state.historyPage--;
                this.renderPaginatedHistory();
            }
        });
        document.getElementById('historyNext')?.addEventListener('click', () => {
            const filtered = this.getFilteredHistory();
            const maxPage = Math.floor((filtered.length - 1) / this.config.historyPageSize);
            if (this.state.historyPage < maxPage) {
                this.state.historyPage++;
                this.renderPaginatedHistory();
            }
        });

        // Rich list refresh
        document.getElementById('refreshRichList')?.addEventListener('click', () => this.fetchRichList());

        // Tab click for rich list & blocks (lazy load)
        document.getElementById('tabRichList')?.addEventListener('click', () => {
            if (document.getElementById('richlistContainer')?.querySelector('.feed-empty')) {
                this.fetchRichList();
            }
        });
        document.getElementById('tabBlocks')?.addEventListener('click', () => {
            if (document.getElementById('blocksContainer')?.querySelector('.feed-empty')) {
                this.fetchBlockList();
            }
        });
    },

    // =============================================
    // SEARCH
    // =============================================
    handleSearch() {
        const input = document.getElementById('searchInput');
        const query = input.value.trim();
        if (!query) return;

        // Save to search history
        this.addToSearchHistory(query);

        if (this.isValidAddress(query)) {
            this.lookupAccount(query);
        } else if (this.isValidHash(query)) {
            this.lookupBlock(query);
        } else {
            // Could be partial — try account first
            this.lookupAccount(query);
        }

        input.blur();
    },

    onSearchInput() {
        const input = document.getElementById('searchInput');
        const query = input.value.trim();
        if (query.length < 2) {
            this.hideSearchSuggestions();
            return;
        }
        this.showSearchSuggestions(query);
    },

    onSearchFocus() {
        const input = document.getElementById('searchInput');
        if (input.value.trim().length >= 2) {
            this.showSearchSuggestions(input.value.trim());
        } else if (this.state.searchHistory.length > 0) {
            this.showSearchSuggestions('');
        }
        // Hide the shortcut hint when focused
        const hint = document.getElementById('searchShortcut');
        if (hint) hint.style.display = 'none';
        input.addEventListener('blur', () => {
            if (hint) hint.style.display = '';
        }, { once: true });
    },

    showSearchSuggestions(query) {
        const container = document.getElementById('searchSuggestions');
        if (!container) return;

        let html = '';

        if (!query && this.state.searchHistory.length > 0) {
            html = '<div class="suggestion-header">Recent Searches</div>';
            for (const item of this.state.searchHistory.slice(0, 5)) {
                const display = item.length > 30 ? item.slice(0, 12) + '...' + item.slice(-8) : item;
                html += `<div class="suggestion-item" data-value="${this.escapeHtml(item)}">${this.escapeHtml(display)}</div>`;
            }
        } else if (query) {
            // Match from search history
            const matches = this.state.searchHistory.filter(h =>
                h.toLowerCase().includes(query.toLowerCase())
            ).slice(0, 3);

            if (matches.length > 0) {
                for (const item of matches) {
                    const display = item.length > 30 ? item.slice(0, 12) + '...' + item.slice(-8) : item;
                    html += `<div class="suggestion-item" data-value="${this.escapeHtml(item)}">${this.escapeHtml(display)}</div>`;
                }
            }

            // Type hints
            if (this.isValidAddress(query)) {
                html += `<div class="suggestion-item suggestion-hint" data-value="${this.escapeHtml(query)}">View account ${query.slice(0,8)}...</div>`;
            } else if (this.isValidHash(query)) {
                html += `<div class="suggestion-item suggestion-hint" data-value="${this.escapeHtml(query)}">View block ${query.slice(0,8)}...</div>`;
            }
        }

        if (!html) {
            this.hideSearchSuggestions();
            return;
        }

        container.innerHTML = html;
        container.classList.remove('hidden');

        container.querySelectorAll('.suggestion-item').forEach(item => {
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                const val = item.dataset.value;
                document.getElementById('searchInput').value = val;
                this.handleSearch();
                this.hideSearchSuggestions();
            });
        });
    },

    hideSearchSuggestions() {
        const container = document.getElementById('searchSuggestions');
        if (container) container.classList.add('hidden');
    },

    addToSearchHistory(query) {
        this.state.searchHistory = this.state.searchHistory.filter(h => h !== query);
        this.state.searchHistory.unshift(query);
        if (this.state.searchHistory.length > 20) this.state.searchHistory.pop();
        try { localStorage.setItem('knexplorer-search-history', JSON.stringify(this.state.searchHistory)); } catch (e) {}
    },

    loadSearchHistory() {
        try {
            const saved = localStorage.getItem('knexplorer-search-history');
            if (saved) this.state.searchHistory = JSON.parse(saved);
        } catch (e) {}
    },

    isValidAddress(str) {
        return str && str.length === 50 && /^[0-9A-Za-z]{50}$/.test(str);
    },

    isValidHash(str) {
        return str && str.length === 64 && /^[0-9a-fA-F]{64}$/.test(str);
    },

    // =============================================
    // ROUTING
    // =============================================
    handleHashRoute() {
        const hash = window.location.hash.slice(1);
        if (!hash) return;

        if (hash.startsWith('account/')) {
            const address = hash.slice(8);
            if (this.isValidAddress(address)) {
                this.lookupAccount(address);
            }
        } else if (hash.startsWith('block/')) {
            const blockHash = hash.slice(6);
            if (this.isValidHash(blockHash)) {
                this.lookupBlock(blockHash);
            }
        }
    },

    // =============================================
    // WEBSOCKET
    // =============================================
    connectWebSocket() {
        // Skip if already connected or connecting
        if (this.state.ws) {
            const rs = this.state.ws.readyState;
            if (rs === WebSocket.OPEN) return;
            if (rs === WebSocket.CONNECTING) return;
            this.state.ws.close();
        }

        // Clear any existing ping timer
        if (this.state.pingTimer) {
            clearInterval(this.state.pingTimer);
            this.state.pingTimer = null;
        }

        this.updateWsStatus('connecting');

        try {
            this.state.ws = new WebSocket(this.config.wsUrl);

            this.state.ws.onopen = () => {
                console.log('[WS] Connected');
                this.state.reconnectAttempts = 0;
                this.updateWsStatus('connected');
                this.hideError();

                // Keep-alive ping every 30s to prevent idle disconnect
                this.state.pingTimer = setInterval(() => {
                    if (this.state.ws && this.state.ws.readyState === WebSocket.OPEN) {
                        this.state.ws.send('{"type":"ping"}');
                    }
                }, 30000);
            };

            this.state.ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'pong') return; // Ignore keep-alive replies
                    this.handleWsMessage(msg);
                } catch (e) {
                    console.warn('[WS] Parse error:', e);
                }
            };

            this.state.ws.onclose = (event) => {
                console.log('[WS] Disconnected:', event.code, event.reason);
                if (this.state.pingTimer) {
                    clearInterval(this.state.pingTimer);
                    this.state.pingTimer = null;
                }
                this.updateWsStatus('disconnected');
                this.scheduleReconnect();
            };

            this.state.ws.onerror = (error) => {
                console.warn('[WS] Error:', error);
                // Don't set disconnected here — onclose will fire after onerror
            };
        } catch (e) {
            console.error('[WS] Failed to connect:', e);
            this.updateWsStatus('disconnected');
            this.scheduleReconnect();
        }
    },

    scheduleReconnect() {
        if (this.state.reconnectTimer) return;

        const delay = Math.min(
            this.config.reconnectDelay * Math.pow(1.5, this.state.reconnectAttempts),
            this.config.reconnectMaxDelay
        );
        this.state.reconnectAttempts++;

        console.log(`[WS] Reconnecting in ${Math.round(delay/1000)}s (attempt ${this.state.reconnectAttempts})`);

        this.state.reconnectTimer = setTimeout(() => {
            this.state.reconnectTimer = null;
            this.connectWebSocket();
        }, delay);
    },

    updateWsStatus(status) {
        const el = document.getElementById('wsStatus');
        el.className = `stat-pill ws-status ${status}`;
        const label = el.querySelector('.stat-value');

        switch (status) {
            case 'connecting': label.textContent = 'Connecting'; break;
            case 'connected': label.textContent = 'Live'; break;
            case 'disconnected': label.textContent = 'Offline'; break;
        }
        this.emit('ws:status', status);
    },

    handleWsMessage(msg) {
        if (msg.type === 'BlockConfirmed' && msg.data) {
            const feedItem = {
                type: msg.data.block_type || 'send',
                hash: msg.data.hash || '',
                account: msg.data.account || '',
                amount: msg.data.amount || msg.data.balance || '0',
                timestamp: msg.data.timestamp || Date.now(),
                memo: msg.data.memo || '',
                destination: msg.data.destination || msg.data.link || '',
                source: msg.data.source || '',
            };
            this.addFeedItem(feedItem);
            this.emit('block', msg.data);
        } else if (msg.type === 'PendingReceived' && msg.data) {
            this.addFeedItem({
                type: 'pending',
                hash: msg.data.hash || msg.data.source || '',
                account: msg.data.account || '',
                amount: msg.data.amount || '0',
                timestamp: Date.now(),
                memo: '',
                destination: msg.data.account || '',
                source: msg.data.source || '',
            });
            this.emit('pending', msg.data);
        }
    },

    // =============================================
    // FEED
    // =============================================
    addFeedItem(item) {
        if (this.state.feedPaused) return;

        this.state.feedItems.unshift(item);

        if (this.state.feedItems.length > this.config.maxFeedItems) {
            this.state.feedItems = this.state.feedItems.slice(0, this.config.maxFeedItems);
        }

        // Only render if it passes the current filter
        if (this.state.feedFilter === 'all' || item.type === this.state.feedFilter) {
            this.renderFeedItem(item, true);
        }

        const empty = document.getElementById('feedEmpty');
        if (empty) empty.remove();
    },

    renderFeedItem(item, prepend = false) {
        const container = document.getElementById('feedContainer');
        const el = document.createElement('div');
        el.className = 'feed-item';
        el.dataset.hash = item.hash;
        el.dataset.type = item.type;

        const typeClass = this.getTypeClass(item.type);
        const typeLabel = this.getTypeLabel(item.type);
        const timeStr = this.formatTime(item.timestamp);
        const shortHash = this.truncateHash(item.hash);
        const shortAddr = this.truncateAddress(item.account);
        const amount = this.formatAmount(item.amount);
        const isPositive = item.type === 'receive' || item.type === 'open' || item.type === 'pending';

        // Show destination for sends
        let destHtml = '';
        if (item.type === 'send' && item.destination) {
            const dest = this.isValidAddress(item.destination)
                ? this.truncateAddress(item.destination)
                : this.truncateHash(item.destination);
            destHtml = `<div class="feed-dest">→ <span class="feed-address" data-address="${this.escapeHtml(item.destination)}">${dest}</span></div>`;
        }

        el.innerHTML = `
            <div class="feed-type-badge ${typeClass}">${typeLabel.slice(0, 3).toUpperCase()}</div>
            <div class="feed-body">
                <div class="feed-top-row">
                    <span class="feed-type-label" style="color: inherit">${typeLabel}</span>
                    <span class="feed-time" title="${this.formatFullTime(item.timestamp)}">${timeStr}</span>
                </div>
                <div class="feed-address" data-address="${this.escapeHtml(item.account)}">${shortAddr}</div>
                ${destHtml}
                ${amount !== '0' ? `<div class="feed-amount ${isPositive ? 'positive' : 'negative'}">${isPositive ? '+' : '-'}${amount} ${this.config.symbol}</div>` : ''}
                <div class="feed-hash">${shortHash}</div>
                ${item.memo ? `<div class="feed-memo">${this.escapeHtml(item.memo)}</div>` : ''}
            </div>
        `;

        this.attachIdenticons(el);

        el.addEventListener('click', (e) => {
            const addrEl = e.target.closest('.feed-address');
            if (addrEl) {
                e.stopPropagation();
                const addr = addrEl.dataset.address;
                if (addr && this.isValidAddress(addr)) this.lookupAccount(addr);
                return;
            }
            if (item.hash) this.lookupBlock(item.hash);
        });

        if (prepend) {
            container.insertBefore(el, container.firstChild);
            while (container.children.length > this.config.maxFeedItems) {
                container.removeChild(container.lastChild);
            }
        } else {
            container.appendChild(el);
        }
    },

    applyFeedFilter() {
        const container = document.getElementById('feedContainer');
        const items = container.querySelectorAll('.feed-item');
        items.forEach(item => {
            if (this.state.feedFilter === 'all' || item.dataset.type === this.state.feedFilter) {
                item.style.display = '';
            } else {
                item.style.display = 'none';
            }
        });
    },

    togglePause() {
        this.state.feedPaused = !this.state.feedPaused;
        const btn = document.getElementById('pauseBtn');
        const dot = document.querySelector('.pulse-dot');

        if (this.state.feedPaused) {
            btn.classList.add('active');
            btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>';
            btn.title = 'Resume feed';
            if (dot) dot.classList.add('paused');
            this.showToast('Feed paused', 'info');
        } else {
            btn.classList.remove('active');
            btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
            btn.title = 'Pause feed';
            if (dot) dot.classList.remove('paused');
            this.showToast('Feed resumed', 'info');
        }
    },

    clearFeed() {
        this.state.feedItems = [];
        const container = document.getElementById('feedContainer');
        container.innerHTML = `
            <div class="feed-empty" id="feedEmpty">
                <div class="feed-empty-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48">
                        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
                    </svg>
                </div>
                <p>Waiting for transactions...</p>
                <p class="feed-empty-sub">Live blocks will appear here as they're confirmed on the network</p>
            </div>
        `;
    },

    // =============================================
    // ACCOUNT LOOKUP
    // =============================================
    async lookupAccount(address) {
        window.location.hash = `account/${address}`;
        this.showPanel('accountPanel');
        this.state.currentAccount = address;
        this.state.historyPage = 0;
        this.state.historyFilter = 'all';

        // Reset filter chips
        document.querySelectorAll('#historyFilterGroup .filter-chip').forEach(c => c.classList.remove('active'));
        document.querySelector('#historyFilterGroup .filter-chip[data-filter="all"]')?.classList.add('active');

        document.getElementById('accountAddress').textContent = address;

        // Add large identicon to account header
        const addrRow = document.getElementById('accountHeader')?.querySelector('.account-address-row');
        if (addrRow) {
            const existingIcon = addrRow.querySelector('.identicon-account');
            if (existingIcon) existingIcon.remove();
            this.createIdenticon(address, 48).then(icon => {
                if (icon && addrRow) {
                    addrRow.insertBefore(icon, addrRow.querySelector('.account-address') || addrRow.querySelector('#accountAddress'));
                }
            });
        }

        document.getElementById('accountBalance').textContent = '...';
        document.getElementById('accountPending').textContent = '...';
        document.getElementById('accountBlockCount').textContent = '...';
        document.getElementById('accountRep').textContent = '...';
        document.getElementById('historyContainer').innerHTML = '<div class="feed-empty"><span class="spinner-inline"></span> Loading history...</div>';
        document.getElementById('historyPagination')?.classList.add('hidden');

        try {
            const [infoRes, historyRes] = await Promise.all([
                fetch(`${this.config.apiUrl}/api/v1/account/${address}`),
                fetch(`${this.config.apiUrl}/account/${address}/history`),
            ]);

            let info = null;
            if (infoRes.ok) {
                info = await infoRes.json();
                document.getElementById('accountBalance').textContent =
                    this.formatAmount(info.balance || '0') + ' ' + this.config.symbol;
                document.getElementById('accountPending').textContent =
                    this.formatAmount(info.pending || '0') + ' ' + this.config.symbol;
                document.getElementById('accountBlockCount').textContent =
                    (info.block_count || 0).toLocaleString();

                const rep = info.representative || 'None';
                const repEl = document.getElementById('accountRep');
                repEl.textContent = rep;
                if (rep !== 'None' && this.isValidAddress(rep)) {
                    repEl.style.cursor = 'pointer';
                    repEl.onclick = () => this.lookupAccount(rep);
                    this.createIdenticon(rep, 16).then(icon => {
                        if (icon && repEl.parentNode) {
                            repEl.insertBefore(icon, repEl.firstChild);
                        }
                    });
                }
            } else {
                const err = await infoRes.json().catch(() => ({}));
                document.getElementById('accountBalance').textContent = '0 ' + this.config.symbol;
                document.getElementById('accountPending').textContent = '0 ' + this.config.symbol;
                document.getElementById('accountBlockCount').textContent = '0';
                document.getElementById('accountRep').textContent = err.error || 'Account not found';
            }

            let history = [];
            if (historyRes.ok) {
                history = await historyRes.json();
                this.state.historyData = history;
                this.renderPaginatedHistory();
            } else {
                this.state.historyData = [];
                document.getElementById('historyContainer').innerHTML =
                    '<div class="feed-empty"><p>No transaction history</p></div>';
            }

            this.emit('account:loaded', { info, history, address });
        } catch (error) {
            console.error('[Account] Lookup failed:', error);
            this.state.lastError = error.message;
            this.state.lastErrorAction = () => this.lookupAccount(address);
            this.showError(`Failed to load account: ${error.message}`);
            document.getElementById('historyContainer').innerHTML =
                `<div class="feed-empty"><p style="color: var(--red)">Failed to load account</p><p class="feed-empty-sub">${this.escapeHtml(error.message)}</p></div>`;
        }
    },

    // =============================================
    // PAGINATED HISTORY
    // =============================================
    getFilteredHistory() {
        if (this.state.historyFilter === 'all') return this.state.historyData;
        return this.state.historyData.filter(tx => tx.type === this.state.historyFilter);
    },

    renderPaginatedHistory() {
        const container = document.getElementById('historyContainer');
        const paginationEl = document.getElementById('historyPagination');
        container.innerHTML = '';

        const filtered = this.getFilteredHistory();

        if (!filtered || filtered.length === 0) {
            container.innerHTML = '<div class="feed-empty"><p>No transactions found</p></div>';
            if (paginationEl) paginationEl.classList.add('hidden');
            return;
        }

        const pageSize = this.config.historyPageSize;
        const start = this.state.historyPage * pageSize;
        const end = Math.min(start + pageSize, filtered.length);
        const page = filtered.slice(start, end);
        const totalPages = Math.ceil(filtered.length / pageSize);

        for (const tx of page) {
            const el = document.createElement('div');
            el.className = 'feed-item';

            const typeClass = this.getTypeClass(tx.type);
            const typeLabel = this.getTypeLabel(tx.type);
            const timeStr = this.formatTime(tx.timestamp);
            const shortHash = this.truncateHash(tx.hash);
            const counterparty = tx.account || '';
            const shortAddr = counterparty ? this.truncateAddress(counterparty) : '--';
            const amount = this.formatAmount(tx.amount || tx.balance || '0');
            const isPositive = tx.type === 'receive' || tx.type === 'open';

            el.innerHTML = `
                <div class="feed-type-badge ${typeClass}">${typeLabel.slice(0, 3).toUpperCase()}</div>
                <div class="feed-body">
                    <div class="feed-top-row">
                        <span class="feed-type-label">${typeLabel}</span>
                        <span class="feed-time" title="${this.formatFullTime(tx.timestamp)}">${timeStr}</span>
                    </div>
                    ${counterparty ? `<div class="feed-address" data-address="${this.escapeHtml(counterparty)}">${shortAddr}</div>` : ''}
                    ${amount !== '0' ? `<div class="feed-amount ${isPositive ? 'positive' : 'negative'}">${isPositive ? '+' : '-'}${amount} ${this.config.symbol}</div>` : ''}
                    <div class="feed-hash">${shortHash}</div>
                    ${tx.memo ? `<div class="feed-memo">${this.escapeHtml(tx.memo)}</div>` : ''}
                </div>
            `;

            this.attachIdenticons(el);

            el.addEventListener('click', (e) => {
                const addrEl = e.target.closest('.feed-address');
                if (addrEl) {
                    e.stopPropagation();
                    const addr = addrEl.dataset.address;
                    if (addr) this.lookupAccount(addr);
                    return;
                }
                if (tx.hash) this.lookupBlock(tx.hash);
            });

            container.appendChild(el);
        }

        // Update pagination
        if (paginationEl && totalPages > 1) {
            paginationEl.classList.remove('hidden');
            document.getElementById('historyPageInfo').textContent = `Page ${this.state.historyPage + 1} of ${totalPages}`;
            document.getElementById('historyPrev').disabled = this.state.historyPage === 0;
            document.getElementById('historyNext').disabled = this.state.historyPage >= totalPages - 1;
        } else if (paginationEl) {
            paginationEl.classList.add('hidden');
        }
    },

    // =============================================
    // BLOCK LOOKUP
    // =============================================
    async lookupBlock(hash) {
        window.location.hash = `block/${hash}`;
        this.showPanel('blockPanel');

        const fieldsEl = document.getElementById('blockFields');
        fieldsEl.innerHTML = '<div class="feed-empty"><span class="spinner-inline"></span> Loading block...</div>';

        // Clear previous nav
        const navEl = document.getElementById('blockNav');
        if (navEl) navEl.innerHTML = '';

        try {
            const res = await fetch(`${this.config.apiUrl}/api/v1/block/${hash}`);

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                fieldsEl.innerHTML = `<div class="feed-empty"><p style="color: var(--red)">${err.error || 'Block not found'}</p></div>`;
                return;
            }

            const block = await res.json();
            this.renderBlockDetail(block);
        } catch (error) {
            this.state.lastError = error.message;
            this.state.lastErrorAction = () => this.lookupBlock(hash);
            this.showError(`Failed to load block: ${error.message}`);
            fieldsEl.innerHTML = `<div class="feed-empty"><p style="color: var(--red)">Failed to load block</p><p class="feed-empty-sub">${this.escapeHtml(error.message)}</p></div>`;
        }
    },

    renderBlockDetail(block) {
        const fieldsEl = document.getElementById('blockFields');
        fieldsEl.innerHTML = '';

        // Flow visualization hook
        let flowContainer = document.getElementById('blockFlowContainer');
        if (!flowContainer) {
            flowContainer = document.createElement('div');
            flowContainer.id = 'blockFlowContainer';
            fieldsEl.parentElement.insertBefore(flowContainer, fieldsEl);
        } else {
            flowContainer.innerHTML = '';
        }

        const fields = [
            { label: 'Type', value: `<span class="type-tag ${this.getTypeClass(block.block_type)}">${block.block_type}</span>` },
            { label: 'Hash', value: block.hash, class: 'hash-value', copyable: true },
            { label: 'Account', value: block.account, class: 'address-link', action: () => this.lookupAccount(block.account), copyable: true },
            { label: 'Balance', value: this.formatAmount(block.balance || '0') + ' ' + this.config.symbol },
        ];

        // FIX: Destination field — resolve address properly
        if (block.block_type === 'send') {
            if (block.destination && this.isValidAddress(block.destination)) {
                // If block has a proper destination address field
                fields.push({ label: 'Destination', value: block.destination, class: 'address-link', action: () => this.lookupAccount(block.destination), copyable: true });
            } else if (block.link) {
                // link might be hex or address
                if (this.isValidAddress(block.link)) {
                    fields.push({ label: 'Destination', value: block.link, class: 'address-link', action: () => this.lookupAccount(block.link), copyable: true });
                } else {
                    fields.push({ label: 'Destination (hex)', value: block.link, class: 'hash-value', copyable: true });
                }
            }
        } else if (block.block_type === 'receive' || block.block_type === 'open') {
            if (block.link) {
                fields.push({ label: 'Source Block', value: block.link, class: 'hash-value clickable', action: () => this.lookupBlock(block.link), copyable: true });
            }
        }

        fields.push({ label: 'Previous', value: block.previous || '(genesis)', class: block.previous ? 'hash-value clickable' : 'hash-value', action: block.previous ? () => this.lookupBlock(block.previous) : null, copyable: !!block.previous });

        if (block.representative) {
            fields.push({ label: 'Representative', value: block.representative, class: 'address-link', action: () => this.lookupAccount(block.representative), copyable: true });
        }

        fields.push({ label: 'Timestamp', value: this.formatFullTime(block.timestamp) });

        if (block.signature) {
            fields.push({ label: 'Signature', value: block.signature, class: 'hash-value', copyable: true });
        }

        if (block.memo) {
            fields.push({ label: 'Memo', value: block.memo });
        }

        for (const f of fields) {
            const row = document.createElement('div');
            row.className = 'block-field';

            const label = document.createElement('div');
            label.className = 'block-field-label';
            label.textContent = f.label;

            const value = document.createElement('div');
            value.className = 'block-field-value' + (f.class ? ' ' + f.class : '');
            value.innerHTML = f.value;

            if (f.action) {
                value.addEventListener('click', f.action);
            }

            // Add copy button for copyable fields
            if (f.copyable) {
                const copyBtn = document.createElement('button');
                copyBtn.className = 'btn-copy-inline';
                copyBtn.title = 'Copy';
                copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
                copyBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.copyToClipboard(f.value);
                });
                value.appendChild(copyBtn);
            }

            row.appendChild(label);
            row.appendChild(value);
            // Add identicon to address-link fields
            if (f.class && f.class.includes('address-link') && f.value && this.isValidAddress(f.value)) {
                this.createIdenticon(f.value, 16).then(icon => {
                    if (icon && value.parentNode) {
                        value.insertBefore(icon, value.firstChild);
                    }
                });
            }

            fieldsEl.appendChild(row);
        }

        // Block navigation (previous/next)
        const navEl = document.getElementById('blockNav');
        if (navEl) {
            navEl.innerHTML = '';
            if (block.previous && block.previous !== '0000000000000000000000000000000000000000000000000000000000000000') {
                const prevBtn = document.createElement('button');
                prevBtn.className = 'btn-small';
                prevBtn.textContent = 'Previous Block';
                prevBtn.addEventListener('click', () => this.lookupBlock(block.previous));
                navEl.appendChild(prevBtn);
            }
            // Link to account
            if (block.account) {
                const accBtn = document.createElement('button');
                accBtn.className = 'btn-small';
                accBtn.textContent = 'View Account';
                accBtn.addEventListener('click', () => this.lookupAccount(block.account));
                navEl.appendChild(accBtn);
            }
        }

        this.emit('block:detail', block);
    },

    // =============================================
    // RICH LIST
    // =============================================
    async fetchRichList() {
        const container = document.getElementById('richlistContainer');
        if (!container) return;
        container.innerHTML = '<div class="feed-empty"><span class="spinner-inline"></span> Loading rich list...</div>';

        try {
            const res = await fetch(`${this.config.apiUrl}/api/v1/richlist`);
            if (!res.ok) {
                // Fallback: try to build from known accounts
                container.innerHTML = '<div class="feed-empty"><p>Rich list endpoint not available yet.</p><p class="feed-empty-sub">This feature requires the /api/v1/richlist endpoint on the node.</p></div>';
                return;
            }
            const data = await res.json();
            const accounts = Array.isArray(data) ? data : (data.richlist || data.accounts || []);
            this.renderRichList(accounts);
        } catch (error) {
            container.innerHTML = `<div class="feed-empty"><p style="color:var(--red)">Failed to load rich list</p><p class="feed-empty-sub">${this.escapeHtml(error.message)}</p></div>`;
        }
    },

    renderRichList(accounts) {
        const container = document.getElementById('richlistContainer');
        if (!container) return;
        container.innerHTML = '';

        if (!accounts || accounts.length === 0) {
            container.innerHTML = '<div class="feed-empty"><p>No accounts found</p></div>';
            return;
        }

        const table = document.createElement('div');
        table.className = 'richlist-table';

        // Header row
        table.innerHTML = `
            <div class="richlist-header">
                <span class="rl-rank">#</span>
                <span class="rl-address">Address</span>
                <span class="rl-balance">Balance</span>
                <span class="rl-pct">% Supply</span>
            </div>
        `;

        const totalSupply = 1000000000000000n; // 100,000,000 KNEX in raw

        accounts.forEach((acc, i) => {
            const row = document.createElement('div');
            row.className = 'richlist-row';

            const address = acc.account || acc.address || '';
            const balance = BigInt(acc.balance || '0');
            const pct = totalSupply > 0n ? (Number(balance * 10000n / totalSupply) / 100).toFixed(2) : '0.00';

            const isKnown = KnexAccount?.knownAccounts?.[address];
            const badge = isKnown ? ` <span class="known-badge-inline" style="color:${isKnown.color}">${isKnown.label}</span>` : '';

            row.innerHTML = `
                <span class="rl-rank">${i + 1}</span>
                <span class="rl-address"><span class="address-link" data-address="${this.escapeHtml(address)}">${this.truncateAddress(address)}</span>${badge}</span>
                <span class="rl-balance">${this.formatAmount(acc.balance || '0')} KNEX</span>
                <span class="rl-pct">${pct}%</span>
            `;

            const addrLink = row.querySelector('.address-link');
            addrLink?.addEventListener('click', () => {
                this.lookupAccount(address);
            });

            // Add identicon to rich list row
            if (addrLink && this.isValidAddress(address)) {
                this.createIdenticon(address, 16).then(icon => {
                    if (icon && addrLink.parentNode) {
                        addrLink.insertBefore(icon, addrLink.firstChild);
                    }
                });
            }

            table.appendChild(row);
        });

        container.appendChild(table);
    },

    // =============================================
    // BLOCK LIST
    // =============================================
    async fetchBlockList() {
        const container = document.getElementById('blocksContainer');
        if (!container) return;
        container.innerHTML = '<div class="feed-empty"><span class="spinner-inline"></span> Loading recent blocks...</div>';

        try {
            const res = await fetch(`${this.config.apiUrl}/api/v1/blocks/recent`);
            if (!res.ok) {
                // Use feed items as fallback
                if (this.state.feedItems.length > 0) {
                    this.renderBlockList(this.state.feedItems.slice(0, 50));
                } else {
                    container.innerHTML = '<div class="feed-empty"><p>Block list endpoint not available yet.</p><p class="feed-empty-sub">Blocks will appear in the live feed as they are confirmed.</p></div>';
                }
                return;
            }
            const data = await res.json();
            const blocks = Array.isArray(data) ? data : (data.blocks || []);
            this.renderBlockList(blocks);
        } catch (error) {
            // Fallback to feed items
            if (this.state.feedItems.length > 0) {
                this.renderBlockList(this.state.feedItems.slice(0, 50));
            } else {
                container.innerHTML = `<div class="feed-empty"><p>No blocks available yet</p></div>`;
            }
        }
    },

    renderBlockList(blocks) {
        const container = document.getElementById('blocksContainer');
        if (!container) return;
        container.innerHTML = '';

        if (!blocks || blocks.length === 0) {
            container.innerHTML = '<div class="feed-empty"><p>No blocks found</p></div>';
            return;
        }

        for (const block of blocks) {
            const el = document.createElement('div');
            el.className = 'feed-item block-list-item';

            const type = block.type || block.block_type || 'send';
            const typeClass = this.getTypeClass(type);
            const typeLabel = this.getTypeLabel(type);
            const hash = block.hash || '';
            const account = block.account || '';
            const amount = this.formatAmount(block.amount || block.balance || '0');
            const timeStr = this.formatTime(block.timestamp);

            el.innerHTML = `
                <div class="feed-type-badge ${typeClass}">${typeLabel.slice(0, 3).toUpperCase()}</div>
                <div class="feed-body">
                    <div class="feed-top-row">
                        <span class="feed-type-label">${typeLabel}</span>
                        <span class="feed-time">${timeStr}</span>
                    </div>
                    <div class="feed-address" data-address="${this.escapeHtml(account)}">${this.truncateAddress(account)}</div>
                    ${amount !== '0' ? `<div class="feed-amount">${amount} ${this.config.symbol}</div>` : ''}
                    <div class="feed-hash">${this.truncateHash(hash)}</div>
                </div>
            `;

            this.attachIdenticons(el);

            el.addEventListener('click', (e) => {
                const addrEl = e.target.closest('.feed-address');
                if (addrEl) {
                    e.stopPropagation();
                    const addr = addrEl.dataset.address;
                    if (addr && this.isValidAddress(addr)) this.lookupAccount(addr);
                    return;
                }
                if (hash) this.lookupBlock(hash);
            });

            container.appendChild(el);
        }
    },

    // =============================================
    // NODE STATS
    // =============================================
    async fetchNodeStats() {
        try {
            const res = await fetch(`${this.config.apiUrl}/api/v1/node`);
            if (res.ok) {
                const data = await res.json();
                document.getElementById('blockCount').textContent =
                    (data.block_count || 0).toLocaleString();
                document.getElementById('nodeUptime').textContent =
                    this.formatUptime(data.uptime_seconds || 0);
                // Account count (may not be returned by node)
                const accCount = document.getElementById('accountCount');
                if (accCount) {
                    accCount.textContent = data.account_count != null
                        ? (data.account_count || 0).toLocaleString()
                        : '--';
                }
                // Uptime may be 0 if not tracked by node
                if (!data.uptime_seconds) {
                    document.getElementById('nodeUptime').textContent = '--';
                }
            }
        } catch (e) {
            // Silently fail
        }
    },

    // =============================================
    // VIEW MANAGEMENT
    // =============================================
    showPanel(panelId) {
        // Clean up DAG visualizer when switching away from it
        if (typeof KnexVisualizer !== 'undefined' && panelId !== 'dagPanel' && KnexVisualizer.initialized) {
            KnexVisualizer.destroy();
        }

        const panels = ['liveFeedPanel', 'dagPanel', 'statsPanel', 'accountPanel', 'blockPanel', 'richListPanel', 'blocksPanel', 'corePanel'];
        panels.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.add('hidden');
        });

        const el = document.getElementById(panelId);
        if (el) el.classList.remove('hidden');

        const viewMap = {
            liveFeedPanel: 'feed',
            accountPanel: 'account',
            dagPanel: 'dag',
            statsPanel: 'stats',
            richListPanel: 'richlist',
            blocksPanel: 'blocks',
            corePanel: 'core',
        };
        this.state.currentView = viewMap[panelId] || 'block';

        // Scroll to top of main content
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },

    showFeed() {
        window.location.hash = '';
        this.showPanel('liveFeedPanel');
        document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
        const feedTab = document.getElementById('tabFeed');
        if (feedTab) feedTab.classList.add('active');
    },

    // =============================================
    // ERROR HANDLING & TOAST
    // =============================================
    showError(message) {
        const banner = document.getElementById('errorBanner');
        const text = document.getElementById('errorBannerText');
        if (banner && text) {
            text.textContent = message;
            banner.classList.remove('hidden');
        }
    },

    hideError() {
        const banner = document.getElementById('errorBanner');
        if (banner) banner.classList.add('hidden');
    },

    retryLastAction() {
        this.hideError();
        if (this.state.lastErrorAction) {
            this.state.lastErrorAction();
        }
    },

    showToast(message, type = 'info') {
        const container = document.getElementById('toastContainer');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;
        container.appendChild(toast);

        // Animate in
        requestAnimationFrame(() => toast.classList.add('show'));

        // Remove after 3s
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    },

    copyToClipboard(text) {
        navigator.clipboard.writeText(text).then(() => {
            this.showToast('Copied to clipboard', 'info');
        }).catch(() => {
            // Fallback for older browsers
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            this.showToast('Copied to clipboard', 'info');
        });
    },

    // =============================================
    // FORMATTING HELPERS
    // =============================================
    formatAmount(rawAmount) {
        try {
            const amount = BigInt(rawAmount);
            if (amount === 0n) return '0';
            const divisor = BigInt(10 ** this.config.decimals);
            const whole = amount / divisor;
            const fraction = amount % divisor;
            const absWhole = whole < 0n ? -whole : whole;
            const absFraction = fraction < 0n ? -fraction : fraction;
            const fractionStr = absFraction.toString().padStart(this.config.decimals, '0');
            let trimmed = fractionStr.replace(/0+$/, '');
            if (trimmed.length < 2) trimmed = fractionStr.slice(0, 2);

            // Add thousands separator
            const wholeStr = absWhole.toLocaleString();
            return `${wholeStr}.${trimmed}`;
        } catch {
            return rawAmount;
        }
    },

    formatTime(timestamp) {
        if (!timestamp) return '--';
        // Auto-detect ms vs seconds: if > 10 billion, it's milliseconds
        const ms = timestamp > 1e10 ? timestamp : timestamp * 1000;
        const date = new Date(ms);
        const now = Date.now();
        const diff = Math.floor((now - ms) / 1000);

        if (diff < 0) return 'just now';  // future timestamps (clock skew)
        if (diff < 5) return 'just now';
        if (diff < 60) return `${diff}s ago`;
        if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
        if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
        if (diff < 604800) return `${Math.floor(diff/86400)}d ago`;
        return date.toLocaleDateString();
    },

    formatFullTime(timestamp) {
        if (!timestamp) return '--';
        const ms = timestamp > 1e10 ? timestamp : timestamp * 1000;
        return new Date(ms).toLocaleString();
    },

    formatUptime(seconds) {
        if (!seconds) return '--';
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const mins = Math.floor((seconds % 3600) / 60);

        if (days > 0) return `${days}d ${hours}h`;
        if (hours > 0) return `${hours}h ${mins}m`;
        return `${mins}m`;
    },

    truncateHash(hash) {
        if (!hash) return '--';
        if (hash.length <= 20) return hash;
        return hash.slice(0, 10) + '...' + hash.slice(-8);
    },

    truncateAddress(addr) {
        if (!addr) return '--';
        if (addr.length <= 16) return addr;
        return addr.slice(0, 8) + '...' + addr.slice(-6);
    },

    getTypeClass(type) {
        switch (type) {
            case 'send': return 'send';
            case 'receive': return 'receive';
            case 'open': return 'open';
            case 'change': return 'change';
            case 'bandwidth': return 'bandwidth';
            case 'pending': return 'receive';
            default: return 'send';
        }
    },

    getTypeLabel(type) {
        switch (type) {
            case 'send': return 'Send';
            case 'receive': return 'Receive';
            case 'open': return 'Open';
            case 'change': return 'Change';
            case 'bandwidth': return 'Bandwidth';
            case 'pending': return 'Pending';
            default: return type || 'Unknown';
        }
    },

    escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    },
};

// Boot
document.addEventListener('DOMContentLoaded', () => Explorer.init());
