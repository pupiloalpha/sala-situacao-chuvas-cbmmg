# Backend – Resumo Automático de Riscos MG

Script Python que gera um **boletim conciso** duas vezes ao dia com os alertas oficiais do INMET para Minas Gerais + checklist de fontes obrigatórias.

## Instalação rápida

```bash
cd backend

# Criar ambiente virtual (recomendado)
python3 -m venv .venv
source .venv/bin/activate   # Linux/macOS
# .venv\Scripts\activate    # Windows

pip install -r requirements.txt

# Configurar e-mail (opcional)
cp config.example.env .env
# Edite o .env com suas credenciais SMTP
```

## Uso manual

```bash
# Gera o relatório e mostra no terminal
python resumo_diario.py --stdout

# Gera e tenta enviar por e-mail
python resumo_diario.py --email

# Gera também o JSON bruto dos alertas
python resumo_diario.py --stdout --json
```

Os arquivos ficam em `backend/relatorios/`:

- `resumo_YYYY-MM-DD_HHMM.txt` – cada execução
- `ultimo.txt` – sempre o mais recente (fácil de abrir)

## Agendamento (cron) – manhã e noite

Edite o crontab:

```bash
crontab -e
```

Adicione (ajuste o caminho):

```cron
# Resumo das 07:00
0 7 * * * cd /caminho/completo/pwa-monitoramento-mg/backend && .venv/bin/python resumo_diario.py --email >> logs/cron.log 2>&1

# Resumo das 19:00
0 19 * * * cd /caminho/completo/pwa-monitoramento-mg/backend && .venv/bin/python resumo_diario.py --email >> logs/cron.log 2>&1
```

Crie a pasta de logs se quiser:

```bash
mkdir -p logs
```

## Configuração de e-mail (Gmail exemplo)

1. Ative a verificação em duas etapas na conta Google.
2. Gere uma **Senha de app** (Conta Google → Segurança → Senhas de app).
3. No arquivo `.env`:

```env
ENABLE_EMAIL=true
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=seu-email@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx
EMAIL_FROM=seu-email@gmail.com
EMAIL_TO=sala.situacao@cbmmg.mg.gov.br,coordenacao@defesacivil.mg.gov.br
```

Outros provedores (Outlook, servidor interno) funcionam da mesma forma – basta alterar `SMTP_HOST` e `SMTP_PORT`.

## O que o relatório contém

1. **Alertas meteorológicos ativos do INMET** filtrados para MG (evento, severidade, período, municípios e descrição resumida).
2. **Orientação rápida de ação** conforme o nível de severidade mais alto.
3. **Checklist fixo** com os 8 links oficiais que a equipe deve consultar (CEMADEN, SACE, GeoRisk, etc.).

> O script **não faz scraping** dos sites do CEMADEN/SACE (são aplicações pesadas em JavaScript). Ele foca no que é confiável via API pública e orienta a consulta manual dos demais sistemas.

## Integração com a PWA

- A PWA continua independente (só frontend).
- O backend pode rodar em qualquer servidor ou máquina da corporação.
- O arquivo `relatorios/ultimo.txt` pode ser publicado em uma pasta web se quiser exibir o último resumo dentro da PWA no futuro.

## Próximos passos possíveis

- Adicionar scraping leve do Painel CEMADEN (mais complexo e frágil).
- Enviar também por WhatsApp (API oficial ou serviço intermediário).
- Publicar o `ultimo.txt` em um endpoint simples para a PWA consumir.
- Incluir municípios prioritários da sua área de atuação.

---

Uso interno – CBMMG / Defesa Civil de Minas Gerais
