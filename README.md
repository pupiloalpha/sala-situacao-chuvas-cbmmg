# Monitoramento de Riscos MG – PWA

Painel consolidado e rápido para o **Corpo de Bombeiros Militar de Minas Gerais** e Defesa Civil.

Centraliza as principais fontes oficiais de monitoramento:

- **Meteorológico**: CEMADEN (alertas + mapa interativo + briefing) e INMET
- **Hidrológico**: SGB/SACE (SAHs Doce, Velhas, São Francisco, Pomba, Muriaé) + ANA (HidroWeb e SAR)
- **Geológico**: GeoRisk + alertas de movimentos de massa do CEMADEN

## Como usar

### 1. Abrir localmente (mais simples)

Basta abrir o arquivo `index.html` em qualquer navegador moderno (Chrome, Edge, Firefox, Safari).

> **Obs.**: Algumas APIs externas (INMET via RadarMeteorológico) funcionam melhor quando o arquivo é servido por um servidor HTTP local (não como `file://`).

### 2. Servir com servidor local (recomendado)

```bash
# Na pasta do projeto
cd pwa-monitoramento-mg

# Python
python3 -m http.server 8080

# ou Node
npx serve -p 8080
```

Acesse: http://localhost:8080

### 3. Instalar como App (PWA)

1. Abra no Chrome/Edge no celular ou computador
2. Clique em “Instalar App” (banner) ou no menu do navegador → “Instalar aplicativo”
3. O painel ficará na tela inicial e funcionará parcialmente offline

### 4. Publicar em servidor

Copie a pasta inteira para qualquer hospedagem estática (GitHub Pages, Netlify, Vercel, servidor interno da corporação, etc.).

Não precisa de backend.

## Funcionalidades

| Aba | Conteúdo |
|-----|----------|
| **Painel** | Cards com links diretos para os sistemas mais usados |
| **Alertas** | Lista automática de alertas do INMET para MG (atualiza a cada 10 min) |
| **Hidrologia** | SACE, HidroWeb, SAR e dados abertos ANA |
| **Meteorologia** | Mapa CEMADEN, Briefings, Previsões de risco, Tempo INMET |
| **Geologia** | GeoRisk, alertas de movimentos de massa, REINDESC |
| **Fontes Oficiais** | Checklist matinal/noturno recomendado |

## Rotina sugerida (manhã e noite)

1. Abrir o **Briefing CEMADEN-CENAD**
2. Verificar **Painel de Alertas CEMADEN** (filtrar MG)
3. Conferir **SACE** (níveis dos rios dos SAHs de MG)
4. Olhar **Alertas INMET** (aba Alertas desta PWA ou portal)
5. Checar **GeoRisk** se houver chuva acumulada alta
6. Consultar site da **Defesa Civil MG** / Emergência MG se necessário

## Backend de resumo automático

Na pasta `backend/` existe um script Python que:

- Busca os alertas oficiais do INMET para MG
- Gera um boletim texto pronto para leitura
- Pode ser agendado com cron (07h e 19h)
- Envia por e-mail se configurado

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python resumo_diario.py --stdout          # teste
python resumo_diario.py --email           # com e-mail
```

Veja o arquivo `backend/README_BACKEND.md` para instruções completas de instalação e crontab.

## Personalização futura

- Adicionar mais municípios prioritários
- Envio por WhatsApp
- Exibir o último resumo dentro da própria PWA
- Cache offline mais agressivo de páginas oficiais
- Mapa Leaflet com pontos de interesse da corporação

## Créditos das fontes

- CEMADEN / MCTI
- INMET
- Serviço Geológico do Brasil (SGB/CPRM)
- Agência Nacional de Águas (ANA)
- Governo de Minas Gerais / Defesa Civil / Prodemge
- API pública de alertas: radarmeteorologico.com.br

---

**Uso interno – CBMMG / Defesa Civil de Minas Gerais**
