import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let server;
let db;
let baseUrl;
let dataDir;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'minha-planilha-test-'));
  process.env.DATA_DIR = dataDir;
  const app = await import('../server.mjs');
  server = app.server;
  db = app.db;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function request(path, { method = 'GET', body, session } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(session ? { Cookie: session.cookie, ...(method !== 'GET' ? { 'X-CSRF-Token': session.csrf } : {}) } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const contentType = response.headers.get('content-type') || '';
  return { response, data: contentType.includes('application/json') ? await response.json() : await response.text() };
}

async function createUser(email) {
  const { response, data } = await request('/api/cadastro', {
    method: 'POST',
    body: { name: 'Pessoa Teste', email, password: 'senha-segura-123' }
  });
  assert.equal(response.status, 200);
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: data.csrf, user: data.user };
}

test('mantém o histórico, calcula saldos e separa patrimônio investido', async () => {
  const session = await createUser('ana@example.com');
  const otherSession = await createUser('bia@example.com');

  const { data: account } = await request('/api/contas', {
    method: 'POST', session,
    body: { name: 'Conta principal', type: 'Conta bancária', initial_balance: '500', reference_date: '2026-01-01' }
  });
  assert.equal(account.initial_cents, 50000);
  const { data: savings } = await request('/api/contas', {
    method: 'POST', session,
    body: { name: 'Carteira', type: 'Carteira digital', initial_balance: '0', reference_date: '2026-01-01' }
  });
  const { data: investment } = await request('/api/investimentos', {
    method: 'POST', session,
    body: { name: 'Reserva', type: 'Reserva de emergência', institution: 'Banco', applied_value: '100', current_value: '120', applied_on: '2026-01-01' }
  });

  async function movement(type, description, amount, extras = {}) {
    const result = await request('/api/movimentacoes', {
      method: 'POST', session,
      body: { type, description, category: type, amount, date: '2026-02-05', account_id: account.id, status: 'paga', ...extras }
    });
    assert.equal(result.response.status, 201, result.data.error);
    return result.data;
  }
  await movement('receita', 'Salário', '1000', { category: 'Salário' });
  const expense = await movement('despesa', 'Mercado', '200', { category: 'Alimentação', due_date: '2026-02-06' });
  await movement('transferencia', 'Entre contas', '100', { destination_id: savings.id });
  await movement('aporte', 'Aplicação mensal', '50', { investment_id: investment.id, category: 'CDB' });
  await movement('resgate', 'Resgate parcial', '20', { investment_id: investment.id, category: 'CDB', account_id: savings.id });
  await movement('rendimento', 'Rendimento informado', '5', { investment_id: investment.id, category: 'CDB', account_id: savings.id });

  const { data: accounts } = await request('/api/contas', { session });
  assert.equal(accounts.find((item) => item.id === account.id).balance_cents, 115000);
  assert.equal(accounts.find((item) => item.id === savings.id).balance_cents, 12000);
  const { data: investments } = await request('/api/investimentos', { session });
  assert.equal(investments[0].balance_cents, 15500);
  const { data: summary } = await request('/api/resumo?mes=2026-02', { session });
  assert.equal(summary.income_cents, 100000);
  assert.equal(summary.expenses_cents, 20000);
  assert.equal(summary.available_cents, 127000);
  assert.equal(summary.invested_cents, 15500);
  assert.equal(summary.net_worth_cents, 142500);
  assert.equal(summary.remaining_cents, 80000);
  assert.equal(summary.pending_count, 0);

  await request('/api/orcamentos', {
    method: 'POST', session,
    body: { month: '2026-02', category: 'Alimentação', limit_value: '300' }
  });
  const { data: budget } = await request('/api/orcamentos?mes=2026-02', { session });
  assert.equal(budget[0].spent_cents, 20000);
  assert.equal(budget[0].limit_cents, 30000);

  const { data: goal } = await request('/api/metas', {
    method: 'POST', session,
    body: { name: 'Reserva', target_value: '1000', saved_value: '200', start_date: '2026-01-01', deadline: '2026-12-31' }
  });
  const updatedGoal = await request(`/api/metas/${goal.id}`, {
    method: 'PUT', session,
    body: { name: 'Reserva atualizada', target_value: '1200', saved_value: '350', start_date: '2026-01-01', deadline: '2026-12-31' }
  });
  assert.equal(updatedGoal.data.saved_cents, 35000);
  assert.equal((await request(`/api/metas/${goal.id}`, { method: 'DELETE', session })).response.status, 200);

  const { data: history } = await request('/api/movimentacoes?inicio=2026-02-01&fim=2026-02-28', { session });
  assert.equal(history.length, 6);
  assert.equal(history.some((row) => row.id === expense.id), true);
  const { data: isolated } = await request('/api/movimentacoes', { session: otherSession });
  assert.equal(isolated.length, 0);

  const updated = await request(`/api/movimentacoes/${expense.id}`, {
    method: 'PUT', session,
    body: { type: 'despesa', description: 'Mercado atualizado', category: 'Alimentação', amount: '150', date: '2026-02-05', account_id: account.id, status: 'paga' }
  });
  assert.equal(updated.data.description, 'Mercado atualizado');
  const deleted = await request(`/api/movimentacoes/${expense.id}`, { method: 'DELETE', session });
  assert.equal(deleted.response.status, 200);
  const { data: afterDelete } = await request('/api/movimentacoes', { session });
  assert.equal(afterDelete.length, 5);
});

test('protege operações de escrita contra requisições sem token CSRF', async () => {
  const session = await createUser('carlos@example.com');
  const result = await request('/api/contas', {
    method: 'POST',
    body: { name: 'Conta sem proteção', type: 'Conta bancária', initial_balance: 0, reference_date: '2026-01-01' },
    session: { cookie: session.cookie, csrf: 'token-incorreto' }
  });
  assert.equal(result.response.status, 403);
  assert.match(result.data.error, /validar/);
});

test('rejeita datas inexistentes e impede acesso a registros de outra pessoa', async () => {
  const session = await createUser('duda@example.com');
  const other = await createUser('elisa@example.com');
  const { data: account } = await request('/api/contas', {
    method: 'POST', session,
    body: { name: 'Conta pessoal', type: 'Conta bancária', initial_balance: 0, reference_date: '2026-01-01' }
  });
  const invalidDate = await request('/api/movimentacoes', {
    method: 'POST', session,
    body: { type: 'despesa', description: 'Data inválida', category: 'Alimentação', amount: 10, date: '2026-02-31', account_id: account.id, status: 'paga' }
  });
  assert.equal(invalidDate.response.status, 400);
  const forbidden = await request(`/api/contas/${account.id}`, {
    method: 'PUT', session: other,
    body: { name: 'Conta alheia', type: 'Conta bancária', initial_balance: 0, reference_date: '2026-01-01' }
  });
  assert.equal(forbidden.response.status, 404);
});

test('importa CSV em lote de forma transacional e calcula os saldos', async () => {
  const session = await createUser('importacao@example.com');
  const { data: account } = await request('/api/contas', {
    method: 'POST', session,
    body: { name: 'Conta planilha', type: 'Conta bancária', initial_balance: 500, reference_date: '2026-01-01' }
  });
  const imported = await request('/api/importacao', {
    method: 'POST', session,
    body: { movements: [
      { type: 'receita', description: 'Salário importado', category: 'Salário', amount: '1780', account_id: account.id },
      { type: 'despesa', description: 'Cartão Nubank', category: 'Cartão de crédito', amount: '600', account_id: account.id }
    ] }
  });
  assert.equal(imported.response.status, 201);
  assert.equal(imported.data.imported, 2);
  const { data: summary } = await request(`/api/resumo?mes=${new Date().toISOString().slice(0, 7)}`, { session });
  assert.equal(summary.income_cents, 178000);
  assert.equal(summary.expenses_cents, 60000);
  assert.equal(summary.available_cents, 168000);

  const rejected = await request('/api/importacao', {
    method: 'POST', session,
    body: { movements: [
      { type: 'despesa', description: 'Validação inicial', category: 'Outras despesas', amount: '10', account_id: account.id },
      { type: 'movimentacao-invalida', description: 'Inválida', category: 'Outras despesas', amount: '1', account_id: account.id }
    ] }
  });
  assert.equal(rejected.response.status, 400);
  const { data: rows } = await request('/api/movimentacoes', { session });
  assert.equal(rows.length, 2);
});

test('exige autenticação e token CSRF para importar lançamentos', async () => {
  const anonymous = await request('/api/importacao', {
    method: 'POST',
    body: { movements: [{ type: 'despesa', description: 'Não autorizada', category: 'Outras despesas', amount: '1', account_id: 1 }] }
  });
  assert.equal(anonymous.response.status, 401);

  const session = await createUser('seguranca-importacao@example.com');
  const { data: account } = await request('/api/contas', {
    method: 'POST', session,
    body: { name: 'Conta privada', type: 'Conta bancária', initial_balance: 0, reference_date: '2026-01-01' }
  });
  const withoutCsrf = await request('/api/importacao', {
    method: 'POST',
    session: { cookie: session.cookie, csrf: 'incorreto' },
    body: { movements: [{ type: 'despesa', description: 'Não autorizada', category: 'Outras despesas', amount: '1', account_id: account.id }] }
  });
  assert.equal(withoutCsrf.response.status, 403);
});
