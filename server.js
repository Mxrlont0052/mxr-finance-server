const http = require('http');

// ── Storage en memoria + persistencia entre requests
let db = {
  transactions: [],
  goals: [],
  credits: []
};

const SECRET = process.env.SECRET_KEY || 'mxr2026pichincha';

function verifySecret(req) {
  return req.headers['x-mxr-secret'] === SECRET;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch(e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

function parseDeuna(text, subject) {
  const full = (text + ' ' + (subject || '')).replace(/\r/g, ' ');

  let amount = null;
  const montoMatch = full.match(/Monto\s+\$\s*([\d.]+,\d{2})\s*USD/i);
  if (montoMatch) amount = parseFloat(montoMatch[1].replace(/\./g,'').replace(',','.'));
  if (!amount) {
    const pagasteMatch = full.match(/Pagaste\s+\$\s*([\d.]+,\d{2})\s+a\s/i);
    if (pagasteMatch) amount = parseFloat(pagasteMatch[1].replace(/\./g,'').replace(',','.'));
  }
  if (!amount) {
    const fallback = full.match(/\$\s*([\d.]+,\d{2})\s*USD/i);
    if (fallback) amount = parseFloat(fallback[1].replace(/\./g,'').replace(',','.'));
  }

  let merchant = 'Pago DeUna';
  const benefMatch = full.match(/Nombre del beneficiario\s{2,}([^\n\t$]+)/i);
  if (benefMatch) merchant = benefMatch[1].trim().replace(/\s+/g,' ');
  if (merchant === 'Pago DeUna') {
    const pagasteNombre = full.match(/Pagaste\s+\$[\d.,]+\s+a\s+([^c]+?)\s+con\s+Deuna/i);
    if (pagasteNombre) merchant = pagasteNombre[1].trim().replace(/\s+/g,' ');
  }

  let type = 'gasto';
  if (/recibiste|te\s+transfiri[oó]|dep[oó]sito\s+recibido|ingreso/i.test(full)) type = 'ingreso';

  const exitoso = /Estado del pago\s+Exitoso/i.test(full) || !full.includes('Estado del pago');

  let cat = 'general';
  const m = merchant.toLowerCase();
  if (/uber|taxi|cabify|indriver|beat/i.test(m)) cat = 'transporte';
  else if (/kfc|mcdonalds|pizza|burger|sushi|restaurant|comida|cafe|coffee/i.test(m)) cat = 'comida';
  else if (/spotify|netflix|amazon|apple|google|disney/i.test(m)) cat = 'suscripcion';
  else if (/farmacia|clinica|hospital|medic|salud/i.test(m)) cat = 'salud';
  else if (/supermaxi|coral|tia|aki|santa maria|mercado/i.test(m)) cat = 'mercado';

  let date = new Date().toISOString();
  const fechaMatch = full.match(/Fecha\s+(\d{1,2}\s+\w+\s+\d{4})\s*[-–]\s*(\d{2})h(\d{2})/i);
  if (fechaMatch) {
    const meses = {ene:0,feb:1,mar:2,abr:3,may:4,jun:5,jul:6,ago:7,sep:8,oct:9,nov:10,dic:11};
    const parts = fechaMatch[1].toLowerCase().split(/\s+/);
    const d = parseInt(parts[0]), mes = meses[parts[1].slice(0,3)], y = parseInt(parts[2]);
    const h = parseInt(fechaMatch[2]), min = parseInt(fechaMatch[3]);
    if (!isNaN(d) && mes !== undefined && !isNaN(y)) date = new Date(y,mes,d,h,min).toISOString();
  }

  return { amount, merchant, type, cat, exitoso, date };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-mxr-secret');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = req.url.split('?')[0];

  // ── GET /data — app carga TODO el estado
  if (req.method === 'GET' && url === '/data') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, ...db }));
    return;
  }

  // ── POST /data — app guarda TODO el estado
  if (req.method === 'POST' && url === '/data') {
    if (!verifySecret(req)) { res.writeHead(401); res.end(JSON.stringify({ok:false,error:'Invalid secret'})); return; }
    const body = await parseBody(req);
    if (body.transactions !== undefined) db.transactions = body.transactions;
    if (body.goals !== undefined) db.goals = body.goals;
    if (body.credits !== undefined) db.credits = body.credits;
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── POST /webhook — Make.com manda emails aquí
  if (req.method === 'POST' && url === '/webhook') {
    if (!verifySecret(req)) { res.writeHead(401); res.end(JSON.stringify({ok:false,error:'Invalid secret'})); return; }
    const body = await parseBody(req);
    const { emailText, emailSubject } = body;
    if (!emailText) { res.writeHead(400); res.end(JSON.stringify({ok:false,error:'No emailText'})); return; }

    const parsed = parseDeuna(emailText, emailSubject);
    if (!parsed.exitoso) { res.writeHead(200); res.end(JSON.stringify({ok:false,reason:'No exitoso'})); return; }
    if (!parsed.amount || parsed.amount <= 0) { res.writeHead(200); res.end(JSON.stringify({ok:false,error:'No amount'})); return; }

    const isDuplicate = db.transactions.some(t => {
      const diff = Math.abs(new Date(t.date) - new Date(parsed.date));
      return t.amount === parsed.amount && t.desc === parsed.merchant && diff < 5*60*1000;
    });
    if (isDuplicate) { res.writeHead(200); res.end(JSON.stringify({ok:false,reason:'Duplicate'})); return; }

    const txn = {
      id: Date.now(), type: parsed.type, amount: parsed.amount,
      desc: parsed.merchant, cat: parsed.cat, date: parsed.date,
      source: 'deuna', emailSubject: emailSubject || ''
    };
    db.transactions.unshift(txn);
    if (db.transactions.length > 500) db.transactions = db.transactions.slice(0,500);

    console.log(`✅ ${parsed.type} $${parsed.amount} → ${parsed.merchant}`);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, transaction: txn }));
    return;
  }

  // ── DELETE /data — borrar todo
  if (req.method === 'DELETE' && url === '/data') {
    if (!verifySecret(req)) { res.writeHead(401); res.end(JSON.stringify({ok:false})); return; }
    db = { transactions: [], goals: [], credits: [] };
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── GET /ping
  if (url === '/ping') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, msg: 'MXR Finance 🎧', txns: db.transactions.length }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎧 MXR Finance server en puerto ${PORT}`));
