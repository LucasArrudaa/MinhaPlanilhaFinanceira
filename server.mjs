import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize, relative as relativePath, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
await mkdir(DATA_DIR, { recursive: true });
const db = new DatabaseSync(join(DATA_DIR, 'financas.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, type TEXT NOT NULL, initial_cents INTEGER NOT NULL DEFAULT 0,
    reference_date TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS investments (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, type TEXT NOT NULL, institution TEXT NOT NULL DEFAULT '',
    initial_cents INTEGER NOT NULL DEFAULT 0, current_cents INTEGER NOT NULL DEFAULT 0,
    applied_on TEXT NOT NULL, notes TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS movements (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL, cents INTEGER NOT NULL,
    date TEXT NOT NULL, due_date TEXT, paid_date TEXT, account_id INTEGER NOT NULL REFERENCES accounts(id),
    destination_id INTEGER REFERENCES accounts(id), investment_id INTEGER REFERENCES investments(id),
    payment_method TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'paga',
    recurring INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', target_cents INTEGER NOT NULL,
    saved_cents INTEGER NOT NULL DEFAULT 0, start_date TEXT NOT NULL, deadline TEXT
  );
  CREATE TABLE IF NOT EXISTS budgets (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    month TEXT NOT NULL, category TEXT NOT NULL, limit_cents INTEGER NOT NULL,
    UNIQUE(user_id, month, category)
  );
  CREATE INDEX IF NOT EXISTS movements_user_date ON movements(user_id, date);
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
`);

const categories = {
  receita: ['Salário', 'Bolsa de estágio', 'Trabalhos extras', 'Serviços prestados', 'Comissões', 'Reembolsos', 'Rendimentos', 'Outras entradas'],
  despesa: ['Aluguel', 'Alimentação', 'Transporte', 'Moradia', 'Água', 'Energia elétrica', 'Internet', 'Telefone', 'Educação', 'Saúde', 'Lazer', 'Compras', 'Assinaturas', 'Cartão de crédito', 'Parcelamentos', 'Outras despesas'],
  investimento: ['Reserva de emergência', 'CDB', 'Tesouro Direto', 'Ações', 'Fundos imobiliários', 'Fundos de investimento', 'ETFs', 'Criptomoedas', 'Outros investimentos'],
  account: ['Conta bancária', 'Carteira digital', 'Dinheiro em espécie', 'Conta de investimento']
};
const todayInBrazil = () => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
};
const json = (res, status, data, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
};
function seedBootstrapUser({ name, email, password }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedName = String(name || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) throw new Error('BOOTSTRAP_EMAIL deve conter um endereço de e-mail válido.');
  if (normalizedName.length < 2 || normalizedName.length > 80) throw new Error('BOOTSTRAP_NAME deve ter entre 2 e 80 caracteres.');
  if (String(password || '').length < 10) throw new Error('BOOTSTRAP_PASSWORD deve ter pelo menos 10 caracteres.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(normalizedEmail)) return false;

  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  const result = db.prepare('INSERT INTO users(name,email,password_hash) VALUES(?,?,?)')
    .run(normalizedName, normalizedEmail, `${salt.toString('hex')}:${hash.toString('hex')}`);
  return Number(result.lastInsertRowid);
}
const fail = (status, message) => Object.assign(new Error(message), { status });
const parseBody = async (req) => {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64_000) throw fail(413, 'O envio ultrapassou o limite permitido.');
  }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw fail(400, 'Os dados enviados não são válidos.'); }
};
const validDate = (value, optional = false) => {
  if (optional && !value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const centsFrom = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 99_999_999_999) throw fail(400, 'Informe um valor maior que zero e válido.');
  return Math.round(number * 100);
};
const nonNegativeCentsFrom = (value) => {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0 || number > 99_999_999_999) throw fail(400, 'Informe um valor válido e não negativo.');
  return Math.round(number * 100);
};
const cookieValue = (req, name) => (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
const ownerRow = (table, id, userId) => db.prepare(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`).get(id, userId);
const getUser = (req) => {
  const token = cookieValue(req, 'sessao');
  if (!token) return null;
  const key = createHash('sha256').update(decodeURIComponent(token)).digest('hex');
  const session = db.prepare('SELECT user_id, csrf FROM sessions WHERE token_hash = ? AND expires_at > ?').get(key, Date.now());
  return session ? { id: session.user_id, csrf: session.csrf } : null;
};
const requireUser = (req) => {
  const user = getUser(req);
  if (!user) throw fail(401, 'Sua sessão expirou. Entre novamente para continuar.');
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.headers['x-csrf-token'] !== user.csrf) {
    throw fail(403, 'Não foi possível validar esta solicitação. Atualize a página e tente novamente.');
  }
  return user;
};
const accountBalance = (userId, account) => {
  const rows = db.prepare(`SELECT type, status, cents, account_id, destination_id FROM movements WHERE user_id = ? AND (account_id = ? OR destination_id = ?)`).all(userId, account.id, account.id);
  let balance = account.initial_cents;
  for (const row of rows) {
    if (row.status !== 'paga') continue;
    if (row.type === 'receita' && row.account_id === account.id) balance += row.cents;
    if (row.type === 'despesa' && row.account_id === account.id) balance -= row.cents;
    if (row.type === 'transferencia') {
      if (row.account_id === account.id) balance -= row.cents;
      if (row.destination_id === account.id) balance += row.cents;
    }
      if (row.type === 'aporte' && row.account_id === account.id) balance -= row.cents;
      if (row.type === 'resgate' && row.account_id === account.id) balance += row.cents;
  }
  return balance;
};
const listAccounts = (userId) => db.prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY id').all(userId).map((account) => ({
  ...account, balance_cents: accountBalance(userId, account)
}));
const monthRange = (month) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) throw fail(400, 'Informe um mês válido no formato AAAA-MM.');
  return month;
};

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ok: true });
  if (req.method === 'POST' && ['/api/cadastro', '/api/entrar'].includes(path)) {
    const body = await parseBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10 || password.length > 200) {
      throw fail(400, 'Informe um e-mail válido e uma senha com pelo menos 10 caracteres.');
    }
    let user;
    if (path === '/api/cadastro') {
      const name = String(body.name || '').trim();
      if (name.length < 2 || name.length > 80) throw fail(400, 'Informe seu nome (de 2 a 80 caracteres).');
      const salt = randomBytes(16);
      const hash = scryptSync(password, salt, 64);
      try {
        const result = db.prepare('INSERT INTO users(name,email,password_hash) VALUES(?,?,?)').run(name, email, `${salt.toString('hex')}:${hash.toString('hex')}`);
        user = { id: Number(result.lastInsertRowid), name, email };
      } catch (error) {
        if (error.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE') throw fail(409, 'Já existe uma conta com este e-mail.');
        throw error;
      }
    } else {
      user = db.prepare('SELECT id,name,email,password_hash FROM users WHERE email = ?').get(email);
      if (!user) throw fail(401, 'E-mail ou senha incorretos.');
      const [saltHex, hashHex] = user.password_hash.split(':');
      const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
      if (!timingSafeEqual(actual, Buffer.from(hashHex, 'hex'))) throw fail(401, 'E-mail ou senha incorretos.');
    }
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)')
      .run(createHash('sha256').update(token).digest('hex'), user.id, csrf, Date.now() + 30 * 24 * 60 * 60 * 1000);
    return json(res, 200, { user: { id: user.id, name: user.name, email: user.email }, csrf }, {
      'Set-Cookie': `sessao=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
    });
  }
  if (req.method === 'POST' && path === '/api/sair') {
    const token = cookieValue(req, 'sessao');
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(createHash('sha256').update(decodeURIComponent(token)).digest('hex'));
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'sessao=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (!path.startsWith('/api/')) return serveStatic(path, res);
  const user = requireUser(req);
  if (req.method === 'GET' && path === '/api/eu') return json(res, 200, { user: db.prepare('SELECT id,name,email FROM users WHERE id=?').get(user.id), csrf: user.csrf });
  if (path === '/api/categorias' && req.method === 'GET') return json(res, 200, categories);
  if (path === '/api/contas' && req.method === 'GET') return json(res, 200, listAccounts(user.id));
  if (path === '/api/contas' && req.method === 'POST') {
    const body = await parseBody(req);
    const name = String(body.name || '').trim();
    const type = String(body.type || '');
    const openingBalance = Number(body.initial_balance || 0);
    if (!Number.isFinite(openingBalance) || openingBalance < 0 || openingBalance > 99_999_999_999) throw fail(400, 'Informe um saldo inicial válido e não negativo.');
    if (name.length < 2 || name.length > 80 || !categories.account.includes(type) || !validDate(body.reference_date)) throw fail(400, 'Confira o nome, o tipo e a data de referência da conta.');
    const result = db.prepare('INSERT INTO accounts(user_id,name,type,initial_cents,reference_date) VALUES(?,?,?,?,?)')
      .run(user.id, name, type, Math.round(openingBalance * 100), body.reference_date);
    return json(res, 201, ownerRow('accounts', result.lastInsertRowid, user.id));
  }
  const accountRoute = path.match(/^\/api\/contas\/(\d+)$/);
  if (accountRoute) {
    const id = Number(accountRoute[1]);
    const account = ownerRow('accounts', id, user.id);
    if (!account) throw fail(404, 'Conta financeira não encontrada.');
    if (req.method === 'PUT') {
      const body = await parseBody(req);
      const name = String(body.name || '').trim();
      if (name.length < 2 || !categories.account.includes(body.type) || !validDate(body.reference_date)) throw fail(400, 'Confira os dados da conta financeira.');
      const openingBalance = Number(body.initial_balance || 0);
      if (!Number.isFinite(openingBalance) || openingBalance < 0 || openingBalance > 99_999_999_999) throw fail(400, 'Informe um saldo inicial válido e não negativo.');
      db.prepare('UPDATE accounts SET name=?,type=?,initial_cents=?,reference_date=? WHERE id=? AND user_id=?')
        .run(name, body.type, Math.round(openingBalance * 100), body.reference_date, id, user.id);
      return json(res, 200, ownerRow('accounts', id, user.id));
    }
    if (req.method === 'DELETE') {
      if (db.prepare('SELECT 1 FROM movements WHERE account_id=? OR destination_id=? LIMIT 1').get(id, id)) throw fail(409, 'Esta conta possui movimentações e não pode ser excluída.');
      db.prepare('DELETE FROM accounts WHERE id=? AND user_id=?').run(id, user.id);
      return json(res, 200, { ok: true });
    }
  }
  if (path === '/api/movimentacoes' && req.method === 'GET') {
    const filters = ['m.user_id = ?'];
    const args = [user.id];
    for (const [key, column] of [['inicio', 'm.date >= ?'], ['fim', 'm.date <= ?'], ['tipo', 'm.type = ?'], ['situacao', 'm.status = ?'], ['categoria', 'm.category = ?']]) {
      const value = url.searchParams.get(key);
      if (value) { filters.push(column); args.push(value); }
    }
    return json(res, 200, db.prepare(`SELECT m.*, a.name AS account_name, d.name AS destination_name, i.name AS investment_name
      FROM movements m JOIN accounts a ON a.id=m.account_id LEFT JOIN accounts d ON d.id=m.destination_id
      LEFT JOIN investments i ON i.id=m.investment_id WHERE ${filters.join(' AND ')} ORDER BY m.date DESC,m.id DESC`).all(...args));
  }
  if (path === '/api/movimentacoes' && req.method === 'POST') {
    const body = await parseBody(req);
    return json(res, 201, saveMovement(user.id, body), {});
  }
  if (path === '/api/importacao' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!Array.isArray(body.movements) || body.movements.length < 1 || body.movements.length > 100) {
      throw fail(400, 'Envie entre 1 e 100 movimentações para importar.');
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const imported = body.movements.map((item) => saveMovement(user.id, {
        ...item,
        date: item.date || todayInBrazil(),
        status: item.status || 'paga',
        notes: item.notes || 'Importado de arquivo CSV.'
      }));
      db.exec('COMMIT');
      return json(res, 201, { imported: imported.length });
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const movementRoute = path.match(/^\/api\/movimentacoes\/(\d+)$/);
  if (movementRoute) {
    const id = Number(movementRoute[1]);
    if (!ownerRow('movements', id, user.id)) throw fail(404, 'Movimentação não encontrada.');
    if (req.method === 'PUT') return json(res, 200, saveMovement(user.id, await parseBody(req), id));
    if (req.method === 'DELETE') {
      db.prepare('DELETE FROM movements WHERE id=? AND user_id=?').run(id, user.id);
      return json(res, 200, { ok: true });
    }
  }
  if (path === '/api/investimentos' && req.method === 'GET') {
    return json(res, 200, db.prepare(`SELECT i.*,
      i.current_cents + COALESCE(SUM(CASE WHEN m.type='aporte' THEN m.cents WHEN m.type='resgate' THEN -m.cents WHEN m.type='rendimento' THEN m.cents ELSE 0 END),0) AS balance_cents,
      COALESCE(SUM(CASE WHEN m.type='aporte' THEN m.cents ELSE 0 END),0) AS contributions_cents
      FROM investments i LEFT JOIN movements m ON m.investment_id=i.id AND m.status='paga'
      WHERE i.user_id=? GROUP BY i.id ORDER BY i.name`).all(user.id));
  }
  if (path === '/api/investimentos' && req.method === 'POST') {
    const body = await parseBody(req);
    const name = String(body.name || '').trim();
    if (name.length < 2 || name.length > 80 || !categories.investimento.includes(body.type) || !validDate(body.applied_on)) throw fail(400, 'Confira o nome, o tipo e a data do investimento.');
    const applied = nonNegativeCentsFrom(body.applied_value);
    const current = nonNegativeCentsFrom(body.current_value);
    const result = db.prepare('INSERT INTO investments(user_id,name,type,institution,initial_cents,current_cents,applied_on,notes) VALUES(?,?,?,?,?,?,?,?)')
      .run(user.id, name, body.type, String(body.institution || '').slice(0, 100), applied, current, body.applied_on, String(body.notes || '').slice(0, 1000));
    return json(res, 201, ownerRow('investments', result.lastInsertRowid, user.id));
  }
  const investmentRoute = path.match(/^\/api\/investimentos\/(\d+)$/);
  if (investmentRoute && req.method === 'PUT') {
    const id = Number(investmentRoute[1]);
    if (!ownerRow('investments', id, user.id)) throw fail(404, 'Investimento não encontrado.');
    const body = await parseBody(req);
    if (!validDate(body.applied_on) || !categories.investimento.includes(body.type)) throw fail(400, 'Confira o tipo e a data do investimento.');
    const name = String(body.name || '').trim();
    if (name.length < 2 || name.length > 80) throw fail(400, 'Informe um nome válido para o investimento.');
    db.prepare('UPDATE investments SET name=?,type=?,institution=?,initial_cents=?,current_cents=?,applied_on=?,notes=? WHERE id=? AND user_id=?')
      .run(name, body.type, String(body.institution || '').slice(0, 100), nonNegativeCentsFrom(body.applied_value), nonNegativeCentsFrom(body.current_value), body.applied_on, String(body.notes || '').slice(0, 1000), id, user.id);
    return json(res, 200, ownerRow('investments', id, user.id));
  }
  if (investmentRoute && req.method === 'DELETE') {
    const id = Number(investmentRoute[1]);
    if (!ownerRow('investments', id, user.id)) throw fail(404, 'Investimento não encontrado.');
    if (db.prepare('SELECT 1 FROM movements WHERE investment_id=? LIMIT 1').get(id)) throw fail(409, 'Este investimento possui movimentações e não pode ser excluído.');
    db.prepare('DELETE FROM investments WHERE id=? AND user_id=?').run(id, user.id);
    return json(res, 200, { ok: true });
  }
  if (path === '/api/metas' && req.method === 'GET') return json(res, 200, db.prepare('SELECT * FROM goals WHERE user_id=? ORDER BY deadline').all(user.id));
  if (path === '/api/metas' && req.method === 'POST') {
    const body = await parseBody(req);
    if (String(body.name || '').trim().length < 2 || !validDate(body.start_date)) throw fail(400, 'Informe o nome, o valor desejado e a data de início da meta.');
    if (validDate(body.deadline, true) === false) throw fail(400, 'Informe um prazo válido para a meta ou deixe o campo em branco.');
    const result = db.prepare('INSERT INTO goals(user_id,name,description,target_cents,saved_cents,start_date,deadline) VALUES(?,?,?,?,?,?,?)')
      .run(user.id, String(body.name).trim().slice(0, 100), String(body.description || '').slice(0, 500), centsFrom(body.target_value), nonNegativeCentsFrom(body.saved_value), body.start_date, validDate(body.deadline, true) ? body.deadline || null : null);
    return json(res, 201, ownerRow('goals', result.lastInsertRowid, user.id));
  }
  const goalRoute = path.match(/^\/api\/metas\/(\d+)$/);
  if (goalRoute) {
    const id = Number(goalRoute[1]);
    if (!ownerRow('goals', id, user.id)) throw fail(404, 'Meta financeira não encontrada.');
    if (req.method === 'PUT') {
      const body = await parseBody(req);
      const name = String(body.name || '').trim();
      if (name.length < 2 || name.length > 100 || !validDate(body.start_date)) throw fail(400, 'Confira o nome e as datas da meta financeira.');
      if (validDate(body.deadline, true) === false) throw fail(400, 'Informe um prazo válido para a meta ou deixe o campo em branco.');
      db.prepare('UPDATE goals SET name=?,description=?,target_cents=?,saved_cents=?,start_date=?,deadline=? WHERE id=? AND user_id=?')
        .run(name, String(body.description || '').slice(0, 500), centsFrom(body.target_value), nonNegativeCentsFrom(body.saved_value), body.start_date, validDate(body.deadline, true) ? body.deadline || null : null, id, user.id);
      return json(res, 200, ownerRow('goals', id, user.id));
    }
    if (req.method === 'DELETE') {
      db.prepare('DELETE FROM goals WHERE id=? AND user_id=?').run(id, user.id);
      return json(res, 200, { ok: true });
    }
  }
  if (path === '/api/orcamentos' && req.method === 'GET') {
    const month = monthRange(url.searchParams.get('mes') || todayInBrazil().slice(0, 7));
    return json(res, 200, db.prepare(`SELECT b.*, COALESCE(SUM(CASE WHEN m.status='paga' THEN m.cents ELSE 0 END),0) AS spent_cents
      FROM budgets b LEFT JOIN movements m ON m.user_id=b.user_id AND m.type='despesa' AND m.category=b.category AND substr(m.date,1,7)=b.month
      WHERE b.user_id=? AND b.month=? GROUP BY b.id ORDER BY b.category`).all(user.id, month));
  }
  if (path === '/api/orcamentos' && req.method === 'POST') {
    const body = await parseBody(req);
    const month = monthRange(body.month);
    const limit = centsFrom(body.limit_value);
    db.prepare('INSERT INTO budgets(user_id,month,category,limit_cents) VALUES(?,?,?,?) ON CONFLICT(user_id,month,category) DO UPDATE SET limit_cents=excluded.limit_cents')
      .run(user.id, month, String(body.category || '').slice(0, 80), limit);
    return json(res, 201, { ok: true });
  }
  const budgetRoute = path.match(/^\/api\/orcamentos\/(\d+)$/);
  if (budgetRoute && req.method === 'DELETE') {
    db.prepare('DELETE FROM budgets WHERE id=? AND user_id=?').run(Number(budgetRoute[1]), user.id);
    return json(res, 200, { ok: true });
  }
  if (path === '/api/resumo' && req.method === 'GET') return json(res, 200, summary(user.id, url.searchParams.get('mes') || todayInBrazil().slice(0, 7)));
  if (path === '/api/exportacao' && req.method === 'GET') {
    const rows = db.prepare('SELECT date,type,description,category,cents,status,payment_method,notes FROM movements WHERE user_id=? ORDER BY date DESC').all(user.id);
    const csv = ['data,tipo,descricao,categoria,valor,situacao,forma_pagamento,observacoes', ...rows.map((r) =>
      [r.date, r.type, r.description, r.category, (r.cents / 100).toFixed(2).replace('.', ','), r.status, r.payment_method, r.notes]
        .map((cell) => {
          const value = String(cell ?? '');
          const safeValue = /^[\s]*[=+\-@]/.test(value) ? `'${value}` : value;
          return `"${safeValue.replaceAll('"', '""')}"`;
        }).join(';'))].join('\r\n');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="movimentacoes.csv"', 'Cache-Control': 'no-store' });
    return res.end(`\ufeff${csv}`);
  }
  throw fail(404, 'Página ou operação não encontrada.');
}

function saveMovement(userId, body, id) {
  const type = String(body.type || '');
  const allowed = ['receita', 'despesa', 'transferencia', 'aporte', 'resgate', 'rendimento'];
  const description = String(body.description || '').trim();
  const category = String(body.category || '').trim();
  const date = body.date;
  const status = body.status || 'paga';
  const accountId = Number(body.account_id);
  const destinationId = body.destination_id ? Number(body.destination_id) : null;
  const investmentId = body.investment_id ? Number(body.investment_id) : null;
  if (!allowed.includes(type) || description.length < 2 || description.length > 120 || !category || !validDate(date) || !['paga', 'pendente'].includes(status)) {
    throw fail(400, 'Confira o tipo, a descrição, a categoria, a data e a situação da movimentação.');
  }
  if (validDate(body.due_date, true) === false || validDate(body.paid_date, true) === false) throw fail(400, 'Confira as datas de vencimento e pagamento.');
  const cents = centsFrom(body.amount);
  if (!ownerRow('accounts', accountId, userId)) throw fail(400, 'Selecione uma conta financeira válida.');
  if (type === 'transferencia') {
    if (!destinationId || destinationId === accountId || !ownerRow('accounts', destinationId, userId)) throw fail(400, 'Selecione contas de origem e destino diferentes e válidas.');
  } else if (destinationId) throw fail(400, 'Esta movimentação não deve ter uma conta de destino.');
  if (investmentId && !ownerRow('investments', investmentId, userId)) throw fail(400, 'Selecione um investimento válido.');
  if (['aporte', 'resgate', 'rendimento'].includes(type) && !investmentId) throw fail(400, 'Selecione o investimento relacionado a esta movimentação.');
  if (type === 'rendimento' && destinationId) throw fail(400, 'Rendimentos não podem ter uma conta de destino.');
  const values = [userId, type, description, category, cents, date, validDate(body.due_date, true) ? body.due_date || null : null,
    validDate(body.paid_date, true) ? body.paid_date || null : null, accountId, destinationId, investmentId,
    String(body.payment_method || '').slice(0, 50), status, body.recurring ? 1 : 0, String(body.notes || '').slice(0, 1000)];
  if (id) {
    db.prepare(`UPDATE movements SET user_id=?,type=?,description=?,category=?,cents=?,date=?,due_date=?,paid_date=?,account_id=?,destination_id=?,investment_id=?,payment_method=?,status=?,recurring=?,notes=? WHERE id=? AND user_id=?`)
      .run(...values, id, userId);
    return ownerRow('movements', id, userId);
  }
  const result = db.prepare(`INSERT INTO movements(user_id,type,description,category,cents,date,due_date,paid_date,account_id,destination_id,investment_id,payment_method,status,recurring,notes)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...values);
  return ownerRow('movements', result.lastInsertRowid, userId);
}

function summary(userId, month) {
  monthRange(month);
  const start = `${month}-01`;
  const end = `${month}-${new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate().toString().padStart(2, '0')}`;
  const rows = db.prepare('SELECT * FROM movements WHERE user_id=? AND date>=? AND date<=?').all(userId, start, end);
  const paid = rows.filter((row) => row.status === 'paga');
  const income = paid.filter((r) => r.type === 'receita').reduce((n, r) => n + r.cents, 0);
  const expenses = paid.filter((r) => r.type === 'despesa').reduce((n, r) => n + r.cents, 0);
  const accounts = listAccounts(userId);
  const investments = db.prepare(`SELECT i.current_cents + COALESCE(SUM(CASE WHEN m.type='aporte' THEN m.cents WHEN m.type='resgate' THEN -m.cents WHEN m.type='rendimento' THEN m.cents ELSE 0 END),0) AS balance_cents
    FROM investments i LEFT JOIN movements m ON m.investment_id=i.id AND m.status='paga' WHERE i.user_id=? GROUP BY i.id`).all(userId);
  const investTotal = investments.reduce((n, i) => n + i.balance_cents, 0);
  const categoriesSpent = {};
  for (const r of paid.filter((entry) => entry.type === 'despesa')) categoriesSpent[r.category] = (categoriesSpent[r.category] || 0) + r.cents;
  const pending = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(cents),0) AS cents FROM movements WHERE user_id=? AND type='despesa' AND status='pendente' AND date<=?").get(userId, end);
  const overdue = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(cents),0) AS cents FROM movements WHERE user_id=? AND type='despesa' AND status='pendente' AND due_date<?").get(userId, todayInBrazil());
  const monthly = db.prepare(`SELECT substr(date,1,7) AS month,
    SUM(CASE WHEN type='receita' AND status='paga' THEN cents ELSE 0 END) AS income_cents,
    SUM(CASE WHEN type='despesa' AND status='paga' THEN cents ELSE 0 END) AS expense_cents
    FROM movements WHERE user_id=? AND date>=? AND date<=? GROUP BY substr(date,1,7) ORDER BY month`)
    .all(userId, `${Number(month.slice(0, 4))}-01-01`, `${Number(month.slice(0, 4))}-12-31`);
  const totalAssets = accounts.reduce((n, a) => n + a.balance_cents, 0) + investTotal;
  return { month, income_cents: income, expenses_cents: expenses, available_cents: accounts.reduce((n, a) => n + a.balance_cents, 0),
    invested_cents: investTotal, net_worth_cents: totalAssets, remaining_cents: income - expenses,
    savings_percent: income ? Math.round(((income - expenses) / income) * 100) : null,
    pending_count: pending.count, pending_cents: pending.cents, overdue_count: overdue.count, overdue_cents: overdue.cents,
    categories: Object.entries(categoriesSpent).map(([name, cents]) => ({ name, cents })),
    monthly, accounts, movement_count: rows.length };
}

async function serveStatic(path, res) {
  const requested = path === '/' ? '/index.html' : path;
  const file = normalize(join(PUBLIC, requested.replace(/^\/+/, '')));
  const relative = relativePath(PUBLIC, file);
  if (isAbsolute(relative) || relative === '..' || relative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) return json(res, 403, { error: 'Acesso negado.' });
  try {
    const body = await readFile(file);
    const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' }[extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'" });
    res.end(body);
  } catch (error) {
    if (error.code === 'ENOENT') return json(res, 404, { error: 'Arquivo não encontrado.' });
    throw error;
  }
}

const server = createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    if (error.status) return json(res, error.status, { error: error.message });
    console.error('Falha ao processar solicitação:', error);
    if (!res.headersSent) json(res, 500, { error: 'Não foi possível concluir a operação. Tente novamente.' });
    else res.end();
  }
});
const port = Number(process.env.PORT || 3000);
const bootstrapValues = [process.env.BOOTSTRAP_NAME, process.env.BOOTSTRAP_EMAIL, process.env.BOOTSTRAP_PASSWORD];
if (bootstrapValues.some(Boolean)) {
  if (bootstrapValues.some((value) => !value)) throw new Error('Configure BOOTSTRAP_NAME, BOOTSTRAP_EMAIL e BOOTSTRAP_PASSWORD juntos.');
  seedBootstrapUser({ name: bootstrapValues[0], email: bootstrapValues[1], password: bootstrapValues[2] });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  server.listen(port, host, () => console.log(`Minha Planilha Financeira disponível na porta ${port}`));
}

export { server, db, saveMovement, accountBalance, summary, seedBootstrapUser };
