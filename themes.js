/**
 * KnexTheme — Dark/Light theme toggle
 * Features:
 * - Persists preference to localStorage
 * - Respects prefers-color-scheme (system theme detection)
 * - Smooth transitions between themes
 */
const KnexTheme = {
    init() {
        // 1. Check localStorage
        const saved = localStorage.getItem('knexplorer-theme');

        // 2. If no saved preference, detect system theme
        let theme;
        if (saved) {
            theme = saved;
        } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
            theme = 'light';
        } else {
            theme = 'dark';
        }

        this.apply(theme);

        // 3. Listen for system theme changes (if no user preference saved)
        if (window.matchMedia) {
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
                if (!localStorage.getItem('knexplorer-theme')) {
                    this.apply(e.matches ? 'dark' : 'light');
                }
            });
        }

        // 4. Toggle button
        const btn = document.getElementById('themeToggle');
        if (btn) {
            btn.addEventListener('click', () => {
                const current = document.documentElement.dataset.theme || 'dark';
                const next = current === 'dark' ? 'light' : 'dark';
                this.apply(next);
                localStorage.setItem('knexplorer-theme', next);
            });
        }
    },

    apply(theme) {
        document.documentElement.dataset.theme = theme;

        // Update meta theme-color for mobile browsers
        const metaTheme = document.querySelector('meta[name="theme-color"]');
        if (metaTheme) {
            metaTheme.content = theme === 'light' ? '#f5f5f5' : '#000000';
        }

        const icon = document.getElementById('themeIcon');
        if (!icon) return;

        if (theme === 'light') {
            // Sun icon
            icon.innerHTML = '<circle cx="12" cy="12" r="5"/>' +
                '<line x1="12" y1="1" x2="12" y2="3"/>' +
                '<line x1="12" y1="21" x2="12" y2="23"/>' +
                '<line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>' +
                '<line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>' +
                '<line x1="1" y1="12" x2="3" y2="12"/>' +
                '<line x1="21" y1="12" x2="23" y2="12"/>' +
                '<line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>' +
                '<line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
        } else {
            // Moon icon
            icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
        }
    }
};
