# Processador Distribuído de Transações de Apostas

Um processador distribuído de transações de apostas, projetado para entrega *at-least-once*, execução em múltiplas instâncias e correção financeira auditável. Oferece Wallets e transações BET, WIN, LOSS, REFUND e ROLLBACK por HTTP e SQS, com idempotência persistente, Ledger imutável, Outbox transacional, recuperação de referências pendentes e reconciliação de Wallets.

Consulte [ARCHITECTURE.md](ARCHITECTURE.md) para conhecer invariantes, concorrência, tratamento de falhas, trade-offs e evidências dos testes.

## Tecnologias

- Bun 1.4.4 e TypeScript 5.9 com modo `strict`
- NestJS 11
- MikroORM 6.6.17
- PostgreSQL 17.6 (imagem Docker); colunas monetárias em `NUMERIC(20,2)`
- API AWS SQS com LocalStack 4.0.3 para desenvolvimento local
- Docker Compose
- decimal.js 10
- Logs JSON estruturados com Pino / nestjs-pino
- Métricas Prometheus com prom-client 15.1.3

## Início rápido

Pré-requisitos: Bun 1.x, Docker Compose e disponibilidade das portas locais usadas pelo PostgreSQL (`5432`), LocalStack (`4566`) e aplicação (`3000`).

Copie o arquivo de ambiente de exemplo e instale as dependências:

```sh
cp .env.example .env
bun install
```

No PowerShell, use `Copy-Item .env.example .env`. As credenciais do exemplo servem somente para desenvolvimento local; não as utilize fora desse ambiente.

Suba primeiro apenas as dependências e, a partir do host, aplique as migrations versionadas:

```sh
docker compose up -d postgres localstack
bun run migration:up
```

Depois que o schema existir, inicie a aplicação:

```sh
docker compose up --build -d application
```

O Compose provisiona as filas SQS automaticamente. Ele não executa migrations do banco. O container da aplicação aguarda PostgreSQL e LocalStack ficarem saudáveis, mas não cria o schema ao iniciar.

Verificações locais úteis:

```sh
docker compose ps
docker compose logs -f application
curl http://localhost:3000/health/ready
curl http://localhost:3000/metrics
```

Para desenvolvimento executando a aplicação no host, depois de iniciar as dependências e aplicar as migrations:

```sh
bun run dev
```

Consulte as migrations com `bun run migration:list` ou reverta a última com `bun run migration:down`. Execute `migration:down` somente quando quiser reverter a migration mais recente do banco configurado.

## Configuração de ambiente

`.env.example` é a referência de configuração para desenvolvimento. A configuração é validada na inicialização da aplicação.

| Grupo | Variáveis |
|---|---|
| Aplicação e logs | `NODE_ENV`, `PORT`, `LOG_LEVEL`, `DEPENDENCY_TIMEOUT_MS` |
| PostgreSQL | `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` |
| SQS / LocalStack | `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SQS_ENDPOINT`, `SQS_MAX_RECEIVE_COUNT`, `SQS_WAGER_TRANSACTION_QUEUE_NAME`, `SQS_WAGER_TRANSACTION_DLQ_NAME`, `SQS_WAGER_EVENTS_QUEUE_NAME` |
| Consumer SQS | `SQS_CONSUMER_ENABLED`, `SQS_CONSUMER_WAIT_TIME_SECONDS`, `SQS_CONSUMER_MAX_MESSAGES`, `SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS`, `SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS` |
| Recuperação de referências pendentes | `REFERENCE_RETRY_BASE_DELAY_MS`, `REFERENCE_RETRY_MAX_ATTEMPTS`, `REFERENCE_RETRY_BATCH_SIZE`, `REFERENCE_RETRY_POLL_INTERVAL_MS` |
| Publicador da Outbox | `OUTBOX_PUBLISHER_ENABLED`, `OUTBOX_PUBLISHER_BATCH_SIZE`, `OUTBOX_PUBLISHER_POLL_INTERVAL_MS`, `OUTBOX_PUBLISHER_RETRY_BASE_DELAY_MS`, `OUTBOX_PUBLISHER_RETRY_MAX_DELAY_MS`, `OUTBOX_PUBLISHER_SHUTDOWN_TIMEOUT_MS` |

Os valores de `.env.example` são padrões de desenvolvimento. Em particular, o serviço Compose habilita o publicador da Outbox por padrão; já o ambiente de host do exemplo o deixa desabilitado. O consumer SQS vem habilitado por padrão nas duas configurações locais.

## Serviços e filas do Docker Compose

`docker compose up` define a aplicação, PostgreSQL e LocalStack em uma rede privada do Compose. Os dados do PostgreSQL ficam no volume nomeado `postgres-data`. A aplicação usa os nomes de serviço `postgres` e `localstack`; ferramentas executadas no host usam as portas locais publicadas.

O hook de inicialização do LocalStack cria estas filas FIFO sem necessidade de comandos AWS CLI manuais:

- `wager-transactions.fifo`
- `wager-transactions-dlq.fifo`
- `wager-events.fifo`

A fila de transações tem redrive para `wager-transactions-dlq.fifo`; o limite padrão é 5 recebimentos e pode ser alterado por `SQS_MAX_RECEIVE_COUNT`. A deduplicação baseada no conteúdo FIFO está desabilitada; a aplicação envia identificadores FIFO explícitos.

## API HTTP

| Método e caminho | Descrição |
|---|---|
| `POST /wallets` | Cria uma Wallet, opcionalmente com crédito interno de abertura. |
| `GET /wallets/:walletId` | Consulta uma Wallet e seu saldo materializado. |
| `GET /wallets/:walletId/ledger` | Consulta entradas imutáveis do Ledger com paginação por cursor. |
| `POST /wallets/:walletId/reconciliation` | Compara o saldo armazenado à reconstrução do Ledger; não corrige o estado. |
| `POST /wagering/transactions` | Processa uma transação de apostas do provider. Exige `Idempotency-Key`. |
| `GET /wagering/transactions/:transactionId` | Consulta pelo ID interno da transação. |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pela identidade composta da transação do provider. |
| `GET /health/live` | Verifica somente se o processo está vivo. |
| `GET /health/ready` | Verifica PostgreSQL e as filas SQS configuradas. |
| `GET /metrics` | Endpoint de exposição em texto do Prometheus. |

### Swagger / OpenAPI

A documentação interativa está disponível em `http://localhost:3000/docs` e o documento OpenAPI em `http://localhost:3000/docs-json`. Para importar as rotas no Bruno, use **Import → OpenAPI** e informe `http://localhost:3000/docs-json`. A documentação pode ser habilitada ou desabilitada por `SWAGGER_ENABLED` (padrão: `true`). Zod continua validando as requests em runtime; Swagger/OpenAPI documenta o contrato HTTP e não substitui essa validação.

### Criar uma Wallet

```sh
curl -X POST http://localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"player-123","currency":"BRL","initialBalance":"100.00"}'
```

`initialBalance` é uma string decimal. Um saldo positivo cria uma transação OPENING interna, uma entrada CREDIT no Ledger e dois eventos Outbox na mesma transação SQL da Wallet. Um saldo zero cria somente a Wallet. OPENING não é aceito pelo endpoint público de apostas.

Este contrato adapta o exemplo do desafio: recebe `currency` separadamente e `initialBalance` como string decimal, e responde com `walletId` e `balance` decimal string. A representação monetária permanece explícita e sem `number`; a adaptação evita aceitar múltiplas formas para o mesmo input.

### Processar uma transação de apostas

```sh
curl -X POST http://localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: request-8f35f47b' \
  -d '{
    "providerId":"provider-a",
    "externalTransactionId":"bet-987",
    "playerId":"player-123",
    "walletId":"wallet-id-from-create-response",
    "roundId":"round-42",
    "gameId":"game-7",
    "kind":"BET",
    "money":{"amount":"20.00","currency":"BRL"}
  }'
```

Os valores monetários devem ser strings com exatamente duas casas decimais; números JSON são inválidos. A resposta HTTP inclui `transactionId`, `status`, `failureCode`, `walletId`, `resultingBalance` e `idempotentReplay`.

| Status HTTP | Significado |
|---|---|
| `201 Created` | Nova transação processada. |
| `200 OK` | Replay seguro de uma transação existente. |
| `202 Accepted` | Nova transação aguardando uma referência. |
| `400 Bad Request` | Request, Money, formato de referência ou tentativa pública de OPENING inválidos. |
| `404 Not Found` | Wallet ou recurso consultado não existe. |
| `409 Conflict` | A Idempotency-Key ou identidade do provider foi reutilizada com dados de negócio divergentes. |
| `422 Unprocessable Entity` | Uma regra de negócio ou da Wallet rejeitou a operação. |
| `503 Service Unavailable` | Falha transitória conhecida de dependência. Erros inesperados retornam `500` sanitizado. |

### Paginação do Ledger

`GET /wallets/:walletId/ledger` aceita os parâmetros opcionais `cursor` e `limit`. O limite padrão é 50 e o máximo é 100. Os resultados usam paginação por chave, ordenados por `createdAt DESC, id DESC`; o cursor é opaco e vinculado à Wallet. O cliente deve devolvê-lo sem alterações e não deve interpretar seu conteúdo.

### Reconciliação

`POST /wallets/:walletId/reconciliation` retorna `storedBalance`, `calculatedBalance`, `difference` com sinal, `consistent` e `checkedEntries`. A diferença é `storedBalance - calculatedBalance`. A reconciliação nunca corrige o estado financeiro automaticamente; uma divergência retorna o resultado e emite um warning/métrica operacional.

## Testes e comandos de qualidade

```sh
bun test
bun run test:integration
bun run test:distributed
bun run test:load
bun run format
bun run lint
bun run typecheck
bun run build
```

- `bun test` executa testes unitários; casos que dependem da infraestrutura PostgreSQL são ignorados, a menos que sejam habilitados.
- `bun run test:integration` usa PostgreSQL e LocalStack reais.
- `bun run test:distributed` inicia processos Bun independentes para cenários de concorrência, crash, restart e falha de conexão.
- `bun run test:load` executa um benchmark HTTP local separado, usando um banco PostgreSQL temporário e validando a correção Wallet/Ledger após cada workload. Ele não faz parte de `bun test`.

Evidências observadas: `bun test` teve 406 aprovados e 65 testes condicionados à infraestrutura ignorados no modo unitário isolado; integração teve 63 aprovados; distribuídos, 19 cenários; load, 3 workloads. A execução mais recente do acceptance runner agregou regressões, auditorias adversariais e auditorias estáticas em 493/493 verificações, sem falhas e com 2 warnings agregados. O total é agregado pelo runner, não representa 493 novos testes de acceptance. Duas execuções consecutivas anteriores à adição dos testes finais de auth extension e rejected replay registraram 491/491 cada; a execução posterior às adições registrou 493/493. Esses números descrevem execuções observadas e podem mudar conforme os testes evoluam.

O script de load test executa um warm-up separado e informa percentis de latência HTTP de ponta a ponta. Em uma execução local observada, o publicador da Outbox ficou habilitado e drenou a fila até lag zero. Os resultados caracterizam o ambiente local, não representam uma promessa de capacidade de produção; consulte [ARCHITECTURE.md](ARCHITECTURE.md#caracterizacao-do-load-test) para ver a execução e suas limitações.

A métrica `wagering_lock_conflicts_total` é instrumentada, mas o resultado histórico persistido do load test não registrou seu valor por workload; nenhum valor é inferido ou apresentado aqui.

## Autenticação

A autenticação foi intencionalmente deixada fora desta implementação do desafio. A API não está pronta para exposição pública sem uma camada de autenticação e autorização. Uma implantação de produção deve usar um provedor OIDC externo, validar JWTs na borda ou na aplicação, definir escopos/funções de autorização e gerenciar credenciais de providers com segurança. Os endpoints de health permanecem sem autenticação nesta implementação. O SQS é tratado como transporte de infraestrutura confiável, enquanto a identidade do provider e a propriedade da Wallet continuam sendo validadas pela aplicação.

O código registra um `AuthenticationExtensionGuard` global no-op como ponto explícito de integração: ele preserva o acesso atual e deve ser substituído por um guard integrado ao IdP OIDC antes de exposição pública. O guard não implementa login e não autentica mensagens SQS.
