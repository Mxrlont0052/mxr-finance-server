const http = require('http');

let transactions = [];
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

// ── DeUna / Banco Pichincha parser
// Formato real del correo:
//   "Pagaste $4,60 a Jose Luis Barreno Quincha con Deuna!"
//   "Monto   $4,60 USD"
//   "Nombre del beneficiario   Jose Luis Barreno Quincha"
//   "Estado del pago   Exitoso"
function parseDeuna(text, subject) {
  const full = (text + ' ' + (subject || '')).replace(/\r/g, ' ');

  // ── 1. MONTO
  // DeUna usa coma decimal: $4,60 USD  o  $1.200,50 USD
  let amount = null;

  // Patrón principal: "Monto   $X,XX USD"
  const montoMatch = full.match(/Monto\s+\$\s*([\d.]+,\d{2})\s*USD/i);
  if (montoMatch) {
    amount = parseFloat(montoMatch[1].replace(/\./g, '').replace(',', '.'));
  }

  // Patrón secundario: "Pagaste $X,XX a"
  if (!amount) {
    const pagasteMatch = full.match(/Pagaste\s+\$\s*([\d.]+,\d{2})\s+a\s/i);
    if (pagasteMatch) {
      amount = parseFloat(pagasteMatch[1].replace(/\./g, '').replace(',', '.'));
    }
  }

  // Patrón fallback: cualquier $X,XX USD
  if (!amount) {
    const fallback = full.match(/\$\s*([\d.]+,\d{2})\s*USD/i);
    if (fallback) {
      amount = parseFloat(fallback[1].replace(/\./g, '').replace(',', '.'));
    }
  }

  // ── 2. BENEFICIARIO / COMERCIO
  let merchant = 'Pago DeUna';

  // "Nombre del beneficiario   Jose Luis Barreno Quincha"
  const benefMatch = full.match(/Nombre del beneficiario\s{2,}([^\n\t$]+)/i);
  if (benefMatch) {
    merchant = benefMatch[1].trim().replace(/\s+/g, ' ');
  }

  // "Pagaste $X,XX a NOMBRE con Deuna"
  if (merchant === 'Pago DeUna') {
    const pagasteNombre = full.match(/Pagaste\s+\$[\d.,]+\s+a\s+([^c]+?)\s+con\s+Deuna/i);
    if (pagasteNombre) {
      merchant = pagasteNombre[1].trim().replace(/\s+/g, ' ');
    }
  }

  // ── 3. TIPO: gasto o ingreso
  // DeUna: "Pagaste" = gasto, "Recibiste" = ingreso
  let type = 'gasto';
  if (/recibiste|te\s+transfiri[oó]|dep[oó]sito\s+recibido|ingreso/i.test(full)) {
    type = 'ingreso';
  }

  // ── 4. ESTADO — solo procesar si es Exitoso
  const exitoso = /Estado del pago\s+Exitoso/i.test(full) ||
                  /estado.*exitoso/i.test(full) ||
                  !full.includes('Estado del pago'); // si no hay estado, asumir ok

  // ── 5. CATEGORÍA por nombre de beneficiario
  let cat = 'general';
  const m = merchant.toLowerCase();
  if (/uber|taxi|cabify|indriver|beat/i.test(m)) cat = 'transporte';
  else if (/kfc|mcdonalds|pizza|burger|sushi|restaurant|comida|cafe|coffee|heladeria/i.test(m)) cat = 'comida';
  else if (/spotify|netflix|amazon|apple|google|disney|crunchyroll/i.test(m)) cat = 'suscripcion';
  else if (/farmacia|clinica|hospital|medic|salud|dental/i.test(m)) cat = 'salud';
  else if (/supermaxi|coral|tia|aki|santa maria|mercado|supermer/i.test(m)) cat = 'mercado';

  // ── 6. FECHA desde el correo
  // "10 jun 2026 - 14h22"
  let date = new Date().toISOString();
  const fechaMatch = full.match(/Fecha\s+(\d{1,2}\s+\w+\s+\d{4})\s*[-–]\s*(\d{2})h(\d{2})/i);
  if (fechaMatch) {
    const meses = {ene:0,feb:1,mar:2,abr:3,may:4,jun:5,jul:6,ago:7,sep:8,oct:9,nov:10,dic:11};
    const parts = fechaMatch[1].toLowerCase().split(/\s+/);
    const d = parseInt(parts[0]);
    const mes = meses[parts[1].slice(0,3)];
    const y = parseInt(parts[2]);
    const h = parseInt(fechaMatch[2]);
    const min = parseInt(fechaMatch[3]);
    if (!isNaN(d) && mes !== undefined && !isNaN(y)) {
      date = new Date(y, mes, d, h, min).toISOString();
    }
  }

  return { amount, merchant, type, cat, exitoso, date };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-mxr-secret');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = req.url.split('?')[0];

  // ── GET /transactions
  if (req.method === 'GET' && url === '/transactions') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, transactions, count: transactions.length }));
    return;
  }

  // ── POST /webhook — Make.com manda el email aquí
  if (req.method === 'POST' && url === '/webhook') {
    if (!verifySecret(req)) {
      res.writeHead(401);
      res.end(JSON.stringify({ ok: false, error: 'Invalid secret' }));
      return;
    }

    const body = await parseBody(req);
    const { emailText, emailSubject } = body;

    if (!emailText) {
      res.writeHead(400);
      res.end(JSON.stringify({ ok: false, error: 'No emailText provided' }));
      return;
    }

    const parsed = parseDeuna(emailText, emailSubject);

    // Ignorar si no es exitoso
    if (!parsed.exitoso) {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: false, reason: 'Transacción no exitosa, ignorada' }));
      return;
    }

    if (!parsed.amount || parsed.amount <= 0) {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: false, error: 'No se detectó monto', preview: emailText.slice(0, 300) }));
      return;
    }

    // Evitar duplicados por mismo monto + beneficiario + fecha cercana (±5min)
    const isDuplicate = transactions.some(t => {
      const timeDiff = Math.abs(new Date(t.date) - new Date(parsed.date));
      return t.amount === parsed.amount &&
             t.desc === parsed.merchant &&
             timeDiff < 5 * 60 * 1000;
    });

    if (isDuplicate) {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: false, reason: 'Duplicado ignorado' }));
      return;
    }

    const txn = {
      id: Date.now(),
      type: parsed.type,
      amount: parsed.amount,
      desc: parsed.merchant,
      cat: parsed.cat,
      date: parsed.date,
      source: 'deuna',
      emailSubject: emailSubject || ''
    };

    transactions.unshift(txn);
    if (transactions.length > 500) transactions = transactions.slice(0, 500);

    console.log(`[${new Date().toISOString()}] ✅ ${parsed.type} $${parsed.amount} → ${parsed.merchant} (${parsed.cat})`);

    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, transaction: txn }));
    return;
  }

  // ── GET /ping
  if (url === '/ping') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, msg: 'MXR Finance server 🎧', txns: transactions.length, uptime: process.uptime() }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎧 MXR Finance server en puerto ${PORT}`);
});
