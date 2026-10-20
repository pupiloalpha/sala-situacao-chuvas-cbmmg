#!/usr/bin/env python3
"""
Resumo Automático de Riscos – Minas Gerais
Corpo de Bombeiros Militar / Defesa Civil

Gera um boletim conciso com:
- Alertas meteorológicos oficiais do INMET (MG)
- Checklist de fontes oficiais para consulta manual
- Timestamp e orientação de ação

Uso:
  python resumo_diario.py              # gera relatório local
  python resumo_diario.py --email      # gera + tenta enviar e-mail (se configurado)
  python resumo_diario.py --stdout     # imprime no terminal (útil para cron)

Agendamento sugerido (crontab):
  0 7  * * * cd /caminho/backend && python resumo_diario.py --email
  0 19 * * * cd /caminho/backend && python resumo_diario.py --email
"""

from __future__ import annotations

import argparse
import json
import os
import smtplib
import sys
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

try:
    import requests
except ImportError:
    print("Erro: instale as dependências com: pip install -r requirements.txt")
    sys.exit(1)

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # dotenv é opcional

# ---------------------------------------------------------------------------
# Configuração
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = BASE_DIR / os.getenv("OUTPUT_DIR", "relatorios")
TZ = ZoneInfo(os.getenv("TIMEZONE", "America/Sao_Paulo"))

INMET_ALERTAS_URL = "https://radarmeteorologico.com.br/api/v1/alertas?uf=MG"
TIMEOUT = 20  # segundos

# Links oficiais (sempre incluídos no relatório)
LINKS_OFICIAIS = [
    ("Briefing CEMADEN-CENAD (leitura obrigatória)", "https://www.gov.br/cemaden/pt-br/assuntos/briefing-cemaden-cenad"),
    ("Painel de Alertas CEMADEN", "https://painelalertas.cemaden.gov.br/"),
    ("SACE – Níveis de Rios (SGB)", "https://www.cprm.gov.br/sace/"),
    ("GeoRisk – Risco de Deslizamento", "https://georisk.cemaden.gov.br/"),
    ("Mapa Interativo CEMADEN", "https://mapainterativo.cemaden.gov.br/"),
    ("Alertas INMET (portal)", "https://alertas.inmet.gov.br/"),
    ("Defesa Civil MG", "https://www.mg.gov.br/defesacivil"),
    ("Emergência MG", "https://www.emergencia.mg.gov.br/"),
]


# ---------------------------------------------------------------------------
# Coleta de dados
# ---------------------------------------------------------------------------
def fetch_alertas_inmet() -> list[dict[str, Any]]:
    """Busca alertas meteorológicos do INMET para Minas Gerais."""
    try:
        resp = requests.get(INMET_ALERTAS_URL, timeout=TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
        # A API pode retornar {"alertas": [...]} ou lista direta
        if isinstance(data, dict):
            return data.get("alertas") or data.get("data") or []
        if isinstance(data, list):
            return data
        return []
    except Exception as e:
        print(f"[AVISO] Falha ao buscar alertas INMET: {e}", file=sys.stderr)
        return []


def severidade_ordem(sev: str) -> int:
    s = (sev or "").lower()
    if "extremo" in s or "grande perigo" in s:
        return 4
    if "perigo" in s and "potencial" not in s:
        return 3
    if "potencial" in s or "atenção" in s or "moderado" in s:
        return 2
    return 1


def _texto(valor: Any) -> str:
    """Converte qualquer valor da API em string limpa."""
    if valor is None:
        return ""
    if isinstance(valor, list):
        return " | ".join(str(v).strip() for v in valor if v)
    return str(valor).strip()


def format_alerta(a: dict[str, Any]) -> str:
    """Formata um alerta individual em texto limpo."""
    evento = _texto(a.get("evento") or a.get("titulo")) or "Alerta Meteorológico"
    sev = _texto(a.get("severidade") or a.get("severity")) or "—"
    inicio = _texto(a.get("inicio") or a.get("data_inicio"))
    fim = _texto(a.get("fim") or a.get("fim_previsto") or a.get("data_fim"))
    desc = _texto(a.get("descricao") or a.get("instrucoes") or a.get("riscos"))
    municipios = a.get("municipios_afetados") or a.get("municipios") or []

    linhas = [
        f"• [{sev}] {evento}",
    ]
    if inicio or fim:
        periodo = " – ".join(filter(None, [inicio[:16], fim[:16]]))
        linhas.append(f"  Período: {periodo}")
    if isinstance(municipios, list) and municipios:
        qtd = len(municipios)
        amostra = ", ".join(str(m) for m in municipios[:8])
        extra = f" (+{qtd - 8})" if qtd > 8 else ""
        linhas.append(f"  Municípios ({qtd}): {amostra}{extra}")
    if desc:
        desc_curta = desc.replace("\n", " ")
        if len(desc_curta) > 280:
            desc_curta = desc_curta[:277] + "..."
        linhas.append(f"  {desc_curta}")
    return "\n".join(linhas)


# ---------------------------------------------------------------------------
# Geração do relatório
# ---------------------------------------------------------------------------
def gerar_relatorio(alertas: list[dict[str, Any]]) -> str:
    agora = datetime.now(TZ)
    periodo = "MANHÃ" if agora.hour < 12 else "NOITE" if agora.hour >= 18 else "TARDE"

    # Ordena por severidade
    alertas_ord = sorted(
        alertas,
        key=lambda a: severidade_ordem(a.get("severidade") or a.get("severity") or ""),
        reverse=True,
    )

    linhas: list[str] = []
    linhas.append("=" * 64)
    linhas.append("  RESUMO AUTOMÁTICO DE RISCOS – MINAS GERAIS")
    linhas.append("  Corpo de Bombeiros Militar / Defesa Civil")
    linhas.append("=" * 64)
    linhas.append(f"  Emissão: {agora.strftime('%d/%m/%Y %H:%M')} ({periodo})")
    linhas.append(f"  Fonte principal: INMET (API pública)")
    linhas.append("=" * 64)
    linhas.append("")

    # ---- Alertas INMET ----
    linhas.append("1. ALERTAS METEOROLÓGICOS ATIVOS (INMET – MG)")
    linhas.append("-" * 64)
    if not alertas_ord:
        linhas.append("  ✅ Nenhum alerta meteorológico ativo para Minas Gerais no momento.")
    else:
        linhas.append(f"  Total de alertas encontrados: {len(alertas_ord)}")
        linhas.append("")
        for a in alertas_ord:
            linhas.append(format_alerta(a))
            linhas.append("")
    linhas.append("")

    # ---- Orientação de ação ----
    linhas.append("2. ORIENTAÇÃO RÁPIDA DE AÇÃO")
    linhas.append("-" * 64)
    if not alertas_ord:
        linhas.append("  • Manter monitoramento de rotina (SACE + Painel CEMADEN).")
        linhas.append("  • Verificar briefing diário do CEMADEN.")
    else:
        max_sev = max(severidade_ordem(a.get("severidade") or a.get("severity") or "") for a in alertas_ord)
        if max_sev >= 4:
            linhas.append("  🔴 SEVERIDADE ALTA/EXTREMA detectada.")
            linhas.append("  → Ativar plano de contingência e acompanhar SACE + GeoRisk em tempo real.")
            linhas.append("  → Verificar municípios listados nos alertas e áreas de risco conhecidas.")
        elif max_sev >= 3:
            linhas.append("  🟠 SEVERIDADE MODERADA/ALTA.")
            linhas.append("  → Reforçar monitoramento de rios (SACE) e encostas (GeoRisk).")
            linhas.append("  → Preparar equipes de prontidão conforme protocolo local.")
        else:
            linhas.append("  🟡 Atenção / Perigo Potencial.")
            linhas.append("  → Manter vigilância e consultar Painel CEMADEN + SACE.")
    linhas.append("")

    # ---- Checklist de fontes ----
    linhas.append("3. CHECKLIST DE CONSULTA OBRIGATÓRIA (manhã e noite)")
    linhas.append("-" * 64)
    for i, (nome, url) in enumerate(LINKS_OFICIAIS, 1):
        linhas.append(f"  {i}. {nome}")
        linhas.append(f"     {url}")
    linhas.append("")

    # ---- Rodapé ----
    linhas.append("=" * 64)
    linhas.append("  Este resumo é gerado automaticamente e NÃO substitui a análise")
    linhas.append("  técnica das equipes. Sempre confirme nos portais oficiais.")
    linhas.append("  PWA de apoio: abra o painel local ou instalado no dispositivo.")
    linhas.append("=" * 64)

    return "\n".join(linhas)


def salvar_relatorio(texto: str) -> Path:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    agora = datetime.now(TZ)
    nome = f"resumo_{agora.strftime('%Y-%m-%d_%H%M')}.txt"
    caminho = OUTPUT_DIR / nome
    caminho.write_text(texto, encoding="utf-8")

    # Também salva como "ultimo.txt" para facilitar
    ultimo = OUTPUT_DIR / "ultimo.txt"
    ultimo.write_text(texto, encoding="utf-8")
    return caminho


# ---------------------------------------------------------------------------
# E-mail (opcional)
# ---------------------------------------------------------------------------
def enviar_email(texto: str) -> bool:
    if os.getenv("ENABLE_EMAIL", "false").lower() not in ("1", "true", "yes"):
        print("[INFO] Envio de e-mail desabilitado (ENABLE_EMAIL=false).")
        return False

    host = os.getenv("SMTP_HOST")
    port = int(os.getenv("SMTP_PORT", "587"))
    user = os.getenv("SMTP_USER")
    password = os.getenv("SMTP_PASS")
    remetente = os.getenv("EMAIL_FROM") or user
    destinatarios = [e.strip() for e in os.getenv("EMAIL_TO", "").split(",") if e.strip()]

    if not all([host, user, password, remetente, destinatarios]):
        print("[AVISO] Configuração de e-mail incompleta. Verifique o arquivo .env")
        return False

    agora = datetime.now(TZ)
    assunto = f"[CBMMG] Resumo de Riscos MG – {agora.strftime('%d/%m/%Y %H:%M')}"

    msg = MIMEMultipart("alternative")
    msg["Subject"] = assunto
    msg["From"] = remetente
    msg["To"] = ", ".join(destinatarios)
    msg.attach(MIMEText(texto, "plain", "utf-8"))

    try:
        with smtplib.SMTP(host, port, timeout=30) as server:
            server.starttls()
            server.login(user, password)
            server.sendmail(remetente, destinatarios, msg.as_string())
        print(f"[OK] E-mail enviado para: {', '.join(destinatarios)}")
        return True
    except Exception as e:
        print(f"[ERRO] Falha no envio de e-mail: {e}", file=sys.stderr)
        return False


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(description="Gera resumo automático de riscos – MG")
    parser.add_argument("--email", action="store_true", help="Tenta enviar o relatório por e-mail")
    parser.add_argument("--stdout", action="store_true", help="Imprime o relatório no terminal")
    parser.add_argument("--json", action="store_true", help="Também salva os alertas brutos em JSON")
    args = parser.parse_args()

    print(f"[{datetime.now(TZ).strftime('%H:%M:%S')}] Coletando alertas INMET...")
    alertas = fetch_alertas_inmet()
    print(f"[{datetime.now(TZ).strftime('%H:%M:%S')}] {len(alertas)} alerta(s) encontrado(s).")

    relatorio = gerar_relatorio(alertas)
    caminho = salvar_relatorio(relatorio)
    print(f"[OK] Relatório salvo em: {caminho}")

    if args.json:
        json_path = caminho.with_suffix(".json")
        json_path.write_text(json.dumps(alertas, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[OK] JSON salvo em: {json_path}")

    if args.stdout or not args.email:
        print("\n" + relatorio)

    if args.email:
        enviar_email(relatorio)


if __name__ == "__main__":
    main()
