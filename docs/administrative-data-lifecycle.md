# Regra de ciclo de vida de dados administrativos

Todo cadastro administrativo deve oferecer edição e uma operação explícita de remoção apenas a usuários autorizados.

- Edição e remoção são validadas novamente no servidor por organização e RBAC.
- Exclusão física só é permitida quando o registro nunca foi referenciado por histórico operacional ou financeiro.
- Registros referenciados são desativados, permanecem nos históricos e deixam de aparecer em novas seleções.
- Toda edição, exclusão ou desativação relevante registra operador, motivo e resultado na auditoria.
- Operações são idempotentes e não confiam em organização, operador ou permissão inferidos apenas da interface.
- Cadastros internos do sistema não podem ser removidos pela interface administrativa comum.

Esta regra deve ser aplicada gradualmente aos módulos existentes; a migration 113 inicia o contrato em categorias e fornecedores financeiros.
