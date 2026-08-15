# Militrin Manager

Aplicação Next.js em TypeScript para gestão de inscrições, pagamentos, camisetas, kits e relatórios do evento Militrin.

## Configuração do Supabase

1. Crie um projeto no Supabase.
2. No painel do projeto, copie a URL do projeto e a chave anônima.
3. Crie o arquivo .env.local na raiz do projeto com:

```env
NEXT_PUBLIC_SUPABASE_URL=https://seu-projeto.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sua-chave-anonima

## Teste de convites de primeiro acesso

O link de convite autentica a conta convidada e, por comportamento esperado do Supabase Auth, substitui a sessão que estiver aberta naquele perfil do navegador. Durante desenvolvimento ou homologação, abra convites em uma janela anônima ou em outro perfil do navegador para preservar a sessão administrativa.
```

## Criar o banco de dados

Execute a migration SQL em:

```bash
supabase/migrations/001_initial_schema.sql
```

No painel do Supabase, abra SQL Editor e rode o conteúdo do arquivo.

## Estoque inicial

Após criar as tabelas, cadastre os itens de estoque inicial na tabela shirt_inventory. A migration já inclui os registros com quantidade inicial 0. Ajuste os valores conforme a necessidade do evento.

## Executar o projeto

```bash
npm run dev
```

Acesse http://localhost:3000.

## Funcionalidades implementadas

- Dashboard administrativo com tema escuro
- Página de nova inscrição com validações e máscara de CPF/telefone
- Integração com Supabase via RPC
- Validação de estoque e bloqueio de CPF duplicado
- Tela amigável quando o Supabase ainda não estiver configurado
