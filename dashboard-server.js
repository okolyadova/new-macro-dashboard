// Local and deployable server for the financial dashboard.
// Keep EODHD_API_TOKEN in the server environment, never in index.html.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
const HTML = path.join(__dirname, 'index.html');
const PRIVATE_TOKEN_FILE = path.join(__dirname, '..', 'work', '.eodhd-token');
const token = process.env.EODHD_API_TOKEN ||
  (fs.existsSync(PRIVATE_TOKEN_FILE) ? fs.readFileSync(PRIVATE_TOKEN_FILE, 'utf8').trim() : '');
const cache = new Map();

function upstream(requestUrl) {
  const u = new URL(requestUrl, `http://${HOST}:${PORT}`);
  const q = u.searchParams;
  switch (u.pathname) {
    case '/api/cbr/daily': {
      const out = new URL('https://www.cbr.ru/scripts/XML_daily.asp');
      out.searchParams.set('date_req', q.get('date_req') || '');
      return out;
    }
    case '/api/cbr/key':
      return new URL('https://www.cbr.ru/DailyInfoWebServ/DailyInfo.asmx');
    case '/api/boc': {
      const out = new URL('https://www.bankofcanada.ca/valet/observations/FXCADUSD/json');
      for (const key of ['start_date', 'end_date']) if (q.has(key)) out.searchParams.set(key, q.get(key));
      return out;
    }
    case '/api/moex': {
      const out = new URL('https://iss.moex.com/iss/history/engines/stock/markets/shares/boards/TQBR/securities/RENI.json');
      for (const key of ['from', 'till', 'iss.only', 'history.columns', 'iss.meta'])
        if (q.has(key)) out.searchParams.set(key, q.get(key));
      return out;
    }
    case '/api/eod/history': {
      const out = new URL('https://eodhd.com/api/eod/CURA.TO');
      for (const key of ['from', 'to', 'fmt', 'period', 'order'])
        if (q.has(key)) out.searchParams.set(key, q.get(key));
      out.searchParams.set('api_token', token);
      return out;
    }
    case '/api/eod/shares': {
      const out = new URL('https://eodhd.com/api/v1.1/fundamentals/CURA.TO');
      out.searchParams.set('filter', 'outstandingShares');
      out.searchParams.set('api_token', token);
      return out;
    }
    default:
      return null;
  }
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${HOST}:${PORT}`);
  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
    fs.createReadStream(HTML).pipe(res);
    return;
  }
  const target = upstream(req.url);
  if (!target) { res.writeHead(404); res.end('Not found'); return; }
  if (parsed.pathname.startsWith('/api/eod/') && !token) {
    res.writeHead(503, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({error: 'EODHD token is not configured on the server'}));
    return;
  }
  try {
    const method = parsed.pathname === '/api/cbr/key' ? 'POST' : 'GET';
    const cacheKey = method === 'GET' ? target.toString() : null;
    const hit = cacheKey && cache.get(cacheKey);
    if (hit && Date.now() - hit.time < 15 * 60 * 1000) {
      res.writeHead(hit.status, hit.headers); res.end(hit.body); return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await fetch(target, {
      method,
      headers: method === 'POST'
        ? {'Content-Type': 'text/xml; charset=utf-8', SOAPAction: 'http://web.cbr.ru/KeyRateXML'}
        : {},
      body: method === 'POST' ? Buffer.concat(chunks) : undefined,
      signal: AbortSignal.timeout(15000)
    });
    const body = Buffer.from(await response.arrayBuffer());
    const headers = {
      'Content-Type': response.headers.get('content-type') || 'application/octet-stream',
      'Cache-Control': 'no-store'
    };
    if (cacheKey && response.ok) cache.set(cacheKey, {time: Date.now(), status: response.status, headers, body});
    res.writeHead(response.status, headers);
    res.end(body);
  } catch (error) {
    res.writeHead(502, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({error: 'Data provider request failed'}));
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`Dashboard: http://${HOST}:${PORT}\n`);
});
