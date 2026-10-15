# Lucro na Mesa — versão em nuvem

Aplicativo web com login por e-mail e senha, múltiplas empresas por proprietário e Central administrativa.

## Arquitetura

- Front-end estático hospedado na Vercel.
- Autenticação e banco de dados no Supabase.
- Isolamento por proprietário usando Row Level Security (RLS).
- Perfil `admin` com acesso à Central e às empresas cadastradas.

## Configuração

1. Criar um projeto separado no Supabase.
2. Executar `supabase/schema.sql` no projeto.
3. Configurar `SUPABASE_URL` e `SUPABASE_PUBLISHABLE_KEY` na Vercel.
4. Executar `npm run build` e publicar a pasta `dist`.

A chave usada no navegador deve ser somente a chave publicável. A chave `service_role` nunca deve ser exposta no front-end.
