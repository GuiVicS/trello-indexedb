# Configurar o modo Cloud

O app continua funcionando 100% offline sem nada disso configurado. Estes passos só
são necessários para habilitar login, assinatura e sincronização em nuvem.

## 1. Banco de dados (Supabase)

1. Abra seu projeto em supabase.com/dashboard.
2. Vá em **SQL Editor > New query**, cole todo o conteúdo de `supabase/schema.sql`
   deste repositório e rode.
3. Em **Storage**, confirme que o bucket `attachments` foi criado (o script já faz
   isso, mas o dashboard às vezes só atualiza depois de um refresh).
4. Em **Project Settings > API**, copie:
   - `Project URL` → vai em `VITE_SUPABASE_URL`
   - `anon public` → vai em `VITE_SUPABASE_ANON_KEY`
   - `service_role` (clique em "Reveal") → vai em `SUPABASE_SERVICE_ROLE_KEY`
     **nunca** exponha essa chave no navegador — ela só é usada dentro de `/api`.

## 2. Cobrança (Stripe)

1. Em **Product catalog**, crie um produto (ex: "Tarefas Cloud") com um preço
   recorrente mensal de R$ 19,90.
2. Copie o **Price ID** (`price_...`) → vai em `STRIPE_PRICE_ID_MONTHLY`.
3. Em **Developers > API keys**, copie a `Publishable key` → `VITE_STRIPE_PUBLISHABLE_KEY`
   e a `Secret key` → `STRIPE_SECRET_KEY`.
4. Em **Developers > Webhooks > Add endpoint**, aponte para
   `https://SEU-DOMINIO/api/stripe-webhook` e selecione os eventos:
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed`.
5. Copie o **Signing secret** (`whsec_...`) → `STRIPE_WEBHOOK_SECRET`.

   Enquanto testa localmente sem domínio público, use `stripe listen --forward-to
   localhost:5173/api/stripe-webhook` (Stripe CLI) para receber webhooks.

## 3. Variáveis de ambiente

Copie `.env.example` para `.env` e preencha com os valores acima. Depois, no painel
da Vercel do projeto, cadastre as **mesmas variáveis** em **Settings > Environment
Variables** (o `.env` local não é enviado para produção).

## 4. Virar superadmin

Depois de criar sua própria conta pelo app (Configurações > Habilitar Cloud), rode no
SQL Editor do Supabase:

```sql
update public.profiles set is_superadmin = true where email = 'voce@seudominio.com';
```

Um botão "Painel admin" aparece em Configurações assim que a conta tiver essa flag.

## Como funciona a sincronização

- Enquanto o Cloud não está habilitado, tudo continua só no IndexedDB do navegador.
- Ao confirmar o pagamento, os dados locais são copiados para o Supabase uma vez
  (migração inicial).
- Depois disso, toda alteração feita localmente tenta subir para a nuvem em segundo
  plano; se estiver offline, ela fica só no IndexedDB e sobe na próxima vez que o
  app perceber que a internet voltou (evento `online` do navegador).
- Anexos (arquivos) não são sincronizados em binário para a nuvem nesta primeira
  versão — só os metadados (nome/tipo). Isso é um ponto para evoluir depois, usando
  o bucket `attachments` do Storage já criado no schema.
