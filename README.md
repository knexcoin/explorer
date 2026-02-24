# Knexplorer

Real-time block explorer for the KnexCoin network.

**Live:** [https://knexplorer.com](https://knexplorer.com)

## Features

- Live WebSocket feed of confirmed blocks
- Account lookup with balance, history, and pending receivables
- Block detail view with full metadata
- Rich list (top 100 accounts by balance)
- Recent blocks across all accounts
- Keyboard shortcuts (`/` search, `T` theme, `?` help)
- Pagination and filtering
- Toast notifications
- Auto-reconnecting WebSocket with exponential backoff
- Audio feedback (Web Audio API generated tones)

## Configuration

The explorer connects to the KnexCoin node API:

```javascript
// explorer.js
config: {
    apiUrl: 'https://mainnet.knexpay.com',
    wsUrl: 'wss://mainnet.knexpay.com/ws',
    decimals: 7,
    symbol: 'KNEX',
}
```

## API Endpoints Used

| Endpoint | View |
|----------|------|
| `GET /api/v1/account/:address` | Account detail |
| `GET /account/:address/history` | Transaction history |
| `GET /api/v1/block/:hash` | Block detail |
| `GET /api/v1/richlist` | Rich list tab |
| `GET /api/v1/blocks/recent` | Recent blocks tab |
| `GET /api/v1/node` | Header stats |
| `WS /ws` | Live feed |

## Files

| File | Purpose |
|------|---------|
| `index.html` | Explorer UI (single-page) |
| `explorer.js` | Core logic, API calls, WebSocket |
| `explorer.css` | Dark theme, neon accents |
| `audio.js` | Web Audio API sound effects |

## Deployment

Static files — deploy to any CDN or hosting (Cloudflare Pages, Vercel, IPFS).

```bash
# Local development
python3 -m http.server 8000
# Open http://localhost:8000
```

## Address Format

KnexCoin addresses are **50-character Base62** strings (case-sensitive: `0-9`, `A-Z`, `a-z`) with a 5-byte SHA-256 prefix-bound checksum.

Example: `8UtJC7GQUt85vFGuTw8o02NO7NRPAJs2yzgBJ9SOytyKPbgKvF`

## License

MIT
