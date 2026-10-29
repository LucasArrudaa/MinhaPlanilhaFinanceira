const $ = (selector, root = document) => root.querySelector(selector);
const pageContent = $('#page-content');
const dialog = $('#form-dialog');
const dataForm = $('#data-form');
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const dateBR = (date) => date ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' }).format(new Date(`${date}T12:00:00`)) : '—';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const currentMonth = () => today().slice(0, 7);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const money = (cents) => brl.format((Number(cents) || 0) / 100);
let csrf = '';
let currentUser;
let categories = {};
let accounts = [];
let investments = [];
let activePage = 'planilha';
let selectedMonth = currentMonth();
let noticeTimer;
let chartData = [];

async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
  if (csrf && !['GET', 'HEAD'].includes(options.method || 'GET')) headers['X-CSRF-Token'] = csrf;
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  if (!response.ok) {
    let message = 'Não foi possível concluir a operação.';
    try { message = (await response.json()).error || message; } catch { /* resposta sem conteúdo JSON */ }
    throw new Error(message);
  }
  if (response.headers.get('content-type')?.includes('text/csv')) return response.blob();
  return response.status === 204 ? null : response.json();
}

function notify(message, error = false) {
  const notice = $('#notice');
  notice.textContent = message;
  notice.classList.toggle('error', error);
  notice.classList.add('show');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => notice.classList.remove('show'), 3500);
}

function setTheme(dark) {
  document.body.classList.toggle('dark', dark);
  localStorage.setItem('tema-financeiro', dark ? 'escuro' : 'claro');
  $('#theme-toggle').textContent = dark ? '☀' : '☾';
  $('#theme-toggle').setAttribute('aria-label', dark ? 'Ativar tema claro' : 'Ativar tema escuro');
}

function monthInput(value = selectedMonth, label = 'Mês') {
  return `<label class="filter-control">${label}<input class="period-select month-choice" type="month" value="${esc(value)}"></label>`;
}
function heading(title, description, action = '') {
  return `<div class="page-heading"><div><p class="eyebrow">MINHAS FINANÇAS</p><h1>${title}</h1><p>${description}</p></div>${action}</div>`;
}
function panel(title, content, subtitle = '') {
  return `<section class="panel"><div class="panel-header"><div><h2>${title}</h2>${subtitle ? `<p>${subtitle}</p>` : ''}</div></div>${content}</section>`;
}
function metric(title, value, icon, caption = '', tone = '') {
  return `<article class="metric-card"><div class="metric-label">${title}<span class="metric-icon">${icon}</span></div><strong class="${tone}">${value}</strong><small>${caption}</small></article>`;
}
function empty(message, detail = 'Quando houver registros, eles aparecerão aqui.') {
  return `<div class="empty-state"><strong>${message}</strong>${detail}</div>`;
}
function progress(value) {
  return `<progress class="progress" max="100" value="${Math.max(0, Math.min(100, Number(value) || 0))}">${Math.max(0, Math.min(100, Number(value) || 0))}%</progress>`;
}
function table(headers, rows, emptyMessage = 'Nenhum registro encontrado') {
  return `<div class="table-wrap"><table class="data-table"><thead><tr>${headers.map((header) => `<th>${header}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}">${empty(emptyMessage)}</td></tr>`}</tbody></table></div>`;
}
function statusBadge(status, dueDate) {
  const overdue = status === 'pendente' && dueDate && dueDate < today();
  const label = overdue ? 'Vencida' : status === 'pendente' ? 'Pendente' : 'Paga';
  return `<span class="badge ${overdue ? 'overdue' : status === 'pendente' ? 'pending' : ''}">${label}</span>`;
}
function movementRows(rows, actions = true) {
  return rows.map((row) => {
    const typeLabel = { receita: 'Receita', despesa: 'Despesa', transferencia: 'Transferência', aporte: 'Aporte', resgate: 'Resgate', rendimento: 'Rendimento' }[row.type] || row.type;
    const expense = row.type === 'despesa';
    const income = row.type === 'receita' || row.type === 'resgate' || row.type === 'rendimento';
    const sign = expense || row.type === 'aporte' ? '−' : income ? '+' : '';
    return `<tr><td><div class="description-cell"><span class="row-icon">${expense ? '↙' : income ? '↗' : '⇄'}</span><span><strong>${esc(row.description)}</strong><small>${esc(row.category)} · ${typeLabel}</small></span></div></td><td>${dateBR(row.date)}</td><td>${esc(row.account_name || '—')}</td><td>${statusBadge(row.status, row.due_date)}</td><td class="${expense || row.type === 'aporte' ? 'negative' : income ? 'positive' : ''}">${sign}${money(row.cents)}</td>${actions ? `<td><div class="table-actions"><button data-edit-movement="${row.id}" aria-label="Editar ${esc(row.description)}">Editar</button><button class="negative" data-delete-movement="${row.id}" aria-label="Excluir ${esc(row.description)}">Excluir</button></div></td>` : ''}</tr>`;
  }).join('');
}
function ledgerRows(rows) {
  return rows.map((row) => `<tr><td><div class="ledger-description"><strong>${esc(row.description)}</strong><small>${dateBR(row.date)} · ${statusBadge(row.status, row.due_date)}</small></div></td><td class="${row.type === 'despesa' ? 'negative' : 'positive'}">${money(row.cents)}</td><td><div class="table-actions"><button data-edit-movement="${row.id}" aria-label="Editar ${esc(row.description)}">Editar</button><button class="negative" data-delete-movement="${row.id}" aria-label="Excluir ${esc(row.description)}">Excluir</button></div></td></tr>`).join('');
}
function dateFilters() {
  return `<div class="filter-row"><input class="filter-control" id="filter-start" type="date" aria-label="Data inicial"><input class="filter-control" id="filter-end" type="date" aria-label="Data final"><select class="filter-control" id="filter-status" aria-label="Situação"><option value="">Todas as situações</option><option value="paga">Pagas</option><option value="pendente">Pendentes</option></select><button class="button" id="apply-filters">Filtrar</button></div>`;
}

async function loadApp() {
  const response = await api('/api/eu');
  csrf = response.csrf;
  currentUser = response.user;
  categories = await api('/api/categorias');
  $('#user-name').textContent = currentUser.name;
  $('#avatar').textContent = currentUser.name.trim().charAt(0).toUpperCase();
  $('#auth').hidden = true;
  $('#application').hidden = false;
  await renderPage(activePage);
}

async function renderPage(page = activePage) {
  activePage = page;
  const titles = { painel: 'Meu controle financeiro', receitas: 'Receitas', despesas: 'Despesas', movimentacoes: 'Movimentações', investimentos: 'Investimentos', contas: 'Contas financeiras', planilha: 'Planilha', historico: 'Histórico financeiro', configuracoes: 'Configurações' };
  $('#page-title').textContent = titles[page];
  document.querySelectorAll('.nav-link[data-page]').forEach((link) => link.classList.toggle('active', link.dataset.page === page));
  $('#sidebar').classList.remove('open');
  const renderers = { painel: renderDashboard, receitas: () => renderMovements('receita'), despesas: () => renderMovements('despesa'), movimentacoes: () => renderMovements(), investimentos: renderInvestments, contas: renderAccounts, planilha: renderSpreadsheet, historico: renderHistory, configuracoes: renderSettings };
  try { await renderers[page](); }
  catch (error) { notify(error.message, true); pageContent.innerHTML = heading(titles[page], 'Ocorreu um problema ao carregar os dados.') + panel('Não foi possível carregar esta página', empty('Tente novamente', error.message)); }
}

async function renderDashboard() {
  const [summary, movements] = await Promise.all([api(`/api/resumo?mes=${selectedMonth}`), api(`/api/movimentacoes?inicio=${selectedMonth}-01&fim=${selectedMonth}-31`)]);
  const action = `<select class="period-select month-choice" aria-label="Selecionar mês">${monthOptions()}</select>`;
  const entries = movements.filter((item) => item.type === 'receita');
  const expenses = movements.filter((item) => item.type === 'despesa');
  const essentials = expenses.filter((item) => isEssentialExpense(item));
  const otherExpenses = expenses.filter((item) => !isEssentialExpense(item));
  const sumPaid = (items) => items.filter((item) => item.status === 'paga').reduce((total, item) => total + item.cents, 0);
  const entrySection = `<section class="panel ledger-panel"><div class="ledger-heading"><div><p class="eyebrow">ENTRADAS</p><h2>Receitas</h2></div><button class="button button-primary" data-new-type="receita" id="add-entry">＋ Adicionar entrada</button></div>${table(['Descrição', 'Valor', ''], ledgerRows(entries), 'Ainda não há entradas neste mês',)}<div class="ledger-total"><span>Total de entradas recebidas</span><strong class="positive">${money(sumPaid(entries))}</strong></div></section>`;
  const expenseSection = `<section class="panel ledger-panel"><div class="ledger-heading"><div><p class="eyebrow">SAÍDAS</p><h2>Despesas</h2></div><button class="button button-primary" data-new-type="despesa" id="add-expense">＋ Adicionar despesa</button></div><div class="ledger-expense-group"><h3>Despesas essenciais</h3>${table(['Descrição', 'Valor', ''], ledgerRows(essentials), 'Nenhuma despesa essencial neste mês')}</div><div class="ledger-expense-group"><h3>Outras despesas</h3>${table(['Descrição', 'Valor', ''], ledgerRows(otherExpenses), 'Nenhuma outra despesa neste mês')}</div><div class="ledger-total"><span>Total de despesas pagas</span><strong class="negative">${money(sumPaid(expenses))}</strong></div></section>`;
  const cards = `<div class="metric-grid compact-metrics">${metric('Saldo disponível', money(summary.available_cents), '◉', 'Em suas contas')}${metric('Saldo do mês', money(summary.remaining_cents), '↗', 'Entradas recebidas menos despesas pagas', summary.remaining_cents < 0 ? 'negative' : 'positive')}${metric('Total investido', money(summary.invested_cents), '◈', 'Valor atual informado')}${metric('Patrimônio total', money(summary.net_worth_cents), '▣', 'Contas e investimentos')}${metric('Contas pendentes', String(summary.pending_count), '◷', `${money(summary.pending_cents)} em aberto`)}${metric('Despesas vencidas', String(summary.overdue_count), '!', `${money(summary.overdue_cents)} em aberto`, summary.overdue_count ? 'negative' : '')}</div>`;
  pageContent.innerHTML = heading('Meu controle financeiro', 'Organize suas entradas e saídas do mês em um só lugar.', action) +
    `<div class="finance-columns">${entrySection}${expenseSection}</div>${cards}` +
    `<div class="panel-grid">${panel('Receitas e despesas mensais', `<div class="chart-legend"><span><i class="legend-dot"></i>Receitas</span><span><i class="legend-dot red"></i>Despesas</span></div><div class="chart-area"><canvas id="monthly-chart" aria-label="Gráfico de receitas e despesas mensais"></canvas></div>`, `Movimentações registradas em ${selectedMonth}`)}${panel('Despesas por categoria', summary.categories.length ? `<div class="category-list">${summary.categories.slice().sort((a, b) => b.cents - a.cents).slice(0, 6).map((item) => `<div class="category-line"><span>${esc(item.name)}</span><b>${money(item.cents)}</b>${progress(item.cents / Math.max(...summary.categories.map((cat) => cat.cents)) * 100)}</div>`).join('')}</div>` : empty('Ainda não há despesas neste mês'))}</div>`;
  drawChart(summary.monthly);
}

function isEssentialExpense(movement) {
  const essentialCategories = new Set(['aluguel', 'moradia', 'água', 'agua', 'energia elétrica', 'energia eletrica', 'internet', 'telefone', 'educação', 'educacao', 'saúde', 'saude']);
  const category = String(movement.category || '').trim().toLocaleLowerCase('pt-BR');
  const description = String(movement.description || '').trim().toLocaleLowerCase('pt-BR');
  return essentialCategories.has(category) || /aluguel|água|agua|energia|internet|telefone/.test(description);
}

async function renderSpreadsheet() {
  const [summary, movements] = await Promise.all([
    api(`/api/resumo?mes=${selectedMonth}`),
    api(`/api/movimentacoes?inicio=${selectedMonth}-01&fim=${selectedMonth}-31`)
  ]);
  const entries = movements.filter((item) => item.type === 'receita');
  const expenses = movements.filter((item) => item.type === 'despesa');
  const essentials = expenses.filter(isEssentialExpense);
  const otherExpenses = expenses.filter((item) => !isEssentialExpense(item));
  const total = (rows) => rows.filter((item) => item.status === 'paga').reduce((sum, item) => sum + item.cents, 0);
  const expenseTable = (rows, message) => table(
    ['Nome da conta / despesa', 'Valor gasto', ''],
    ledgerRows(rows),
    message
  );
  const incomeTable = table(['Descrição', 'Valor recebido', ''], ledgerRows(entries), 'Nenhuma entrada cadastrada neste mês');
  const expensesHtml = `<div class="ledger-expense-group"><h3>Despesas essenciais</h3>${expenseTable(essentials, 'Nenhuma despesa essencial cadastrada')}</div>
    <div class="ledger-expense-group"><h3>Outras despesas</h3>${expenseTable(otherExpenses, 'Nenhuma outra despesa cadastrada')}</div>`;
  const incomePanel = `<section class="panel ledger-panel"><div class="ledger-heading"><div><p class="eyebrow">ENTRADAS</p><h2>Dinheiro recebido</h2></div><button class="button button-primary" data-new-type="receita">＋ Adicionar entrada</button></div>
    ${incomeTable}<div class="ledger-total"><span>Total recebido</span><strong class="positive">${money(total(entries))}</strong></div></section>`;
  const expensePanel = `<section class="panel ledger-panel"><div class="ledger-heading"><div><p class="eyebrow">SAÍDAS</p><h2>Contas e gastos</h2></div><button class="button button-primary" id="spreadsheet-expense">＋ Adicionar gasto</button></div>
    ${expensesHtml}<div class="ledger-subtotal"><span>Total de despesas essenciais</span><strong>${money(total(essentials))}</strong></div><div class="ledger-subtotal"><span>Total de outras despesas</span><strong>${money(total(otherExpenses))}</strong></div><div class="ledger-total"><span>Total geral de despesas</span><strong class="negative">${money(total(expenses))}</strong></div></section>`;
  const monthResult = summary.income_cents - summary.expenses_cents;
  const summaryCards = `<div class="metric-grid compact-metrics">
    ${metric('Total recebido', money(summary.income_cents), '↗', 'Entradas pagas no mês', 'positive')}
    ${metric('Total gasto', money(summary.expenses_cents), '↙', 'Despesas pagas no mês', 'negative')}
    ${metric('Dinheiro restante no mês', money(monthResult), '◷', 'Entradas menos gastos', monthResult < 0 ? 'negative' : 'positive')}
    ${metric('Dinheiro disponível', money(summary.available_cents), '◉', 'Saldo atual das suas contas', summary.available_cents < 0 ? 'negative' : '')}
  </div>`;
  pageContent.innerHTML = heading('Planilha', 'Registre entradas e gastos e acompanhe o dinheiro disponível.', `<div class="sheet-actions">${monthInput()}<button class="button" id="new-account">＋ Adicionar conta financeira</button><button class="button" id="import-spreadsheet">↑ Importar CSV</button></div>`) +
    `<div class="finance-columns">${incomePanel}${expensePanel}</div>${summaryCards}`;
}

function monthOptions() {
  return Array.from({ length: 12 }, (_, index) => {
    const date = new Date(Number(selectedMonth.slice(0, 4)), Number(selectedMonth.slice(5, 7)) - 1 - index, 1);
    const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    return `<option value="${value}" ${value === selectedMonth ? 'selected' : ''}>${new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(date)}</option>`;
  }).join('');
}
function drawChart(data) {
  const canvas = $('#monthly-chart');
  if (!canvas) return;
  if (data) chartData = data;
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = rect.width * ratio;
  canvas.height = rect.height * ratio;
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  const width = rect.width, height = rect.height;
  const months = chartData.slice(-6);
  const max = Math.max(1, ...months.flatMap((item) => [item.income_cents, item.expense_cents]));
  const color = getComputedStyle(document.body).getPropertyValue('--line');
  ctx.font = '10px sans-serif';
  ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--muted');
  ctx.strokeStyle = color;
  for (let grid = 0; grid < 4; grid++) {
    const y = 12 + grid * ((height - 43) / 3);
    ctx.beginPath(); ctx.moveTo(32, y); ctx.lineTo(width - 8, y); ctx.stroke();
  }
  if (!months.length) {
    ctx.textAlign = 'center'; ctx.fillText('Adicione movimentações para ver sua evolução', width / 2, height / 2);
    return;
  }
  const group = (width - 47) / months.length;
  months.forEach((item, index) => {
    const x = 39 + index * group + group / 2;
    const available = height - 55;
    const incomeH = item.income_cents / max * available;
    const expenseH = item.expense_cents / max * available;
    ctx.fillStyle = '#42a66c'; ctx.fillRect(x - 10, height - 34 - incomeH, 9, incomeH);
    ctx.fillStyle = '#e49b91'; ctx.fillRect(x + 2, height - 34 - expenseH, 9, expenseH);
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--muted');
    ctx.textAlign = 'center'; ctx.fillText(item.month.slice(5), x, height - 12);
  });

}

async function importSpreadsheet() {
  accounts = await api('/api/contas');
  if (!accounts.length) {
    notify('Cadastre uma conta financeira antes de importar os lançamentos.', true);
    return;
  }
  const fields = `<label class="wide">Conta para os lançamentos<select name="account_id" required>${accountOptions()}</select></label>
    <label class="wide">Arquivo CSV<input name="file" type="file" accept=".csv,text/csv" required><small>Colunas obrigatórias: tipo; descrição; categoria; valor. Datas podem ficar em branco e serão registradas na data da importação.</small></label>`;
  openDialog('Importar planilha CSV', fields, 'Importar lançamentos', async (body) => {
    const file = dataForm.elements.file.files[0];
    if (!file) throw new Error('Escolha um arquivo CSV para importar.');
    if (file.size > 1_000_000) throw new Error('O arquivo ultrapassa o limite de 1 MB.');
    const movements = parseImportCsv(await file.text()).map((item) => ({ ...item, account_id: body.account_id }));
    return api('/api/importacao', { method: 'POST', body: JSON.stringify({ movements }) });
  });
}

async function renderMovements(type) {
  const query = new URLSearchParams();
  if (type) query.set('tipo', type);
  if ($('#filter-start')?.value) query.set('inicio', $('#filter-start').value);
  if ($('#filter-end')?.value) query.set('fim', $('#filter-end').value);
  if ($('#filter-status')?.value) query.set('situacao', $('#filter-status').value);
  const movements = await api(`/api/movimentacoes?${query}`);
  const title = type === 'receita' ? 'Receitas' : type === 'despesa' ? 'Despesas' : 'Movimentações';
  const description = type === 'receita' ? 'Tudo o que entra nas suas contas.' : type === 'despesa' ? 'Acompanhe seus gastos e contas a pagar.' : 'Seu histórico completo de entradas, gastos e transferências.';
  pageContent.innerHTML = heading(title, description, `<button class="button button-primary new-movement" ${type ? `data-new-type="${type}"` : ''}>＋ Nova ${type === 'receita' ? 'receita' : type === 'despesa' ? 'despesa' : 'movimentação'}</button>`) +
    `<section class="panel">${dateFilters()}${table(['Descrição', 'Data', 'Conta', 'Situação', 'Valor', 'Ações'], movementRows(movements, true), `Nenhuma ${type === 'receita' ? 'receita' : type === 'despesa' ? 'despesa' : 'movimentação'} encontrada`)}</section>`;
}

async function renderInvestments() {
  investments = await api('/api/investimentos');
  const total = investments.reduce((sum, item) => sum + item.balance_cents, 0);
  const applied = investments.reduce((sum, item) => sum + item.contributions_cents + item.initial_cents, 0);
  const rows = investments.map((item) => `<tr><td><div class="description-cell"><span class="row-icon">◈</span><span><strong>${esc(item.name)}</strong><small>${esc(item.institution || item.type)}</small></span></div></td><td>${esc(item.type)}</td><td>${dateBR(item.applied_on)}</td><td>${money(item.contributions_cents + item.initial_cents)}</td><td class="positive">${money(item.balance_cents)}</td><td><div class="table-actions"><button data-investment-move="aporte" data-investment-id="${item.id}">Aportar</button><button data-investment-move="resgate" data-investment-id="${item.id}">Resgatar</button><button data-investment-move="rendimento" data-investment-id="${item.id}">Rendimento</button><button data-edit-investment="${item.id}">Editar</button><button class="negative" data-delete-investment="${item.id}">Excluir</button></div></td></tr>`).join('');
  pageContent.innerHTML = heading('Investimentos', 'Acompanhe aplicações, resgates e valores informados.', '<button class="button button-primary" id="new-investment">＋ Novo investimento</button>') +
    `<div class="metric-grid">${metric('Valor aplicado', money(applied), '↗', 'Aportes e saldo inicial')}${metric('Valor atual', money(total), '◈', 'Atualizado manualmente')}${metric('Variação estimada', money(total - applied), '⌁', 'Valor atual menos valor aplicado', total >= applied ? 'positive' : 'negative')}${metric('Investimentos', String(investments.length), '▣', 'Ativos cadastrados')}</div>` +
    panel('Meus investimentos', table(['Investimento', 'Categoria', 'Aplicado em', 'Total aplicado', 'Valor atual', 'Ações'], rows, 'Nenhum investimento cadastrado'));
}

async function renderAccounts() {
  accounts = await api('/api/contas');
  pageContent.innerHTML = heading('Contas financeiras', 'Veja onde seu dinheiro está e acompanhe os saldos.', '<button class="button button-primary" id="new-account">＋ Adicionar conta</button>') +
    `<div class="split-layout"><section class="panel"><div class="panel-header"><div><h2>Minhas contas</h2><p>O saldo considera o saldo inicial e as movimentações pagas.</p></div></div>${accounts.length ? accounts.map((account) => `<div class="account-row"><div class="account-name"><span class="row-icon">▣</span><span><b>${esc(account.name)}</b><small>${esc(account.type)} · desde ${dateBR(account.reference_date)}</small></span></div><span class="account-balance">${money(account.balance_cents)}</span><div class="table-actions"><button data-edit-account="${account.id}">Editar</button><button class="negative" data-delete-account="${account.id}">Excluir</button></div></div>`).join('') : empty('Nenhuma conta cadastrada', 'Adicione uma conta para registrar movimentações.')}</section>${panel('Saldo total', `<strong class="account-total">${money(accounts.reduce((sum, item) => sum + item.balance_cents, 0))}</strong><p class="stat-note">O saldo é calculado com base nas movimentações registradas. Transferências entre contas próprias não alteram sua renda nem suas despesas.</p>`)}</div>`;
}

async function renderGoals() {
  const goals = await api('/api/metas');
  const html = goals.map((goal) => {
    const percent = Math.min(100, Math.round(goal.saved_cents / goal.target_cents * 100));
    return `<article class="goal-card"><h3>${esc(goal.name)}</h3><p>${esc(goal.description || 'Uma meta para o seu futuro.')}</p>${progress(percent)}<div class="goal-amounts"><span>${money(goal.saved_cents)} guardados</span><b>${percent}%</b></div><p class="goal-deadline">Objetivo de ${money(goal.target_cents)}${goal.deadline ? ` · até ${dateBR(goal.deadline)}` : ''}</p><div class="table-actions"><button data-edit-goal="${goal.id}">Atualizar progresso</button><button class="negative" data-delete-goal="${goal.id}">Excluir</button></div></article>`;
  }).join('');
  pageContent.innerHTML = heading('Metas financeiras', 'Defina objetivos e acompanhe seu progresso.', '<button class="button button-primary" id="new-goal">＋ Criar meta</button>') +
    `<div class="goal-grid">${html || empty('Você ainda não criou uma meta', 'Defina um objetivo para começar a acompanhar seu progresso.')}</div>`;
}

async function renderBudget() {
  const budgets = await api(`/api/orcamentos?mes=${selectedMonth}`);
  const rows = budgets.map((item) => {
    const percent = Math.round(item.spent_cents / item.limit_cents * 100);
    return `<tr><td><strong>${esc(item.category)}</strong></td><td>${money(item.limit_cents)}</td><td>${money(item.spent_cents)}</td><td>${money(item.limit_cents - item.spent_cents)}</td><td><span class="badge ${percent >= 100 ? 'overdue' : percent >= 80 ? 'pending' : ''}">${percent}%</span></td><td><button class="negative" data-delete-budget="${item.id}">Excluir</button></td></tr>`;
  }).join('');
  pageContent.innerHTML = heading('Orçamento mensal', 'Planeje limites de gastos e acompanhe o que ainda resta.', `<button class="button button-primary" id="new-budget">＋ Definir limite</button>`) +
    `<div class="filter-row">${monthInput()}</div>` + panel('Limites por categoria', table(['Categoria', 'Planejado', 'Gasto', 'Restante', 'Utilizado', 'Ações'], rows, 'Nenhum limite definido para este mês'));
}

async function renderHistory() {
  const [summary, movements] = await Promise.all([api(`/api/resumo?mes=${selectedMonth}`), api(`/api/movimentacoes?inicio=${selectedMonth}-01&fim=${selectedMonth}-31`)]);
  pageContent.innerHTML = heading('Histórico financeiro', 'Consulte os registros de qualquer mês, sem perder o histórico anterior.', monthInput()) +
    `<div class="metric-grid">${metric('Receitas recebidas', money(summary.income_cents), '↗', selectedMonth, 'positive')}${metric('Despesas pagas', money(summary.expenses_cents), '↙', selectedMonth, 'negative')}${metric('Resultado do mês', money(summary.remaining_cents), '◷', 'Receitas menos despesas', summary.remaining_cents < 0 ? 'negative' : 'positive')}${metric('Registros', String(summary.movement_count), '▤', 'Movimentações no período')}</div>` +
    panel('Movimentações do período', table(['Descrição', 'Data', 'Conta', 'Situação', 'Valor', 'Ações'], movementRows(movements), 'Não há registros neste mês'));
}

async function renderReports() {
  const summary = await api(`/api/resumo?mes=${selectedMonth}`);
  const categoriesHtml = summary.categories.length ? summary.categories.map((item) => `<div class="bar-row"><span>${esc(item.name)}</span>${progress(item.cents / Math.max(1, summary.expenses_cents) * 100)}<b>${money(item.cents)}</b></div>`).join('') : empty('Ainda não há dados para analisar');
  const insights = summary.income_cents ? `<p class="stat-note">Neste mês, você economizou <b>${money(summary.remaining_cents)}</b>, considerando receitas recebidas menos despesas pagas. ${summary.invested_cents ? `Você tem ${money(summary.invested_cents)} em investimentos cadastrados.` : 'Registre investimentos para acompanhar seu patrimônio aplicado.'}</p>` : '<p class="stat-note">Ainda não há receitas suficientes para gerar análises. Registre movimentações para ver informações calculadas com seus dados.</p>';
  pageContent.innerHTML = heading('Relatórios', 'Explore seus números reais e exporte o histórico para uma planilha.', `<a class="export-link" href="/api/exportacao">↓ Exportar CSV</a>`) +
    `<div class="filter-row">${monthInput()}</div><div class="metric-grid">${metric('Receitas', money(summary.income_cents), '↗', 'Recebidas no mês', 'positive')}${metric('Despesas', money(summary.expenses_cents), '↙', 'Pagas no mês', 'negative')}${metric('Investimentos', money(summary.invested_cents), '◈', 'Valor atual informado')}${metric('Patrimônio', money(summary.net_worth_cents), '▣', 'Contas e investimentos')}</div>` +
    `<div class="panel-grid">${panel('Gastos por categoria', categoriesHtml, 'Somente despesas pagas no período')}${panel('Análises do período', insights, 'Calculadas a partir dos seus registros')}</div>` +
    panel('Receitas e despesas ao longo do ano', `<div class="chart-area"><canvas id="monthly-chart" aria-label="Gráfico anual de receitas e despesas"></canvas></div>`);
  const yearRows = await api(`/api/resumo?mes=${selectedMonth.slice(0, 4)}-12`);
  drawChart(yearRows.monthly);
}

async function renderCards() {
  pageContent.innerHTML = heading('Cartões de crédito', 'Uma visão clara das faturas e dos pagamentos.') +
    panel('Controle de cartões', empty('O controle de cartões ainda não está disponível', 'Para evitar contabilizar uma compra ou fatura duas vezes, esta área será habilitada quando o fluxo completo de cartões estiver implementado.'));
}

function renderSettings() {
  pageContent.innerHTML = heading('Configurações', 'Personalize sua experiência e cuide dos seus dados.') +
    `<div class="split-layout">${panel('Aparência', `<p class="stat-note">Escolha um tema confortável para você. Sua preferência fica salva neste dispositivo.</p><button class="button" id="settings-theme">Alternar tema claro/escuro</button>`)}${panel('Idioma e região', `<p class="stat-note">Idioma: português brasileiro<br>Moeda: real brasileiro (R$)<br>Datas: dia/mês/ano<br>Fuso horário: America/Sao_Paulo</p>`)}${panel('Seus dados', `<p class="stat-note">Baixe uma cópia das suas movimentações em formato CSV. Guarde seus arquivos de banco de dados para manter uma cópia de segurança.</p><a class="button" href="/api/exportacao">↓ Baixar movimentações (CSV)</a>`)}</div>`;
}

function selectOptions(items, selected = '') {
  return items.map((item) => `<option value="${esc(item.value)}" ${String(item.value) === String(selected) ? 'selected' : ''}>${esc(item.label)}</option>`).join('');
}
function labelField(label, name, type = 'text', value = '', options = '') {
  const isSelect = type === 'select';
  return `<label>${label}${isSelect ? `<select name="${name}" ${options.required ? 'required' : ''}>${options.html}</select>` : `<input name="${name}" type="${type}" value="${esc(value)}" ${options.required ? 'required' : ''} ${options.min != null ? `min="${options.min}"` : ''} ${options.step ? `step="${options.step}"` : ''} ${options.maxlength ? `maxlength="${options.maxlength}"` : ''}>`}</label>`;
}
function optionList(items, selected = '') {
  return items.map((item) => `<option value="${esc(item)}" ${item === selected ? 'selected' : ''}>${esc(item)}</option>`).join('');
}
function accountOptions(selected = '') {
  return `<option value="">Selecione uma conta</option>${accounts.map((account) => `<option value="${account.id}" ${String(account.id) === String(selected) ? 'selected' : ''}>${esc(account.name)}</option>`).join('')}`;
}
function parseCsvLine(line, delimiter) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && quoted && line[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === delimiter && !quoted) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  if (quoted) throw new Error('O arquivo CSV contém aspas sem fechamento.');
  return cells;
}
function parseImportCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error('O arquivo CSV não contém linhas para importar.');
  const delimiter = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ',';
  const headers = parseCsvLine(lines.shift(), delimiter).map((header) => header.trim().toLocaleLowerCase('pt-BR'));
  const columns = Object.fromEntries(headers.map((header, index) => [header, index]));
  for (const required of ['tipo', 'descricao', 'categoria', 'valor']) {
    if (!(required in columns)) throw new Error(`O arquivo precisa ter uma coluna "${required}".`);
  }
  return lines.map((line) => {
    const values = parseCsvLine(line, delimiter);
    const value = (column) => columns[column] == null ? '' : values[columns[column]] || '';
    const amount = value('valor').replace(/R\$\s*/gi, '').replace(/\s/g, '').replace(/\.(?=\d{3}(?:,|$))/g, '').replace(',', '.');
    const type = value('tipo').toLocaleLowerCase('pt-BR');
    if (!['receita', 'despesa'].includes(type)) throw new Error(`Tipo inválido na importação: "${value('tipo')}". Use receita ou despesa.`);
    return {
      type,
      description: value('descricao'),
      category: value('categoria'),
      amount,
      date: value('data'),
      status: value('situacao') || value('status') || 'paga',
      notes: value('observacoes')
    };
  });
}
function openDialog(title, fields, submitLabel, onSubmit, recordId = '') {
  dataForm.innerHTML = `<div class="form-inner"><div class="form-top"><h2>${title}</h2><button class="icon-button" type="button" data-close-dialog aria-label="Fechar">×</button></div><div class="form-grid">${fields}</div><div class="form-footer"><button class="button" type="button" data-close-dialog>Cancelar</button><button class="button button-primary" type="submit">${submitLabel}</button></div></div>`;
  dataForm.dataset.recordId = recordId;
  dataForm.onsubmit = async (event) => {
    event.preventDefault();
    const submit = $('button[type=submit]', dataForm);
    submit.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(dataForm));
      await onSubmit(body);
      dialog.close();
      await renderPage();
      notify('Alterações salvas com sucesso.');
    } catch (error) { notify(error.message, true); }
    finally { submit.disabled = false; }
  };
  dialog.showModal();
}

async function movementForm(type = '', movement = {}, descriptionLabel = 'Descrição') {
  accounts = await api('/api/contas');
  investments = await api('/api/investimentos');
  const selectedType = movement.type || type || 'despesa';
  const types = [
    { value: 'receita', label: 'Receita' }, { value: 'despesa', label: 'Despesa' }, { value: 'transferencia', label: 'Transferência' },
    { value: 'aporte', label: 'Aporte' }, { value: 'resgate', label: 'Resgate' }, { value: 'rendimento', label: 'Rendimento' }
  ];
  const chosenCategories = selectedType === 'receita' ? categories.receita : selectedType === 'despesa' ? categories.despesa : categories.investimento;
  const fields = `<label>Tipo<select name="type" id="movement-type">${selectOptions(types, selectedType)}</select></label>
    ${labelField(descriptionLabel, 'description', 'text', movement.description || '', { required: true, maxlength: 120 })}
    <label>Categoria<select name="category" id="movement-category">${optionList(chosenCategories, movement.category || '')}</select></label>
    ${labelField('Valor (R$)', 'amount', 'number', movement.cents ? movement.cents / 100 : '', { required: true, min: 0.01, step: '0.01' })}
    ${labelField('Data da movimentação', 'date', 'date', movement.date || today(), { required: true })}
    <label>Conta relacionada<select name="account_id" required>${accountOptions(movement.account_id)}</select></label>
    <label id="destination-field" ${selectedType === 'transferencia' ? '' : 'hidden'}>Conta de destino<select name="destination_id">${accountOptions(movement.destination_id)}</select></label>
    <label id="investment-field" ${['aporte', 'resgate', 'rendimento'].includes(selectedType) ? '' : 'hidden'}>Investimento<select name="investment_id"><option value="">Selecione um investimento</option>${investments.map((item) => `<option value="${item.id}" ${String(item.id) === String(movement.investment_id) ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></label>
    ${labelField('Situação', 'status', 'select', '', { required: true, html: selectOptions([{ value: 'paga', label: 'Paga / realizada' }, { value: 'pendente', label: 'Pendente' }], movement.status || 'paga') })}
    ${labelField('Vencimento (opcional)', 'due_date', 'date', movement.due_date || '')}
    ${labelField('Data do pagamento (opcional)', 'paid_date', 'date', movement.paid_date || '')}
    ${labelField('Forma de pagamento', 'payment_method', 'text', movement.payment_method || '', { maxlength: 50 })}
    <label id="recurring-field" class="checkbox-label" ${selectedType === 'despesa' ? '' : 'hidden'}><input type="checkbox" name="recurring" ${movement.recurring ? 'checked' : ''}> Despesa fixa ou recorrente</label>
    <label class="wide">Observações<textarea name="notes" maxlength="1000">${esc(movement.notes || '')}</textarea></label>`;
  openDialog(movement.id ? 'Editar movimentação' : 'Nova movimentação', fields, movement.id ? 'Salvar alterações' : 'Salvar movimentação', (body) => {
    body.recurring = dataForm.elements.recurring.checked;
    const url = movement.id ? `/api/movimentacoes/${movement.id}` : '/api/movimentacoes';
    return api(url, { method: movement.id ? 'PUT' : 'POST', body: JSON.stringify(body) });
  }, movement.id || '');
}

async function accountForm(account) {
  const editing = Boolean(account);
  const types = categories.account.map((value) => ({ value, label: value }));
  const fields = `${labelField('Nome da conta', 'name', 'text', account?.name || '', { required: true, maxlength: 80 })}
    ${labelField('Tipo de conta', 'type', 'select', '', { required: true, html: selectOptions(types, account?.type || types[0].value) })}
    ${labelField('Saldo inicial (R$)', 'initial_balance', 'number', account ? account.initial_cents / 100 : '0', { min: 0, step: '0.01' })}
    ${labelField('Data de referência', 'reference_date', 'date', account?.reference_date || today(), { required: true })}`;
  openDialog(editing ? 'Editar conta financeira' : 'Adicionar conta financeira', fields, editing ? 'Salvar alterações' : 'Adicionar conta', (body) => api(editing ? `/api/contas/${account.id}` : '/api/contas', { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) }));
}

function investmentForm(item) {
  const fields = `${labelField('Nome', 'name', 'text', item?.name || '', { required: true, maxlength: 80 })}
    ${labelField('Tipo de investimento', 'type', 'select', '', { required: true, html: optionList(categories.investimento, item?.type || '') })}
    ${labelField('Instituição financeira', 'institution', 'text', item?.institution || '', { maxlength: 100 })}
    ${labelField('Valor aplicado (R$)', 'applied_value', 'number', item ? item.initial_cents / 100 : '', { min: 0, step: '0.01' })}
    ${labelField('Valor atual informado (R$)', 'current_value', 'number', item ? item.current_cents / 100 : '', { min: 0, step: '0.01' })}
    ${labelField('Data da aplicação', 'applied_on', 'date', item?.applied_on || today(), { required: true })}
    <label class="wide">Observações<textarea name="notes" maxlength="1000">${esc(item?.notes || '')}</textarea></label>`;
  openDialog(item ? 'Editar investimento' : 'Novo investimento', fields, item ? 'Salvar alterações' : 'Adicionar investimento', (body) => api(item ? `/api/investimentos/${item.id}` : '/api/investimentos', { method: item ? 'PUT' : 'POST', body: JSON.stringify(body) }));
}

function goalForm(goal) {
  const fields = `${labelField('Nome da meta', 'name', 'text', goal?.name || '', { required: true, maxlength: 100 })}
    ${labelField('Valor desejado (R$)', 'target_value', 'number', goal ? goal.target_cents / 100 : '', { required: true, min: 0.01, step: '0.01' })}
    ${labelField('Valor já guardado (R$)', 'saved_value', 'number', goal ? goal.saved_cents / 100 : '0', { min: 0, step: '0.01' })}
    ${labelField('Data de início', 'start_date', 'date', goal?.start_date || today(), { required: true })}
    ${labelField('Prazo (opcional)', 'deadline', 'date', goal?.deadline || '')}
    <label class="wide">Descrição<textarea name="description" maxlength="500">${esc(goal?.description || '')}</textarea></label>`;
  openDialog(goal ? 'Atualizar meta financeira' : 'Criar meta financeira', fields, goal ? 'Salvar progresso' : 'Criar meta', (body) => api(goal ? `/api/metas/${goal.id}` : '/api/metas', { method: goal ? 'PUT' : 'POST', body: JSON.stringify(body) }));
}

function budgetForm() {
  const fields = `${labelField('Categoria de despesa', 'category', 'select', '', { required: true, html: optionList(categories.despesa, '') })}
    ${labelField('Limite mensal (R$)', 'limit_value', 'number', '', { required: true, min: 0.01, step: '0.01' })}
    ${labelField('Mês', 'month', 'month', selectedMonth, { required: true })}`;
  openDialog('Definir limite mensal', fields, 'Salvar limite', (body) => api('/api/orcamentos', { method: 'POST', body: JSON.stringify(body) }));
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button,a');
  if (!target) return;
  if (target.dataset.page) { event.preventDefault(); await renderPage(target.dataset.page); }
  if (target.classList.contains('new-movement') || target.dataset.newType) await movementForm(target.dataset.newType || '');
  if (target.id === 'spreadsheet-expense') await movementForm('despesa', {}, 'Nome da conta ou despesa');
  if (target.id === 'new-account') { accounts = await api('/api/contas'); await accountForm(); }
  if (target.id === 'import-spreadsheet') await importSpreadsheet();
  if (target.id === 'new-investment') investmentForm();
  if (target.id === 'new-goal') goalForm();
  if (target.dataset.editGoal) {
    const goals = await api('/api/metas');
    goalForm(goals.find((item) => String(item.id) === target.dataset.editGoal));
  }
  if (target.dataset.deleteGoal && confirm('Deseja excluir esta meta financeira?')) {
    try { await api(`/api/metas/${target.dataset.deleteGoal}`, { method: 'DELETE' }); await renderPage(); notify('Meta financeira excluída.'); } catch (error) { notify(error.message, true); }
  }
  if (target.id === 'new-budget') budgetForm();
  if (target.dataset.deleteBudget && confirm('Deseja excluir este limite mensal?')) {
    try { await api(`/api/orcamentos/${target.dataset.deleteBudget}`, { method: 'DELETE' }); await renderPage(); notify('Limite mensal excluído.'); } catch (error) { notify(error.message, true); }
  }
  if (target.hasAttribute('data-close-dialog')) dialog.close();
  if (target.id === 'apply-filters') await renderPage();
  if (target.dataset.editMovement) {
    const rows = await api('/api/movimentacoes');
    const row = rows.find((item) => String(item.id) === target.dataset.editMovement);
    if (row) await movementForm('', row);
  }
  if (target.dataset.deleteMovement && confirm('Deseja excluir esta movimentação?')) {
    try { await api(`/api/movimentacoes/${target.dataset.deleteMovement}`, { method: 'DELETE' }); await renderPage(); notify('Movimentação excluída.'); } catch (error) { notify(error.message, true); }
  }
  if (target.dataset.editAccount) { accounts = await api('/api/contas'); await accountForm(accounts.find((item) => String(item.id) === target.dataset.editAccount)); }
  if (target.dataset.deleteAccount && confirm('Deseja excluir esta conta financeira?')) {
    try { await api(`/api/contas/${target.dataset.deleteAccount}`, { method: 'DELETE' }); await renderPage(); notify('Conta excluída.'); } catch (error) { notify(error.message, true); }
  }
  if (target.dataset.editInvestment) { investments = await api('/api/investimentos'); investmentForm(investments.find((item) => String(item.id) === target.dataset.editInvestment)); }
  if (target.dataset.deleteInvestment && confirm('Deseja excluir este investimento?')) {
    try { await api(`/api/investimentos/${target.dataset.deleteInvestment}`, { method: 'DELETE' }); await renderPage(); notify('Investimento excluído.'); } catch (error) { notify(error.message, true); }
  }
  if (target.dataset.investmentMove) await movementForm(target.dataset.investmentMove, { type: target.dataset.investmentMove, investment_id: target.dataset.investmentId, category: investments.find((item) => String(item.id) === target.dataset.investmentId)?.type });
  if (target.id === 'settings-theme') setTheme(!document.body.classList.contains('dark'));
  if (target.id === 'logout') {
    try { await api('/api/sair', { method: 'POST' }); } catch { /* encerra a sessão local mesmo se a rede falhar */ }
    csrf = ''; $('#application').hidden = true; $('#auth').hidden = false;
  }
});

document.addEventListener('change', async (event) => {
  if (event.target.matches('.month-choice')) {
    selectedMonth = event.target.value || currentMonth();
    await renderPage();
  }
  if (event.target.id === 'movement-type') {
    const type = event.target.value;
    const items = type === 'receita' ? categories.receita : type === 'despesa' ? categories.despesa : categories.investimento;
    $('#movement-category').innerHTML = optionList(items);
    $('#destination-field').hidden = type !== 'transferencia';
    $('#investment-field').hidden = !['aporte', 'resgate', 'rendimento'].includes(type);
    $('#recurring-field').hidden = type !== 'despesa';
    if (['aporte', 'resgate', 'rendimento'].includes(type) && !investments.length) notify('Cadastre um investimento antes de registrar aportes ou resgates.', true);
  }
});

$('#auth-toggle').addEventListener('click', () => {
  const signup = $('#name-row').hidden;
  $('#name-row').hidden = !signup;
  $('#auth-heading').textContent = signup ? 'Crie sua conta' : 'Bem-vindo de volta';
  $('#auth-description').textContent = signup ? 'Comece a organizar suas finanças com tranquilidade.' : 'Entre para acompanhar sua vida financeira.';
  $('#auth-submit').textContent = signup ? 'Criar conta' : 'Entrar';
  $('#auth-toggle-copy').textContent = signup ? 'Já tem uma conta?' : 'Ainda não tem uma conta?';
  $('#auth-toggle').textContent = signup ? 'Entrar' : 'Criar conta';
  $('#auth-form').dataset.mode = signup ? 'cadastro' : 'entrar';
  $('#auth-form').elements.password.autocomplete = signup ? 'new-password' : 'current-password';
});
$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#auth-submit');
  button.disabled = true;
  try {
    const body = Object.fromEntries(new FormData(form));
    const result = await api(`/api/${form.dataset.mode || 'entrar'}`, { method: 'POST', body: JSON.stringify(body) });
    csrf = result.csrf;
    currentUser = result.user;
    categories = await api('/api/categorias');
    $('#user-name').textContent = currentUser.name;
    $('#avatar').textContent = currentUser.name.trim().charAt(0).toUpperCase();
    $('#auth').hidden = true;
    $('#application').hidden = false;
    await renderPage();
  } catch (error) { notify(error.message, true); }
  finally { button.disabled = false; }
});
$('#theme-toggle').addEventListener('click', () => setTheme(!document.body.classList.contains('dark')));
$('#menu-toggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
window.addEventListener('resize', () => drawChart(null));
setTheme(localStorage.getItem('tema-financeiro') === 'escuro');
loadApp().catch((error) => {
  if (!String(error.message).includes('sessão expirou')) notify(error.message, true);
  $('#application').hidden = true;
  $('#auth').hidden = false;
});
