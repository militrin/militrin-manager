# Instagram oficial → Sorteios

Esta integração usa a **Instagram API with Instagram Login** para contas profissionais (Business ou Creator). O frontend nunca recebe access token: OAuth, troca do código, paginação e armazenamento são executados no servidor. O token de longa duração é cifrado com AES-256-GCM antes de ser persistido.

Contratos revalidados na documentação/coleção oficial da Meta:

- autorização: `https://www.instagram.com/oauth/authorize`;
- troca do código: `POST https://api.instagram.com/oauth/access_token`;
- longa duração: `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token`;
- renovação: `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token`;
- mídias da conta: `GET https://graph.instagram.com/{version}/{ig-user-id}/media`;
- comentários: `GET https://graph.instagram.com/{version}/{ig-media-id}/comments?fields=from,text,timestamp`;
- autor do comentário: `from.username`.

Documentação oficial de referência:

- [Instagram Platform](https://developers.facebook.com/docs/instagram-platform/)
- [Instagram API with Instagram Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/)
- [Comment moderation](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/comment-moderation/)
- [Access tokens](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login/)

## Variáveis de ambiente

Todas são privadas, sem prefixo `NEXT_PUBLIC_`:

```text
META_INSTAGRAM_APP_ID=
META_INSTAGRAM_APP_SECRET=
META_INSTAGRAM_REDIRECT_URI=https://www.militrin.com.br/api/instagram/oauth/callback
META_GRAPH_API_VERSION=vXX.X
INSTAGRAM_TOKEN_ENCRYPTION_KEY=<segredo aleatorio com pelo menos 32 caracteres>
```

`META_GRAPH_API_VERSION` é propositalmente obrigatória: a versão deve ser escolhida no painel/documentação vigente da Meta, evitando que um deploy passe a usar silenciosamente uma versão diferente.

## Configuração na Meta

1. Crie ou selecione um app no Meta for Developers e adicione o produto Instagram.
2. Configure Instagram API with Instagram Login e cadastre exatamente a redirect URI acima (troque o domínio em homologação).
3. Solicite `instagram_business_basic` e `instagram_business_manage_comments`. Em modo Development, adicione a conta profissional como tester; para contas externas, conclua App Review e Business Verification quando o painel exigir.
4. A conta `@militrinoktober` precisa ser profissional Business ou Creator e aceitar o convite/teste enquanto o app não estiver Live.
5. Aplique a migration `20260919000000_instagram_giveaways.sql` e configure as cinco variáveis no ambiente do servidor.

## Semântica e limitações

- Mídias e comentários percorrem `paging.next` até o fim; não há scraping.
- Ao sincronizar, o backend relista as mídias da conta conectada e resolve o `mediaId` nessa lista. O permalink recebido do navegador não é usado; somente o permalink oficial retornado nessa validação é persistido.
- O autor é `from.username`, com fallback para o também oficial `username`. Nunca é inferido do texto.
- Menções são extraídas exclusivamente de `comment.text`.
- A chave de participação é `comment_id`; dois comentários da mesma pessoa são duas chances.
- Antes do primeiro sorteio, sincronizar substitui a lista corrente. Depois dele, `snapshot_frozen_at` impede alteração da composição, inclusive se um comentário sumir depois no Instagram.
- O banco permite no máximo uma integração ativa por organização. Conexões antigas ficam desativadas para preservar os sorteios históricos e permitir multi-account no futuro.
- “Desconectar” apaga o token cifrado local e marca a conexão como desativada, sem apagar sorteios. A revogação total do consentimento na Meta pode ser feita também nas configurações da conta.
- Validações como seguir a conta, curtir e compartilhar Stories permanecem manuais: a API oficial não oferece uma verificação geral confiável dessas ações para este fluxo.
- A Meta recomenda webhooks para reduzir chamadas e risco de rate limiting. Eles não são necessários para a sincronização manual completa e paginada implementada aqui; devem ser a próxima evolução se for necessária atualização contínua em tempo real.
