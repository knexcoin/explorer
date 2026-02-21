/**
 * KnexCoin Tetromino Identicon
 * Deterministic visual identity from wallet address.
 * Same address always produces the same pattern.
 */
const KnexIdenticon = (() => {
    const SHAPES = {
        'I': [[0,0],[1,0],[2,0],[3,0]],
        'O': [[0,0],[1,0],[0,1],[1,1]],
        'T': [[1,0],[0,1],[1,1],[2,1]],
        'S': [[1,0],[2,0],[0,1],[1,1]],
        'Z': [[0,0],[1,0],[1,1],[2,1]],
        'J': [[0,0],[0,1],[1,1],[2,1]],
        'L': [[2,0],[0,1],[1,1],[2,1]]
    };
    const NAMES = ['I','O','T','S','Z','J','L'];
    const COLORS = {
        'I': '#ff0000', 'O': '#ff8000', 'T': '#ffff00',
        'S': '#00ff00', 'Z': '#0000ff', 'J': '#4b0082', 'L': '#8b00ff'
    };

    // Generate all rotations
    function allOrientations() {
        const out = [];
        for (const [name, coords] of Object.entries(SHAPES)) {
            const seen = new Set();
            let cur = coords;
            for (let rot = 0; rot < 4; rot++) {
                const r = cur.map(([x,y]) => [y,-x]);
                const mx = Math.min(...r.map(p=>p[0])), my = Math.min(...r.map(p=>p[1]));
                const n = r.map(([x,y]) => [x-mx, y-my]).sort((a,b) => a[0]-b[0]||a[1]-b[1]);
                const k = JSON.stringify(n);
                if (!seen.has(k)) { seen.add(k); out.push({name, coords: n}); }
                cur = r;
            }
        }
        return out;
    }
    const ALL = allOrientations();

    // xorshift128 PRNG
    class RNG {
        constructor(bytes) {
            this.s = new Uint32Array(4);
            for (let i = 0; i < 4; i++) {
                const o = i * 4;
                this.s[i] = ((bytes[o]<<24)|(bytes[o+1]<<16)|(bytes[o+2]<<8)|bytes[o+3])>>>0;
                if (this.s[i] === 0) this.s[i] = 0x9E3779B9 + i;
            }
        }
        next() {
            let t = this.s[3]; t ^= t<<11; t ^= t>>>8;
            this.s[3]=this.s[2]; this.s[2]=this.s[1]; this.s[1]=this.s[0];
            let s0=this.s[0]; t ^= s0; t ^= s0>>>19; this.s[0]=t;
            return (t>>>0) / 0x100000000;
        }
        nextInt(max) { return Math.floor(this.next() * max); }
        shuffle(arr) {
            const a = [...arr];
            for (let i=a.length-1; i>0; i--) {
                const j = this.nextInt(i+1); [a[i],a[j]] = [a[j],a[i]];
            }
            return a;
        }
    }

    async function hmacSha256(key, data) {
        const enc = new TextEncoder();
        const k = typeof key === 'string' ? enc.encode(key) : key;
        const d = typeof data === 'string' ? enc.encode(data) : data;
        const ck = await crypto.subtle.importKey('raw', k, {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
        return new Uint8Array(await crypto.subtle.sign('HMAC', ck, d));
    }

    function tile(N, rng) {
        const board = Array.from({length:N}, () => Array(N).fill(null));
        for (let r=0; r<N; r++) {
            for (let c=0; c<N; c++) {
                if (board[r][c] !== null) continue;
                const shuffled = rng.shuffle(ALL);
                let placed = false;
                for (const shape of shuffled) {
                    if (!shape.coords.some(([dx,dy])=>dx===0&&dy===0)) continue;
                    const cells = shape.coords.map(([dx,dy])=>[r+dy,c+dx]);
                    const cellSet = new Set(cells.map(([rr,cc])=>rr*N+cc));
                    let ok = true;
                    for (const [rr,cc] of cells) {
                        if (rr<0||rr>=N||cc<0||cc>=N||board[rr][cc]!==null) { ok=false; break; }
                    }
                    if (!ok) continue;
                    for (const [rr,cc] of cells) {
                        for (const [dr,dc] of [[0,1],[1,0],[0,-1],[-1,0]]) {
                            const nr=rr+dr, nc=cc+dc;
                            if (nr>=0&&nr<N&&nc>=0&&nc<N&&board[nr][nc]===shape.name&&!cellSet.has(nr*N+nc)) { ok=false; break; }
                        }
                        if (!ok) break;
                    }
                    if (ok) {
                        for (const [rr,cc] of cells) board[rr][cc] = shape.name;
                        placed = true; break;
                    }
                }
                if (!placed && board[r][c] === null) {
                    const nbrs = new Set();
                    for (const [dr,dc] of [[0,1],[0,-1],[1,0],[-1,0]]) {
                        const nr=r+dr, nc=c+dc;
                        if (nr>=0&&nr<N&&nc>=0&&nc<N&&board[nr][nc]) nbrs.add(board[nr][nc]);
                    }
                    let pick = NAMES[rng.nextInt(7)];
                    for (let t=0;t<7;t++) { if(!nbrs.has(pick)) break; pick=NAMES[(NAMES.indexOf(pick)+1)%7]; }
                    board[r][c] = pick;
                }
            }
        }
        return board;
    }

    function draw(canvas, board, N, scale) {
        const ctx = canvas.getContext('2d');
        canvas.width = N * scale;
        canvas.height = N * scale;
        ctx.fillStyle = '#0b0f1a';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        for (let r=0; r<N; r++) {
            for (let c=0; c<N; c++) {
                const name = board[r][c];
                if (!name) continue;
                ctx.fillStyle = COLORS[name];
                ctx.fillRect(c*scale, r*scale, scale, scale);
            }
        }
    }

    /**
     * Generate identicon into a container element.
     * @param {string} address - KnexCoin 50-char Base62 address
     * @param {string|HTMLElement} container - Container ID or element
     * @param {number} [size=120] - Canvas display size in CSS pixels
     */
    async function generate(address, container, size) {
        if (!address) return;
        size = size || 120;
        const N = 12;
        const scale = 4;
        const seedBytes = await hmacSha256(address, 'knex-identicon-v1');
        const rng = new RNG(seedBytes);
        const board = tile(N, rng);

        const el = typeof container === 'string' ? document.getElementById(container) : container;
        if (!el) return;
        el.innerHTML = '';
        const canvas = document.createElement('canvas');
        canvas.style.width = size + 'px';
        canvas.style.height = size + 'px';
        canvas.style.imageRendering = 'pixelated';
        canvas.style.borderRadius = '12px';
        draw(canvas, board, N, scale);
        el.appendChild(canvas);
    }

    return { generate };
})();
