# Relatório Licenciados — Board Academy

## Estrutura
```
/
├── server.js          ← backend Express (roda no Render)
├── package.json
└── public/
    └── index.html     ← relatório no browser
```

## Deploy no Render

1. Sobe o repositório no GitHub
2. No Render → New → Web Service → conecta o repo
3. Em **Environment Variables**, adiciona:

| Variável           | Valor                                      |
|--------------------|--------------------------------------------|
| `PIPEDRIVE_TOKEN`  | sua API token do Pipedrive                 |
| `PIPEDRIVE_ORG`    | `boardacademy`                             |
| `FILTER_ID`        | `1402112`                                  |
| `PRODUCT_FIELD`    | `8bdce76ba66f0fed0280918a4845190c92899ed5` |

4. **Start Command:** `node server.js`
5. **Build Command:** `npm install`

## O que o relatório mostra
- KPIs: Leads criados, Ganhos, Receita, Ticket Médio, Conversão
- Gráficos de evolução mensal (leads, ganhos, receita, ticket médio)
- Quebra por produto (volume e receita)
- Tabela detalhada com totais
- Seletor de período (filtra client-side)
- Exportar PDF via Ctrl+P / botão
