/**
 * KnexAudio — Sound effects for live block events
 * Uses Web Audio API to generate tones (no audio files needed)
 * Default: muted (opt-in)
 *
 * v2: Volume control, better tone design, graceful degradation
 */
const KnexAudio = {
    ctx: null,
    muted: true,
    volume: 0.15,

    // Tone map: block type -> { freq, duration, type }
    tones: {
        send:      { freq: 660,  duration: 0.08, type: 'triangle' },
        receive:   { freq: 880,  duration: 0.10, type: 'sine' },
        open:      { freq: 1100, duration: 0.12, type: 'sine' },
        change:    { freq: 440,  duration: 0.06, type: 'square' },
        bandwidth: { freq: 330,  duration: 0.06, type: 'sawtooth' },
        pending:   { freq: 550,  duration: 0.05, type: 'triangle' },
    },

    init() {
        this.muted = localStorage.getItem('knexplorer-muted') !== 'false';
        this.updateIcon();

        const btn = document.getElementById('soundToggle');
        if (btn) {
            btn.addEventListener('click', () => {
                this.muted = !this.muted;
                localStorage.setItem('knexplorer-muted', String(this.muted));
                this.updateIcon();

                // Create AudioContext on first user gesture (browser requirement)
                if (!this.muted && !this.ctx) {
                    try {
                        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
                    } catch (e) {
                        console.warn('[Audio] AudioContext not available:', e);
                    }
                }

                if (!this.muted) {
                    Explorer.showToast('Sound enabled', 'info');
                    this.playTone(this.tones.open); // Confirmation beep
                }
            });
        }

        // Listen for blocks
        Explorer.on('block', (data) => {
            const type = data.block_type || 'send';
            this.play(type);
        });
    },

    play(type) {
        if (this.muted || !this.ctx) return;

        const tone = this.tones[type] || this.tones.send;
        this.playTone(tone);
    },

    playTone({ freq, duration, type }) {
        if (!this.ctx) return;

        try {
            // Resume if suspended (browser autoplay policy)
            if (this.ctx.state === 'suspended') {
                this.ctx.resume();
            }

            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();

            osc.type = type;
            osc.frequency.value = freq;

            gain.gain.setValueAtTime(this.volume, this.ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);

            osc.connect(gain);
            gain.connect(this.ctx.destination);

            osc.start(this.ctx.currentTime);
            osc.stop(this.ctx.currentTime + duration + 0.05);

            // Cleanup
            osc.onended = () => {
                osc.disconnect();
                gain.disconnect();
            };
        } catch (e) {
            // Silently fail
        }
    },

    updateIcon() {
        const btn = document.getElementById('soundToggle');
        const icon = document.getElementById('soundIcon');
        if (!btn || !icon) return;

        btn.title = this.muted ? 'Toggle sound (off)' : 'Toggle sound (on)';

        if (this.muted) {
            icon.innerHTML =
                '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>' +
                '<line x1="23" y1="9" x2="17" y2="15"/>' +
                '<line x1="17" y1="9" x2="23" y2="15"/>';
        } else {
            icon.innerHTML =
                '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>' +
                '<path d="M19.07 4.93a10 10 0 010 14.14"/>' +
                '<path d="M15.54 8.46a5 5 0 010 7.07"/>';
        }
    }
};
