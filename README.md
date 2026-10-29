# Minha Planilha Financeira

Aplicação pessoal de controle financeiro em português brasileiro, com interface web, API própria e banco SQLite persistente. O projeto não requer bibliotecas de terceiros.

## Requisitos

- Node.js 22.5 ou superior (o projeto usa o módulo SQLite nativo `node:sqlite`).
- Navegador atualizado.

## Instalação e execução

1. Abra um terminal na pasta do projeto.
2. Confira a versão do Node.js com `node --version`.
3. Inicie o servidor com `npm start`.
4. Acesse `http://127.0.0.1:3000` no navegador e crie sua conta.

O banco de dados é criado automaticamente em `data/financas.sqlite`. Para usar outra pasta, defina `DATA_DIR` antes de iniciar. A porta padrão é `3000`; ela pode ser alterada com `PORT`.

No PowerShell:

```powershell
$env:DATA_DIR = "D:\Dados\MinhaPlanilha"
$env:PORT = "3000"
npm start
```

Em uma implantação HTTPS, defina também `NODE_ENV=production` para que o cookie de sessão receba a opção `Secure`. Não exponha o servidor diretamente à internet sem HTTPS, atualizações e uma configuração de implantação adequada.

## Publicação no Render

O arquivo `render.yaml` descreve um serviço web e um disco persistente para o SQLite. O serviço usa o plano Starter porque o disco persistente não está disponível no plano gratuito; confira os preços vigentes do Render antes de confirmar a criação.

1. Publique o repositório no GitHub sem arquivos `.env`, dados de usuários ou cópias do banco.
2. No Render, escolha **Novo** → **Blueprint** e conecte o repositório.
3. Preencha `BOOTSTRAP_NAME`, `BOOTSTRAP_EMAIL` e `BOOTSTRAP_PASSWORD` no formulário protegido do Render. Use um e-mail válido e uma senha exclusiva, forte e diferente da senha do GitHub. Esses valores não devem ser incluídos em arquivos versionados.
4. Confirme a criação e aguarde a verificação de saúde em `/api/health`.
5. Acesse o endereço HTTPS gerado pelo Render e entre usando os dados definidos nos segredos do serviço.

O usuário inicial é criado na primeira inicialização. A senha é transformada em hash antes de ser persistida; reinicializações não alteram a senha de uma conta já existente.

## Testes

Execute `npm test`. Os testes usam um banco temporário separado e verificam persistência, isolamento entre contas, validação, movimentações, transferências e cálculos de patrimônio.

## Funcionalidades implementadas

- Cadastro, acesso e encerramento de sessão; senha armazenada com derivação `scrypt`, cookie `HttpOnly` e proteção CSRF em operações de escrita.
- Dados isolados por usuário e armazenados no SQLite, com consultas parametrizadas e valores financeiros representados em centavos inteiros.
- Cadastro e edição de contas, receitas, despesas e movimentações; filtros por data e situação; exportação do histórico em CSV.
- Página inicial "Meu controle financeiro" com entradas separadas de despesas essenciais e demais despesas, totais mensais calculados e inclusão rápida de registros. Nenhum exemplo da planilha é inserido automaticamente.
- Opção "Planilha" no menu para registrar entradas, identificar contas e despesas pelo nome (por exemplo, água, luz ou cartão), e acompanhar os totais gastos, recebidos e o dinheiro disponível no mês.
- Transferências entre contas que não são contabilizadas como receita ou despesa.
- Cadastro de investimentos, valores de mercado informados manualmente, aportes, resgates e rendimentos separados.
- Painel, histórico mensal, orçamento por categoria, metas financeiras e relatórios calculados a partir dos dados cadastrados.
- Interface responsiva em português brasileiro, tema claro/escuro persistido no dispositivo, moeda em reais e datas no formato brasileiro.

## Regras de cálculo

- O saldo de uma conta começa no saldo inicial e inclui receitas e movimentações pagas. Despesas e aportes reduzem o saldo; resgates o aumentam. Transferências reduzem a conta de origem e aumentam a conta de destino.
- Movimentações pendentes não alteram saldos ou totais de receitas/despesas pagas.
- O resultado mensal é o total de receitas recebidas menos despesas pagas pela data da movimentação.
- Aportes, resgates e rendimentos alteram separadamente o valor do investimento; eles não são somados às receitas ou despesas mensais. Aportes reduzem a conta de origem e aumentam o investimento, enquanto resgates aumentam a conta relacionada e reduzem o investimento. Rendimentos atualizam apenas o investimento.
- O patrimônio total é a soma dos saldos das contas e do valor atual dos investimentos cadastrados. Informe cada ativo apenas uma vez para evitar duplicidade.
- O valor atual dos investimentos é manual. A aplicação não consulta cotações nem estima rendimentos futuros.
- Registros permanecem no banco até serem excluídos pelo usuário ou até o banco ser removido.

## API

A API usa JSON, exceto a rota de exportação. Depois de criar uma conta ou entrar, o navegador recebe um cookie de sessão e um token CSRF. Todas as rotas privadas exigem sessão; operações de escrita também exigem o cabeçalho `X-CSRF-Token`.

| Método | Rota | Uso |
|---|---|---|
| `POST` | `/api/cadastro` | Criar usuário e iniciar sessão |
| `POST` | `/api/entrar` | Autenticar |
| `POST` | `/api/sair` | Encerrar a sessão |
| `GET` | `/api/eu` | Consultar o usuário e o token CSRF |
| `GET` | `/api/contas` | Listar contas e saldos calculados |
| `POST` | `/api/contas` | Criar conta |
| `PUT`, `DELETE` | `/api/contas/:id` | Editar ou excluir conta própria |
| `GET`, `POST` | `/api/movimentacoes` | Consultar ou cadastrar movimentações |
| `PUT`, `DELETE` | `/api/movimentacoes/:id` | Editar ou excluir movimentação própria |
| `GET`, `POST` | `/api/investimentos` | Consultar ou cadastrar investimentos |
| `PUT`, `DELETE` | `/api/investimentos/:id` | Editar ou excluir investimento sem movimentações |
| `GET`, `POST` | `/api/metas` | Consultar ou criar metas |
| `PUT`, `DELETE` | `/api/metas/:id` | Atualizar progresso ou excluir meta própria |
| `GET`, `POST` | `/api/orcamentos` | Consultar ou definir limites mensais |
| `DELETE` | `/api/orcamentos/:id` | Excluir limite mensal próprio |
| `GET` | `/api/resumo?mes=AAAA-MM` | Resumo e dados mensais |
| `GET` | `/api/exportacao` | Exportar movimentações próprias em CSV |

Filtros de movimentações disponíveis: `inicio`, `fim`, `tipo`, `situacao` e `categoria`.

## Cópias de segurança

Encerre o servidor antes de copiar o banco, ou use uma ferramenta de backup compatível com SQLite. Faça cópias regulares de `data/financas.sqlite` e guarde-as em local seguro, separado do dispositivo principal. Teste periodicamente a restauração de uma cópia. O CSV exportado contém movimentações, mas não substitui o backup do banco completo.

## Limitações conhecidas

- A área de cartões de crédito informa que o controle ainda não está disponível; não são simuladas compras ou faturas.
- O CSV exporta movimentações; a exportação em PDF, integração bancária e sincronização de cotações não foram implementadas.
- O sistema não envia alertas externos e não cria automaticamente lançamentos recorrentes futuros.
