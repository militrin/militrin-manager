# NEXORA — arquivos de marca

- `nexora-icon.svg`: símbolo com fundo transparente; usar no sistema e como base do favicon.
- `nexora-icon-dark.svg`: ícone quadrado para aplicativo e atalhos.
- `nexora-logo-light.svg`: logo horizontal para fundo branco/claro.
- `nexora-logo-dark.svg`: logo horizontal para fundo azul-marinho.
- `nexora-icon-1024.png`: ícone raster em alta resolução.
- `favicon-32.png`, `favicon-48.png`, `apple-touch-icon.png`: tamanhos prontos para navegador/dispositivo.

## Aplicação web

Coloque os arquivos em `public/brand/` e use:

```html
<link rel="icon" type="image/svg+xml" href="/brand/nexora-icon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/brand/apple-touch-icon.png">
```

Em React/Next.js:

```tsx
<img src="/brand/nexora-icon.svg" alt="NEXORA" width={40} height={40} />
```

Para cabeçalhos, use `nexora-logo-dark.svg` no tema escuro e `nexora-logo-light.svg` no tema claro.
