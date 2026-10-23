/**
 * Monitoramento de Riscos MG - CBMMG
 * PWA de consulta rápida para equipes de campo e sala de situação
 */

const APP = {
  lastUpdate: null,
  alertasInmet: [],
  deferredPrompt: null,
  municipiosMg: {},
  municipiosCarregados: false,
  ultimoRelatorioTexto: '',
  previsaoBH: null,
  prioridadeAtual: null,

  // ========== INICIALIZAÇÃO ==========
  init() {
    this.registerSW();
    this.bindEvents();
    this.updateClock();
    this.loadMunicipiosMg().then(() => this.loadAlertasInmet());
    this.loadPrevisaoBH();
    this.checkInstallPrompt();
    setInterval(() => this.updateClock(), 30000);
    setInterval(() => this.loadAlertasInmet(), 10 * 60 * 1000);
  },

  async loadMunicipiosMg() {
    try {
      const res = await fetch('https://radarmeteorologico.com.br/api/v1/cidades?uf=MG', { cache: 'force-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const lista = data.cidades || data || [];
      const map = {};
      lista.forEach((c) => {
        if (c.ibge != null) map[String(c.ibge)] = c.nome;
      });
      this.municipiosMg = map;
      this.municipiosCarregados = true;
      console.log('[APP] Municípios MG carregados:', Object.keys(map).length);
      if (this.alertasInmet && this.alertasInmet.length) {
        this.renderAlertasInmet();
        this.avaliarPrioridades();
      }
    } catch (err) {
      console.warn('[APP] Falha ao carregar municípios MG:', err);
      this.municipiosCarregados = false;
    }
  },

  nomesMunicipiosDoAlerta(alerta) {
    const geos = alerta.geocodes || [];
    const nomes = [];
    const vistos = new Set();
    geos.forEach((g) => {
      const code = String(g);
      if (!code.startsWith('31')) return;
      const nome = this.municipiosMg[code];
      if (nome && !vistos.has(nome)) {
        vistos.add(nome);
        nomes.push(nome);
      }
    });
    nomes.sort((a, b) => a.localeCompare(b, 'pt-BR'));
    return nomes;
  },

  registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./service-worker.js')
        .then((reg) => console.log('[SW] Registrado:', reg.scope))
        .catch((err) => console.warn('[SW] Falha:', err));
    }
  },

  bindEvents() {
    document.querySelectorAll('.nav-tab').forEach((tab) => {
      tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
    });

    const btnRefresh = document.getElementById('btn-refresh');
    if (btnRefresh) btnRefresh.addEventListener('click', () => this.refreshAll());

    const btnRelatorio = document.getElementById('btn-gerar-relatorio');
    if (btnRelatorio) btnRelatorio.addEventListener('click', () => this.abrirRelatorio());

    document.querySelectorAll('[data-close-modal]').forEach((el) => {
      el.addEventListener('click', () => this.fecharRelatorio());
    });

    const btnCopiar = document.getElementById('btn-copiar-relatorio');
    if (btnCopiar) btnCopiar.addEventListener('click', () => this.copiarRelatorio());

    // Modal é somente WhatsApp (sem PDF no modal)

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.fecharRelatorio();
    });

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredPrompt = e;
      const banner = document.getElementById('install-banner');
      if (banner) banner.classList.add('show');
    });

    const btnInstall = document.getElementById('btn-install');
    if (btnInstall) btnInstall.addEventListener('click', () => this.installPWA());

    window.addEventListener('hashchange', () => this.handleHash());
    this.handleHash();

    // ===== MODO RELATÓRIO / IMPRESSÃO =====
    const btnPrint = document.getElementById('btn-print-relatorio');
    if (btnPrint) btnPrint.addEventListener('click', () => this.imprimirRelatorio());

    const btnRecarregar = document.getElementById('btn-recarregar-iframes');
    if (btnRecarregar) btnRecarregar.addEventListener('click', () => this.recarregarIframes());
  },

  handleHash() {
    const hash = location.hash.replace('#', '') || 'dashboard';
    this.switchTab(hash);
  },

  switchTab(tabId) {
    document.querySelectorAll('.nav-tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.tab === tabId);
    });
    document.querySelectorAll('.section').forEach((s) => {
      s.classList.toggle('active', s.id === `section-${tabId}`);
    });
    if (location.hash !== `#${tabId}`) {
      history.replaceState(null, '', `#${tabId}`);
    }
    // Carrega iframes pesados só quando a aba Relatório fica visível
    // (evita erros de OpenLayers/Matomo e violations de "unload" no dashboard)
    if (tabId === 'relatorio') {
      this.carregarIframesRelatorio();
    }
  },

  /** Carrega os iframes da aba Relatório sob demanda (lazy). */
  carregarIframesRelatorio() {
    document.querySelectorAll('#section-relatorio iframe[data-src]').forEach((iframe) => {
      const url = iframe.getAttribute('data-src');
      if (!url) return;
      // Só atribui se ainda não estiver carregado com a URL real
      if (iframe.dataset.loaded === 'true' && iframe.src && !iframe.src.includes('about:blank')) {
        return;
      }
      iframe.dataset.loaded = 'false';
      iframe.src = url;
      iframe.addEventListener('load', () => {
        iframe.dataset.loaded = 'true';
      }, { once: true });
      iframe.addEventListener('error', () => {
        const page = iframe.closest('.report-page');
        if (page) page.classList.add('iframe-blocked');
      }, { once: true });
    });
  },

  updateClock() {
    const el = document.getElementById('clock');
    if (!el) return;
    const now = new Date();
    el.textContent = now.toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
      timeZone: 'America/Sao_Paulo'
    });
  },

  // ========== DADOS ==========
  async loadAlertasInmet() {
    const container = document.getElementById('alertas-inmet-list');
    const statusDot = document.getElementById('status-inmet');
    if (!container) return;

    container.innerHTML = `
      <div class="loading">
        <div class="spinner"></div>
        Carregando alertas do INMET...
      </div>`;

    try {
      const res = await fetch('https://radarmeteorologico.com.br/api/v1/alertas?uf=MG', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.alertasInmet = data.alertas || data || [];
      this.renderAlertasInmet();
      this.avaliarPrioridades();

      if (statusDot) {
        statusDot.className = 'dot dot-green';
        statusDot.title = 'INMET online';
      }
      this.lastUpdate = new Date();
      this.updateLastUpdate();
    } catch (err) {
      console.error('Erro INMET:', err);
      container.innerHTML = `
        <div class="empty">
          <div class="icon">⚠️</div>
          <p>Não foi possível carregar os alertas do INMET.</p>
          <p class="text-sm mt-1">Verifique a conexão ou acesse diretamente o portal oficial.</p>
          <a href="https://avisos.inmet.gov.br/" target="_blank" rel="noopener" class="btn btn-secondary mt-2">Abrir Avisos INMET</a>
        </div>`;
      if (statusDot) {
        statusDot.className = 'dot dot-red';
        statusDot.title = 'INMET offline';
      }
    }
  },

  renderAlertasInmet() {
    const container = document.getElementById('alertas-inmet-list');
    if (!container) return;

    if (!this.alertasInmet.length) {
      container.innerHTML = `
        <div class="empty">
          <div class="icon">✅</div>
          <p><strong>Nenhum alerta meteorológico ativo para Minas Gerais</strong> no momento.</p>
          <p class="text-sm mt-1">Última verificação: ${new Date().toLocaleTimeString('pt-BR')}</p>
        </div>`;
      return;
    }

    const ordem = { 'Extremo': 4, 'Grande Perigo': 4, 'Perigo': 3, 'Perigo Potencial': 2, 'Atenção': 1 };
    const sorted = [...this.alertasInmet].sort((a, b) => {
      const sa = ordem[a.severidade] || ordem[a.severity] || 0;
      const sb = ordem[b.severidade] || ordem[b.severity] || 0;
      return sb - sa;
    });

    container.innerHTML = sorted.map((a) => {
      const sev = (a.severidade || a.severity || 'Atenção').toLowerCase();
      let levelClass = 'moderado';
      if (sev.includes('extremo') || sev.includes('grande')) levelClass = 'muito-alto';
      else if (sev.includes('perigo') && !sev.includes('potencial')) levelClass = 'alto';

      const nomesMg = this.nomesMunicipiosDoAlerta(a);
      const munCount = nomesMg.length || (typeof a.municipios_afetados === 'number' ? a.municipios_afetados : 0);
      const amostra = nomesMg.slice(0, 12).join(', ');
      const extra = nomesMg.length > 12 ? ` e mais ${nomesMg.length - 12}` : '';
      const riscosTxt = Array.isArray(a.riscos) ? a.riscos.join(' ') : (a.riscos || '');
      const desc = riscosTxt || (Array.isArray(a.instrucoes) ? a.instrucoes[0] : a.instrucoes) || 'Consulte o portal oficial.';

      return `
        <div class="alert-item ${levelClass}">
          <div class="flex items-center gap-1 mb-1">
            <span class="level level-${levelClass === 'muito-alto' ? 'muito-alto' : levelClass === 'alto' ? 'alto' : 'moderado'}">
              ${a.severidade || a.nivel || 'Alerta'}
            </span>
          </div>
          <h3>${a.evento || a.titulo || 'Alerta Meteorológico'}</h3>
          <div class="alert-meta">
            ${a.inicio ? `Início: ${this.formatDate(a.inicio)}` : ''}
            ${a.fim || a.fim_previsto ? ` · Fim: ${this.formatDate(a.fim || a.fim_previsto)}` : ''}
            ${munCount ? ` · ${munCount} município(s) em MG` : ''}
          </div>
          ${nomesMg.length ? `<div class="alert-desc" style="margin-bottom:0.4rem"><strong>Localidades:</strong> ${amostra}${extra}</div>` : ''}
          <div class="alert-desc">${desc}</div>
        </div>`;
    }).join('');
  },

  formatDate(str) {
    if (!str) return '';
    try {
      const d = new Date(str);
      return d.toLocaleString('pt-BR', {
        day: '2-digit', month: '2-digit',
        hour: '2-digit', minute: '2-digit'
      });
    } catch { return str; }
  },

  updateLastUpdate() {
    const el = document.getElementById('last-update');
    if (el && this.lastUpdate) {
      el.textContent = this.lastUpdate.toLocaleTimeString('pt-BR');
    }
  },

  async refreshAll() {
    const btn = document.getElementById('btn-refresh');
    if (btn) { btn.disabled = true; btn.innerHTML = '⏳'; }
    await this.loadAlertasInmet();
    this.updateClock();
    if (btn) { btn.disabled = false; btn.innerHTML = '🔄'; }
  },

  // ========== RELATÓRIO (modal) ==========
  async abrirRelatorio() {
    const modal = document.getElementById('modal-relatorio');
    const pre = document.getElementById('relatorio-texto');
    const status = document.getElementById('relatorio-status');
    if (!modal || !pre) return;

    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    pre.textContent = 'Atualizando alertas e municípios...';
    if (status) status.hidden = true;

    if (!this.municipiosCarregados) {
      await this.loadMunicipiosMg();
    }
    try {
      const res = await fetch('https://radarmeteorologico.com.br/api/v1/alertas?uf=MG', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        this.alertasInmet = data.alertas || data || [];
        this.renderAlertasInmet();
        this.lastUpdate = new Date();
        this.updateLastUpdate();
      }
    } catch (e) {
      console.warn('Não foi possível atualizar alertas antes do relatório', e);
    }

    this.ultimoRelatorioWhatsapp = this.gerarRelatorioWhatsapp();
    this.ultimoRelatorioTexto = this.ultimoRelatorioWhatsapp;
    pre.textContent = this.ultimoRelatorioWhatsapp;
  },

  fecharRelatorio() {
    const modal = document.getElementById('modal-relatorio');
    if (modal) modal.hidden = true;
    document.body.style.overflow = '';
  },

  _texto(valor) {
    if (valor == null) return '';
    if (Array.isArray(valor)) return valor.map(String).filter(Boolean).join(' | ');
    return String(valor).trim();
  },

  _severidadeOrdem(sev) {
    const s = (sev || '').toLowerCase();
    if (s.includes('extremo') || s.includes('grande perigo')) return 4;
    if (s.includes('perigo') && !s.includes('potencial')) return 3;
    if (s.includes('potencial') || s.includes('atenção') || s.includes('moderado')) return 2;
    return 1;
  },

  // ========== PREVISÃO OPEN-METEO ==========
  async loadPrevisaoBH() {
    const box = document.getElementById('previsao-box');
    try {
      const url = 'https://api.open-meteo.com/v1/forecast?latitude=-19.92&longitude=-43.94'
        + '&current=temperature_2m,precipitation,weather_code,wind_speed_10m'
        + '&daily=precipitation_sum,precipitation_probability_max,weather_code,temperature_2m_max,temperature_2m_min'
        + '&timezone=America%2FSao_Paulo&forecast_days=3';
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      this.previsaoBH = await res.json();
      this.renderPrevisao();
    } catch (err) {
      console.warn('Previsão Open-Meteo:', err);
      if (box) {
        box.innerHTML = '<p class="text-sm text-muted">Previsão indisponível no momento. Use o Avisos INMET ou RainViewer.</p>';
      }
    }
  },

  _codigoTempo(code) {
    const map = {
      0: 'Céu limpo', 1: 'Principalmente limpo', 2: 'Parcialmente nublado', 3: 'Nublado',
      45: 'Nevoeiro', 48: 'Nevoeiro com geada',
      51: 'Garoa fraca', 53: 'Garoa', 55: 'Garoa forte',
      61: 'Chuva fraca', 63: 'Chuva', 65: 'Chuva forte',
      66: 'Chuva congelante', 67: 'Chuva congelante forte',
      71: 'Neve fraca', 73: 'Neve', 75: 'Neve forte',
      80: 'Pancadas fracas', 81: 'Pancadas', 82: 'Pancadas fortes',
      95: 'Tempestade', 96: 'Tempestade com granizo', 99: 'Tempestade forte c/ granizo'
    };
    return map[code] || ('Código ' + code);
  },

  renderPrevisao() {
    const box = document.getElementById('previsao-box');
    const d = this.previsaoBH;
    if (!box || !d || !d.current) return;

    const c = d.current;
    const daily = d.daily || {};
    const dias = (daily.time || []).map((t, i) => {
      const data = new Date(t + 'T12:00:00');
      const label = data.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
      const chuva = daily.precipitation_sum ? daily.precipitation_sum[i] : '—';
      const prob = daily.precipitation_probability_max ? daily.precipitation_probability_max[i] : '—';
      const tmax = daily.temperature_2m_max ? daily.temperature_2m_max[i] : '—';
      const tmin = daily.temperature_2m_min ? daily.temperature_2m_min[i] : '—';
      const desc = this._codigoTempo(daily.weather_code ? daily.weather_code[i] : 0);
      return `<div class="previsao-dia">
        <div>${label}</div>
        <strong>${tmax}° / ${tmin}°</strong>
        <div>${desc}</div>
        <div>🌧 ${chuva} mm · ${prob}%</div>
      </div>`;
    }).join('');

    box.innerHTML = `
      <div class="previsao-atual">
        <div class="previsao-temp">${c.temperature_2m}°C</div>
        <div class="previsao-meta">
          <strong>Belo Horizonte agora</strong><br>
          ${this._codigoTempo(c.weather_code)} · Vento ${c.wind_speed_10m} km/h<br>
          Precipitação atual: ${c.precipitation} mm
        </div>
      </div>
      <div class="previsao-dias">${dias}</div>
      <p class="text-sm text-muted mt-1">Fonte: Open-Meteo · Radar visual:
        <a href="https://www.rainviewer.com/map.html?loc=-18.5122,-44.5550,6" target="_blank" rel="noopener">RainViewer MG</a>
      </p>`;
  },

  // ========== VARREDURA / PRIORIDADES ==========
  avaliarPrioridades() {
    const alertas = this.alertasInmet || [];
    const maxSev = alertas.length
      ? Math.max(...alertas.map(a => this._severidadeOrdem(a.severidade || a.nivel)))
      : 0;

    let totalMun = 0;
    const eventos = [];
    alertas.forEach(a => {
      const n = this.nomesMunicipiosDoAlerta(a).length;
      totalMun = Math.max(totalMun, n);
      eventos.push({
        evento: a.evento || 'Alerta',
        sev: a.severidade || a.nivel || '—',
        mun: n,
        ordem: this._severidadeOrdem(a.severidade || a.nivel)
      });
    });

    const temChuva = alertas.some(a => /chuva|tempestade|vendaval|granizo/i.test(a.evento || ''));
    const temAcumulado = alertas.some(a => /acumulado/i.test(a.evento || ''));
    const temTempestade = alertas.some(a => /tempestade|vendaval|raio/i.test(a.evento || ''));

    const portais = [
      { id: 'inmet', nome: 'INMET – Avisos Meteorológicos', link: 'https://avisos.inmet.gov.br/',
        prio: maxSev >= 3 ? 'alta' : maxSev >= 2 ? 'media' : alertas.length ? 'baixa' : 'ok',
        status: alertas.length ? `${alertas.length} alerta(s) ativo(s)` : 'Sem alertas ativos',
        motivo: alertas.length ? `Maior severidade: ${eventos.sort((a,b)=>b.ordem-a.ordem)[0].sev}.` : 'Nenhum aviso oficial vigente para MG.',
        acao: 'Já consolidado nesta PWA — use Gerar Relatório.' },
      { id: 'cemaden-painel', nome: 'CEMADEN – Painel (Hidro + Mov. Massa)', link: 'https://painelalertas.cemaden.gov.br/',
        prio: maxSev >= 3 || temAcumulado ? 'alta' : temChuva ? 'media' : 'info',
        status: maxSev >= 3 || temAcumulado ? 'Verificar agora' : temChuva ? 'Recomendado' : 'Rotina',
        motivo: maxSev >= 2 ? 'Filtrar MG e tipos Risco Hidrológico + Movimentos de Massa.' : 'Sem indício meteorológico forte.',
        acao: 'Abrir painel → filtrar UF=MG e Mov. Massa / Risco Hidro.' },
      { id: 'cemaden-mm', nome: 'CEMADEN – Foco Movimentos de Massa', link: 'https://painelalertas.cemaden.gov.br/',
        prio: temAcumulado || maxSev >= 3 ? 'alta' : temChuva ? 'media' : 'info',
        status: temAcumulado || maxSev >= 3 ? 'Prioridade encostas' : temChuva ? 'Atenção encostas' : 'Rotina',
        motivo: temAcumulado || temChuva ? 'Acumulado eleva risco de deslizamento.' : 'Sem acumulado relevante no INMET.',
        acao: 'No painel, filtrar apenas “Mov. Massa” + MG.' },
      { id: 'sace', nome: 'SACE / SGB – Níveis de rios', link: 'https://www.sgb.gov.br/sace/',
        prio: (maxSev >= 3 && temChuva) || temAcumulado ? 'alta' : temChuva ? 'media' : 'info',
        status: (maxSev >= 3 && temChuva) || temAcumulado ? 'Verificar cotas' : temChuva ? 'Acompanhar' : 'Rotina',
        motivo: temChuva || temAcumulado ? 'Chuva/acumulado eleva risco de cheia nos SAHs.' : 'Sem sinal de cheia no momento.',
        acao: 'Conferir cotas de atenção/alerta nas bacias de interesse.' },
      { id: 'georisk', nome: 'GeoRisk – Deslizamentos', link: 'https://georisk.cemaden.gov.br/',
        prio: temAcumulado || maxSev >= 3 ? 'alta' : temChuva ? 'media' : 'info',
        status: temAcumulado || maxSev >= 3 ? 'Verificar agora' : temChuva ? 'Recomendado' : 'Rotina',
        motivo: temAcumulado || temChuva ? 'Índice de risco em encostas e taludes.' : 'Sem acumulado relevante.',
        acao: 'Checar índice nas regiões com histórico de deslizamento.' },
      { id: 'briefing', nome: 'Briefing CEMADEN–CENAD', link: 'https://www.gov.br/cemaden/pt-br/assuntos/briefing-cemaden-cenad',
        prio: maxSev >= 2 ? 'media' : 'info',
        status: maxSev >= 2 ? 'Leitura recomendada' : 'Rotina diária',
        motivo: 'Resumo técnico diário para Defesas Civis.',
        acao: 'Ler o briefing do dia (manhã).' },
      { id: 'mapa', nome: 'Mapa Interativo CEMADEN', link: 'https://mapainterativo.cemaden.gov.br/',
        prio: temChuva || temAcumulado ? 'media' : 'info',
        status: temChuva ? 'Ver pluviômetros' : 'Disponível',
        motivo: 'Chuva observada em tempo quase real.',
        acao: 'Conferir acumulados horários nas áreas sob alerta.' },
      { id: 'defesa', nome: 'Defesa Civil MG / Emergência MG', link: 'https://www.mg.gov.br/defesacivil',
        prio: maxSev >= 3 ? 'media' : 'info',
        status: maxSev >= 3 ? 'Alinhar com estado' : 'Canais ativos',
        motivo: 'Boletins estaduais, SMS 40199 e Emergência MG.',
        acao: 'Verificar comunicados estaduais se severidade alta.' }
    ];

    let nivelGeral = 'verde';
    if (maxSev >= 4) nivelGeral = 'vermelho';
    else if (maxSev >= 3) nivelGeral = 'laranja';
    else if (maxSev >= 2 || alertas.length) nivelGeral = 'amarelo';

    const prioridade = { nivelGeral, maxSev, totalAlertas: alertas.length, totalMun, eventos, portais, temChuva, temAcumulado, temTempestade };
    this.prioridadeAtual = prioridade;
    this.renderPrioridades(prioridade);
    return prioridade;
  },

  renderPrioridades(p) {
    const banner = document.getElementById('prioridade-resumo');
    const badge = document.getElementById('scan-badge');
    const grid = document.getElementById('portais-status');
    if (!banner || !grid) return;

    const labels = {
      vermelho: '🔴 ATENÇÃO MÁXIMA',
      laranja: '🟠 ATENÇÃO ELEVADA',
      amarelo: '🟡 MONITORAR',
      verde: '🟢 SEM ALERTA METEOROLÓGICO ATIVO'
    };

    banner.className = 'prioridade-banner nivel-' + p.nivelGeral;
    const itens = [];
    if (p.totalAlertas) {
      itens.push(`<li><strong>${p.totalAlertas}</strong> alerta(s) INMET ativos para MG</li>`);
      p.eventos.sort((a,b)=>b.ordem-a.ordem).forEach(e => {
        itens.push(`<li>[${e.sev}] ${e.evento} — ${e.mun} município(s) em MG</li>`);
      });
      const verificar = p.portais.filter(x => x.prio === 'alta').map(x => x.nome.split('–')[0].trim());
      if (verificar.length) itens.push(`<li><strong>Verificar agora:</strong> ${verificar.join(', ')}</li>`);
    } else {
      itens.push('<li>Nenhum alerta INMET vigente. Manter rotina e briefing diário.</li>');
    }

    banner.innerHTML = `
      <div class="prio-titulo">${labels[p.nivelGeral] || labels.verde}</div>
      <ul class="prio-lista">${itens.join('')}</ul>`;

    if (badge) badge.textContent = p.totalAlertas ? `${p.totalAlertas} alerta(s) · varredura ok` : 'Varredura ok';

    const prioLabel = { alta: 'Prioridade ALTA', media: 'Prioridade MÉDIA', baixa: 'Prioridade BAIXA', ok: 'OK', info: 'Rotina' };
    const prioClass = { alta: 'alta', media: 'media', baixa: 'baixa', ok: 'ok', info: 'info' };

    grid.innerHTML = p.portais.map(portal => `
      <div class="portal-card prio-${portal.prio}">
        <div class="portal-nome">${portal.nome}</div>
        <div class="portal-status ${prioClass[portal.prio]}">${prioLabel[portal.prio]} · ${portal.status}</div>
        <div class="portal-motivo">${portal.motivo}</div>
        <div class="card-footer" style="margin:0">
          <a href="${portal.link}" target="_blank" rel="noopener" class="btn ${portal.prio === 'alta' ? 'btn-primary' : 'btn-secondary'}">
            ${portal.prio === 'alta' || portal.prio === 'media' ? 'Abrir agora' : 'Abrir'}
          </a>
        </div>
      </div>`).join('');
  },

  // ========== REGIÕES OPERACIONAIS MG ==========
  _nomeRegiaoPorMunicipio(nome) {
    if (!nome) return null;
    const n = nome.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    // Metropolitana de BH
    if (/belo horizonte|contagem|betim|ribeirao das neves|sabara|santa luzia|vespasiano|ibirite|nova lima|lagoa santa|esmeraldas|pedro leopoldo|matozinhos|confins|raposos|caete|rio acima|brumadinho|sarzedo|mario campos/.test(n))
      return 'Metropolitana';

    // Zona da Mata
    if (/juiz de fora|uba|muriae|leopoldina|alem paraiba|cataguases|visconde do rio branco|sao joao nepomuceno|bicas|santos dumont|rio novo|paiva|merces|ewbank da camara|coronel pacheco|goiana|goiana|ribeirao vermelho|patrocinio do muriae|mirai/.test(n))
      return 'Zona da Mata';

    // Vale do Rio Doce
    if (/governador valadares|caratinga|ipatinga|timoteo|coronel fabriciano|santana do paraiso|mantena|aimores|resplendor|conselheiro pena|tarumirim|inhapim|ipanema|mutum|manhuacu|manhumirim|valadares|fabriciano/.test(n))
      return 'Vale do Rio Doce';

    // Norte de Minas
    if (/montes claros|janauba|pirapora|bocaiuva|salinas|taiobeiras|espinosa|monte azul|gameleiras|mamonas|mato verde|porteirinha|riacho dos machados|serranopolis/.test(n))
      return 'Norte de Minas';

    // Jequitinhonha / Mucuri
    if (/teofilo otoni|nanuque|almenara|aracuai|pedra azul|jordania|agua boa|capelinha|minas novas|turmalina|diamantina|serro/.test(n))
      return 'Jequitinhonha / Mucuri';

    // Sul / Sudoeste
    if (/pouso alegre|varginha|passos|pocos de caldas|itajuba|santa rita do sapucai|extrema|camanducaia|monte siao|tres coracoes|lavras|tres pontas|eloi mendes/.test(n))
      return 'Sul / Sudoeste';

    // Triângulo / Alto Paranaíba
    if (/uberlandia|uberaba|patos de minas|araguari|ituiutaba|frutal|prata|monte carmelo|coromandel|patrocinio|araxa|sacramento/.test(n))
      return 'Triângulo / Alto Paranaíba';

    // Noroeste
    if (/unai|paracatu|joao pinheiro|brasilandia|guarda-mor|guarda mor|lagamar|presidente olegario/.test(n))
      return 'Noroeste';

    // Central
    if (/sete lagoas|curvelo|tres marias|pompeu|bom despacho|luz|martinho campos|papagaios|para de minas|itabirito|ouro preto|mariana|congonhas|conselheiro lafaiete|barbacena|sao joao del rei|tiradentes/.test(n))
      return 'Central';

    return null; // município sem região definida → não entra na lista
  },

  regioesDoAlerta(alerta) {
    const geos = alerta.geocodes || [];
    const contagem = {};
    const vistos = new Set();

    const contabilizar = (nome) => {
      if (!nome || vistos.has(nome)) return;
      vistos.add(nome);
      const reg = this._nomeRegiaoPorMunicipio(nome);
      if (!reg) return; // ignora null / indefinido
      contagem[reg] = (contagem[reg] || 0) + 1;
    };

    geos.forEach((g) => {
      const code = String(g);
      if (!code.startsWith('31')) return;
      contabilizar(this.municipiosMg[code]);
    });

    // Fallback se nenhum município foi classificado pelos geocodes
    if (!Object.keys(contagem).length) {
      this.nomesMunicipiosDoAlerta(alerta).forEach(contabilizar);
    }

    return Object.entries(contagem)
      .sort((a, b) => b[1] - a[1])
      .map(([reg, qtd]) => ({ reg, qtd }));
  },

  // ========== RELATÓRIO WHATSAPP (melhorado) ==========
  gerarRelatorioWhatsapp() {
    const agora = new Date();
    const dataStr = agora.toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
      timeZone: 'America/Sao_Paulo'
    });

    const p = this.prioridadeAtual || this.avaliarPrioridades();
    const alertas = [...(this.alertasInmet || [])].sort(
      (a, b) => this._severidadeOrdem(b.severidade || b.nivel) -
                this._severidadeOrdem(a.severidade || a.nivel)
    );

    const L = [];

    // —— Cabeçalho ——
    L.push('*🚨 RESUMO OPERACIONAL – RISCOS CHUVAS MG*');
    L.push(`CBMMG · ${dataStr}`);
    L.push('');

    // —— Sem alertas ——
    if (!alertas.length) {
      L.push('✅ *Sem alertas meteorológicos INMET ativos* para Minas Gerais.');
      L.push('');
      L.push('*Rotina recomendada:*');
      L.push('• Briefing CEMADEN–CENAD');
      L.push('• SACE (níveis de rios)');
      L.push('• GeoRisk (encostas)');
      L.push('');
    } else {
      // —— Nível geral ——
      const emojiNivel = p.nivelGeral === 'vermelho' ? '🔴' :
                         p.nivelGeral === 'laranja'  ? '🟠' : '🟡';
      const labelNivel = p.nivelGeral === 'vermelho' ? 'ATENÇÃO MÁXIMA' :
                         p.nivelGeral === 'laranja'  ? 'ATENÇÃO ELEVADA' : 'MONITORAR';

      L.push(`${emojiNivel} *${labelNivel}* — ${alertas.length} alerta(s) INMET ativos`);
      L.push('');

      // —— Cada alerta ——
      alertas.forEach((a, i) => {
        const sev = a.severidade || a.nivel || '—';
        const ev  = a.evento || a.titulo || 'Alerta Meteorológico';
        const nomesMg = this.nomesMunicipiosDoAlerta(a);
        const regioes = this.regioesDoAlerta(a);
        const inicio = this.formatDate(a.inicio || a.data_inicio);
        const fim    = this.formatDate(a.fim || a.fim_previsto || a.data_fim);

        L.push('━━━━━━━━━━━━━━━━━━━━');
        L.push(`*${i + 1}. [${sev}] ${ev}*`);

        if (inicio || fim) {
          L.push(`📅 ${inicio || '?'}${fim ? ' → ' + fim : ''}`);
        }

        // Regiões (sem null e sem "Outras regiões")
        if (regioes.length) {
          const textoReg = regioes
            .filter(r => r.reg && r.reg !== 'null' && r.reg !== 'Outras regiões')
            .slice(0, 4)
            .map(r => r.reg)
            .join(' · ');
          if (textoReg) L.push(`📍 *Regiões:* ${textoReg}`);
        }

        // Quantidade + amostra de municípios
        if (nomesMg.length) {
          const amostra = nomesMg.slice(0, 10).join(', ');
          const extra = nomesMg.length > 10 ? ` _(+${nomesMg.length - 10})_` : '';
          L.push(`🏘 ${nomesMg.length} município(s)`);
        }

        // Riscos (quando a API manda)
        const riscos = Array.isArray(a.riscos) ? a.riscos : (a.riscos ? [a.riscos] : []);
        if (riscos.length) {
          const txt = riscos.map(r => this._texto(r)).filter(Boolean).join('; ');
          if (txt) L.push(`⚠️ *Riscos:* ${txt}`);
        }

        L.push('');
      });

      L.push('━━━━━━━━━━━━━━━━━━━━');
      L.push('');

      // —— O que fazer agora (mais específico) ——
      L.push('*🎯 O QUE FAZER AGORA (CBMMG)*');

      if (p.maxSev >= 4) {
        L.push('• Ativar plano de contingência nas regiões sob alerta');
        L.push('• Reforçar pronta-resposta e scale de equipes');
      } else if (p.maxSev >= 3) {
        L.push('• Reforçar pronta-resposta nas regiões listadas');
      } else {
        L.push('• Manter vigilância reforçada nos municípios sob alerta');
      }

      if (p.temAcumulado || (p.temChuva && p.maxSev >= 2)) {
        L.push('• *Encostas:* abrir GeoRisk + Painel CEMADEN (filtro Mov. Massa + MG)');
        L.push('• *Rios:* conferir cotas SACE das bacias com chuva forte (Doce, Pomba, Muriaé, Velhas…)');
      } else if (p.temChuva) {
        L.push('• Acompanhar evolução da chuva no Mapa Interativo / Ventusky');
        L.push('• Se houver acumulado local → verificar SACE e GeoRisk');
      }

      if (p.temTempestade) {
        L.push('• Atenção a vento forte, queda de árvore e raios');
      }

      L.push('');
    }

    // —— Previsão BH (curta) ——
    if (this.previsaoBH && this.previsaoBH.daily) {
      const dd = this.previsaoBH.daily;
      L.push('*🌧️ Previsão BH (próx. 3 dias)*');
      (dd.time || []).slice(0, 3).forEach((t, i) => {
        const data = new Date(t + 'T12:00:00');
        const label = data.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit' });
        const chuva = dd.precipitation_sum != null ? dd.precipitation_sum[i] : '—';
        const prob  = dd.precipitation_probability_max != null ? dd.precipitation_probability_max[i] : '—';
        L.push(`• ${label}: ${chuva} mm (${prob}%)`);
      });
      L.push('');
    }

    // —— Links prioritários (só os mais úteis) ——
    L.push('*🔗 Links prioritários*');
    L.push('• Painel CEMADEN: https://painelalertas.cemaden.gov.br/');
    L.push('• GeoRisk: https://georisk.cemaden.gov.br/');
    L.push('• SACE (rios): https://www.sgb.gov.br/sace/');
    L.push('• Avisos INMET: https://avisos.inmet.gov.br/');
    L.push('• Mapa Interativo: https://mapainterativo.cemaden.gov.br/');
    L.push('• Ventusky MG: https://www.ventusky.com/?p=-18.5;-44.5;6&l=rain');
    L.push('');
    L.push('_Resumo teste · sob avaliação da BM3_');

    return L.join('\n');
  },

  gerarRelatorioDetalhado() {
    const agora = new Date();
    const hora = agora.getHours();
    const periodo = hora < 12 ? 'MANHÃ' : hora >= 18 ? 'NOITE' : 'TARDE';
    const dataStr = agora.toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
    });

    const alertas = [...(this.alertasInmet || [])].sort(
      (a, b) => this._severidadeOrdem(a.severidade || a.severity) -
                this._severidadeOrdem(b.severidade || b.severity)
    ).reverse();

    const linhas = [];
    linhas.push('========================================');
    linhas.push('  RELATÓRIO DETALHADO – MINAS GERAIS');
    linhas.push('  CBMMG / Defesa Civil');
    linhas.push('========================================');
    linhas.push(`  Emissão: ${dataStr} (${periodo})`);
    linhas.push('  Fonte: INMET (alertas oficiais)');
    linhas.push('========================================');
    linhas.push('');

    const prio = this.prioridadeAtual || this.avaliarPrioridades();
    linhas.push('0. PRIORIDADES PARA PLANEJAMENTO (CBMMG)');
    linhas.push('----------------------------------------');
    linhas.push(`  Nível geral: ${prio.nivelGeral.toUpperCase()}`);
    linhas.push(`  Alertas INMET: ${prio.totalAlertas}`);
    prio.portais.filter(x => x.prio === 'alta' || x.prio === 'media').forEach(x => {
      linhas.push(`  • [${x.prio.toUpperCase()}] ${x.nome}`);
      linhas.push(`    ${x.motivo}`);
      linhas.push(`    → ${x.acao}`);
    });
    if (!prio.portais.filter(x => x.prio === 'alta' || x.prio === 'media').length) {
      linhas.push('  • Nenhuma prioridade elevada. Manter rotina de briefing.');
    }
    linhas.push('');

    if (this.previsaoBH && this.previsaoBH.daily) {
      const dd = this.previsaoBH.daily;
      const cur = this.previsaoBH.current || {};
      linhas.push('PREVISÃO – BELO HORIZONTE (Open-Meteo)');
      linhas.push('----------------------------------------');
      if (cur.temperature_2m != null) {
        linhas.push(`  Agora: ${cur.temperature_2m}°C · ${this._codigoTempo(cur.weather_code)} · vento ${cur.wind_speed_10m} km/h`);
      }
      (dd.time || []).forEach((t, i) => {
        const data = new Date(t + 'T12:00:00');
        const label = data.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' });
        const chuva = dd.precipitation_sum ? dd.precipitation_sum[i] : '—';
        const prob = dd.precipitation_probability_max ? dd.precipitation_probability_max[i] : '—';
        const tmax = dd.temperature_2m_max ? dd.temperature_2m_max[i] : '—';
        const tmin = dd.temperature_2m_min ? dd.temperature_2m_min[i] : '—';
        linhas.push(`  ${label}: ${tmax}°/${tmin}° · chuva ${chuva} mm (prob. ${prob}%) · ${this._codigoTempo(dd.weather_code ? dd.weather_code[i] : 0)}`);
      });
      linhas.push('');
    }

    linhas.push('1. ALERTAS METEOROLÓGICOS ATIVOS (MG)');
    linhas.push('----------------------------------------');
    if (!alertas.length) {
      linhas.push('  ✅ Nenhum alerta meteorológico ativo para Minas Gerais.');
    } else {
      linhas.push(`  Total de alertas: ${alertas.length}`);
      linhas.push('');
      alertas.forEach((a, idx) => {
        const evento = this._texto(a.evento || a.titulo) || 'Alerta Meteorológico';
        const sev = this._texto(a.severidade || a.severity) || '—';
        const inicio = this._texto(a.inicio || a.data_inicio);
        const fim = this._texto(a.fim || a.fim_previsto || a.data_fim);
        const nomesMg = this.nomesMunicipiosDoAlerta(a);
        const riscos = Array.isArray(a.riscos) ? a.riscos : (a.riscos ? [a.riscos] : []);
        const instrucoes = Array.isArray(a.instrucoes) ? a.instrucoes : (a.instrucoes ? [a.instrucoes] : []);
        linhas.push(`━━━ Alerta ${idx + 1}/${alertas.length} ━━━`);
        linhas.push(`• [${sev}] ${evento}`);
        if (inicio || fim) linhas.push(`  Período: ${inicio}${fim ? ' até ' + fim : ''}`);
        linhas.push(`  Municípios de MG afetados: ${nomesMg.length}`);
        if (nomesMg.length) {
          let linhaAtual = '  → ';
          nomesMg.forEach((nome, i) => {
            const pedaco = nome + (i < nomesMg.length - 1 ? ', ' : '');
            if (linhaAtual.length + pedaco.length > 72 && linhaAtual.length > 4) {
              linhas.push(linhaAtual);
              linhaAtual = '    ' + pedaco;
            } else linhaAtual += pedaco;
          });
          if (linhaAtual.trim().length > 0) linhas.push(linhaAtual);
        }
        if (riscos.length) {
          linhas.push('  Riscos:');
          riscos.forEach(r => { const t = this._texto(r); if (t) linhas.push(`    • ${t}`); });
        }
        if (instrucoes.length) {
          linhas.push('  Instruções:');
          instrucoes.forEach(ins => { const t = this._texto(ins); if (t) linhas.push(`    • ${t}`); });
        }
        linhas.push('');
      });
    }

    linhas.push('2. ORIENTAÇÃO RÁPIDA DE AÇÃO');
    linhas.push('----------------------------------------');
    if (!alertas.length) {
      linhas.push('  • Manter monitoramento de rotina (SACE + Painel CEMADEN + GeoRisk).');
      linhas.push('  • Consultar briefing diário do CEMADEN.');
    } else {
      const maxSev = Math.max(...alertas.map(a => this._severidadeOrdem(a.severidade || a.severity)));
      if (maxSev >= 4) {
        linhas.push('  🔴 SEVERIDADE ALTA / EXTREMA');
        linhas.push('  → Ativar plano de contingência.');
        linhas.push('  → Acompanhar SACE e GeoRisk em tempo real.');
      } else if (maxSev >= 3) {
        linhas.push('  🟠 SEVERIDADE MODERADA / ALTA');
        linhas.push('  → Reforçar monitoramento de rios (SACE) e encostas (GeoRisk).');
        linhas.push('  → Preparar equipes conforme protocolo local.');
      } else {
        linhas.push('  🟡 Atenção / Perigo Potencial');
        linhas.push('  → Manter vigilância nos municípios listados.');
        linhas.push('  → Consultar Painel CEMADEN + SACE.');
      }
    }
    linhas.push('');
    linhas.push('========================================');
    linhas.push('  Confirme sempre nos portais oficiais.');
    linhas.push('========================================');

    return linhas.join('\n');
  },

  async copiarRelatorio() {
    const status = document.getElementById('relatorio-status');
    const texto = this.ultimoRelatorioWhatsapp || this.ultimoRelatorioTexto || document.getElementById('relatorio-texto')?.textContent || '';
    try {
      await navigator.clipboard.writeText(texto);
      if (status) {
        status.hidden = false;
        status.className = 'relatorio-status ok';
        status.textContent = '✅ Texto copiado! Cole no grupo do WhatsApp.';
        setTimeout(() => { status.hidden = true; }, 3500);
      }
    } catch (e) {
      const pre = document.getElementById('relatorio-texto');
      if (pre) {
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      if (status) {
        status.hidden = false;
        status.className = 'relatorio-status erro';
        status.textContent = 'Selecione o texto e copie manualmente (Ctrl+C / Cmd+C).';
      }
    }
  },

  async baixarPdf() {
    const status = document.getElementById('relatorio-status');
    if (typeof window.jspdf === 'undefined' && typeof window.jsPDF === 'undefined') {
      if (status) {
        status.hidden = false;
        status.className = 'relatorio-status erro';
        status.textContent = 'Biblioteca PDF ainda carregando. Tente em 2 segundos.';
      }
      return;
    }
    if (typeof html2canvas === 'undefined') {
      if (status) {
        status.hidden = false;
        status.className = 'relatorio-status erro';
        status.textContent = 'html2canvas não carregou. Atualize a página (Ctrl+Shift+R).';
      }
      return;
    }
    if (status) {
      status.hidden = false;
      status.className = 'relatorio-status';
      status.textContent = 'Gerando PDF visual (mapa + cards)...';
    }

    let el = null;
    try {
      if (!this.prioridadeAtual) this.avaliarPrioridades();
      if (!this.previsaoBH) { try { await this.loadPrevisaoBH(); } catch (_) {} }

      el = this.montarPainelVisualPdf();
      document.body.appendChild(el);
      await this._esperarImagens(el, 4000);

      const canvas = await html2canvas(el, {
        scale: 2, useCORS: true, allowTaint: true,
        backgroundColor: '#0f172a', logging: false,
        width: 800, windowWidth: 800
      });

      const { jsPDF } = window.jspdf || window;
      const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
      const pageW = 210, pageH = 297, margin = 8;
      const imgW = pageW - margin * 2;
      const imgH = (canvas.height * imgW) / canvas.width;
      const pageContentH = pageH - margin * 2;
      const totalPages = Math.max(1, Math.ceil(imgH / pageContentH));
      const pxPerMm = canvas.width / imgW;

      for (let page = 0; page < totalPages; page++) {
        if (page > 0) doc.addPage();
        const srcY = page * pageContentH * pxPerMm;
        const srcH = Math.min(pageContentH * pxPerMm, canvas.height - srcY);
        const slice = document.createElement('canvas');
        slice.width = canvas.width;
        slice.height = Math.max(1, Math.floor(srcH));
        const ctx = slice.getContext('2d');
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, slice.width, slice.height);
        ctx.drawImage(canvas, 0, srcY, canvas.width, srcH, 0, 0, canvas.width, srcH);
        const sliceH = (slice.height * imgW) / slice.width;
        doc.addImage(slice.toDataURL('image/jpeg', 0.92), 'JPEG', margin, margin, imgW, sliceH);
      }

      const texto = this.ultimoRelatorioDetalhado || '';
      if (texto.length > 400 && (this.alertasInmet || []).length) {
        doc.addPage();
        doc.setFillColor(220, 38, 38);
        doc.rect(0, 0, 210, 10, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(11);
        doc.setFont('helvetica', 'bold');
        doc.text('Anexo – Lista completa de municípios e riscos', 8, 7);
        doc.setTextColor(30, 30, 30);
        doc.setFontSize(8);
        doc.setFont('helvetica', 'normal');
        let y = 16;
        doc.splitTextToSize(texto, 194).forEach((linha) => {
          if (y > 285) { doc.addPage(); y = 16; }
          doc.text(linha, 8, y);
          y += 3.8;
        });
      }

      const nome = `resumo-riscos-mg_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.pdf`;
      doc.save(nome);

      if (status) {
        status.hidden = false;
        status.className = 'relatorio-status ok';
        status.textContent = '✅ PDF visual baixado.';
        setTimeout(() => { status.hidden = true; }, 4000);
      }
    } catch (err) {
      console.error('PDF visual:', err);
      if (status) {
        status.hidden = false;
        status.className = 'relatorio-status erro';
        status.textContent = 'Erro no PDF visual. Tentando versão texto...';
      }
      this._baixarPdfTextoFallback();
    } finally {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }
  },

  _esperarImagens(root, timeoutMs) {
    const imgs = Array.from(root.querySelectorAll('img'));
    if (!imgs.length) return Promise.resolve();
    return new Promise((resolve) => {
      let left = imgs.length;
      const done = () => { left -= 1; if (left <= 0) resolve(); };
      const timer = setTimeout(resolve, timeoutMs);
      imgs.forEach((img) => {
        if (img.complete) done();
        else { img.onload = done; img.onerror = done; }
      });
      if (left <= 0) { clearTimeout(timer); resolve(); }
    });
  },

  montarPainelVisualPdf() {
    const p = this.prioridadeAtual || this.avaliarPrioridades();
    const alertas = this.alertasInmet || [];
    const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    const labels = {
      vermelho: '🔴 ATENÇÃO MÁXIMA',
      laranja: '🟠 ATENÇÃO ELEVADA',
      amarelo: '🟡 MONITORAR',
      verde: '🟢 SEM ALERTA METEOROLÓGICO ATIVO'
    };

    const itensBanner = [];
    if (p.totalAlertas) {
      itensBanner.push(`<li><strong>${p.totalAlertas}</strong> alerta(s) INMET ativos para MG</li>`);
      (p.eventos || []).sort((a, b) => b.ordem - a.ordem).forEach((e) => {
        itensBanner.push(`<li>[${e.sev}] ${e.evento} — ${e.mun} município(s)</li>`);
      });
      const altas = (p.portais || []).filter((x) => x.prio === 'alta').map((x) => x.nome.split('–')[0].trim());
      if (altas.length) itensBanner.push(`<li><strong>Verificar agora:</strong> ${altas.join(', ')}</li>`);
    } else {
      itensBanner.push('<li>Nenhum alerta INMET vigente. Manter rotina e briefing.</li>');
    }

    let forecastHtml = '<p style="font-size:12px;color:#94a3b8">Previsão indisponível</p>';
    if (this.previsaoBH && this.previsaoBH.daily) {
      const dd = this.previsaoBH.daily;
      const cur = this.previsaoBH.current || {};
      const days = (dd.time || []).map((t, i) => {
        const data = new Date(t + 'T12:00:00');
        const label = data.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit' });
        const chuva = dd.precipitation_sum ? dd.precipitation_sum[i] : '—';
        const prob = dd.precipitation_probability_max ? dd.precipitation_probability_max[i] : '—';
        const tmax = dd.temperature_2m_max ? dd.temperature_2m_max[i] : '—';
        const tmin = dd.temperature_2m_min ? dd.temperature_2m_min[i] : '—';
        const desc = this._codigoTempo(dd.weather_code ? dd.weather_code[i] : 0);
        return `<div class="pv-day"><div>${label}</div><strong>${tmax}°/${tmin}°</strong><div>${desc}</div><div>🌧 ${chuva} mm · ${prob}%</div></div>`;
      }).join('');
      forecastHtml = `
        <div style="font-size:12px;margin-bottom:8px">Agora em BH: <strong>${cur.temperature_2m != null ? cur.temperature_2m + '°C' : '—'}</strong>
          · ${this._codigoTempo(cur.weather_code)} · vento ${cur.wind_speed_10m || '—'} km/h</div>
        <div class="pv-forecast">${days}</div>`;
    }

    let alertasHtml = '<p style="font-size:12px;color:#94a3b8">Nenhum alerta ativo</p>';
    if (alertas.length) {
      alertasHtml = alertas.map((a) => {
        const sev = (a.severidade || '').toLowerCase();
        let cls = 'baixo';
        if (sev.includes('extremo') || (sev.includes('perigo') && !sev.includes('potencial'))) cls = 'alto';
        else if (sev.includes('perigo')) cls = 'medio';
        const nomes = this.nomesMunicipiosDoAlerta(a);
        const amostra = nomes.slice(0, 15).join(', ') + (nomes.length > 15 ? ` … +${nomes.length - 15}` : '');
        const riscos = Array.isArray(a.riscos) ? a.riscos.join(' ') : (a.riscos || '');
        return `<div class="pv-alert ${cls}">
          <h4>[${a.severidade || a.nivel}] ${a.evento || 'Alerta'}</h4>
          <div class="meta">${a.inicio || ''} → ${a.fim || ''} · ${nomes.length} município(s) em MG</div>
          ${amostra ? `<div style="margin-top:4px">${amostra}</div>` : ''}
          ${riscos ? `<div style="margin-top:4px;color:#cbd5e1">${riscos}</div>` : ''}
        </div>`;
      }).join('');
    }

    const portaisHtml = (p.portais || [])
      .filter((x) => x.prio === 'alta' || x.prio === 'media' || x.prio === 'ok')
      .slice(0, 6)
      .map((x) => `<div class="pv-portal ${x.prio}"><strong>${x.nome}</strong>${x.status}<br><span style="color:#94a3b8">${x.acao}</span></div>`)
      .join('');

    const mapUrl = 'https://staticmap.openstreetmap.de/staticmap.php?center=-18.5,-44.5&zoom=6&size=752x320&maptype=mapnik&markers=-19.92,-43.94,red-pushpin';

    const el = document.createElement('div');
    el.id = 'pdf-visual-capture';
    el.innerHTML = `
      <div class="pv-header">
        <h1>CBMMG / Defesa Civil — Resumo de Riscos MG</h1>
        <p>Emissão: ${agora} · Fontes: INMET · Open-Meteo · Portais oficiais</p>
      </div>
      <div class="pv-banner ${p.nivelGeral}">
        <h2>${labels[p.nivelGeral] || labels.verde}</h2>
        <ul>${itensBanner.join('')}</ul>
      </div>
      <div class="pv-map">
        <img src="${mapUrl}" alt="Mapa MG" crossorigin="anonymous" />
        <div class="pv-map-caption">Mapa de referência — MG (marcador: BH).</div>
      </div>
      <div class="pv-section">
        <h3>Previsão — Belo Horizonte (Open-Meteo)</h3>
        ${forecastHtml}
      </div>
      <div class="pv-section">
        <h3>Alertas meteorológicos (INMET / MG)</h3>
        ${alertasHtml}
      </div>
      <div class="pv-section">
        <h3>Portais prioritários para bombeiros</h3>
        <div class="pv-portais">${portaisHtml || '<p style="font-size:12px">Rotina normal</p>'}</div>
      </div>
      <div class="pv-footer">
        Documento de apoio operacional · Não substitui análise técnica oficial
      </div>`;
    return el;
  },

  _baixarPdfTextoFallback() {
    try {
      const { jsPDF } = window.jspdf || window;
      const doc = new jsPDF({ unit: 'mm', format: 'a4' });
      const texto = this.ultimoRelatorioDetalhado || this.ultimoRelatorioWhatsapp || '';
      doc.setFillColor(220, 38, 38);
      doc.rect(0, 0, 210, 10, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(11);
      doc.text('CBMMG – Resumo de Riscos MG (texto)', 14, 7);
      doc.setTextColor(30, 30, 30);
      doc.setFontSize(8.5);
      let y = 18;
      doc.splitTextToSize(texto, 182).forEach((linha) => {
        if (y > 280) { doc.addPage(); y = 16; }
        doc.text(linha, 14, y);
        y += 4;
      });
      doc.save(`resumo-riscos-mg-texto_${Date.now()}.pdf`);
    } catch (e) { console.error(e); }
  },

  // ========== MODO RELATÓRIO / IMPRESSÃO ==========
  _verificarIframesCarregados(timeoutMs = 10000) {
    const iframes = Array.from(document.querySelectorAll('#section-relatorio iframe'));
    if (!iframes.length) return Promise.resolve();

    const promises = iframes.map((iframe) => new Promise((resolve) => {
      let resolvido = false;
      const done = () => { if (!resolvido) { resolvido = true; resolve(); } };

      if (iframe.dataset.loaded === 'true') return done();

      iframe.addEventListener('load', () => {
        iframe.dataset.loaded = 'true';
        done();
      }, { once: true });

      iframe.addEventListener('error', () => {
        const page = iframe.closest('.report-page');
        if (page) page.classList.add('iframe-blocked');
        done();
      }, { once: true });

      setTimeout(done, timeoutMs);
    }));

    return Promise.race([
      Promise.all(promises),
      new Promise((r) => setTimeout(r, timeoutMs + 1000))
    ]);
  },

  async imprimirRelatorio() {
    const btn = document.getElementById('btn-print-relatorio');
    const original = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Preparando impressão...'; }

    try {
      // Garante que estamos na aba Relatório para o layout de impressão
      this.switchTab('relatorio');

      // Carimba hora em cada cabeçalho
      const carimbo = new Date().toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
      document.querySelectorAll('#section-relatorio .report-page-time').forEach((el) => {
        el.textContent = `Gerado em ${carimbo}`;
      });

      await this._verificarIframesCarregados(12000);
      // Pequena pausa extra para o navegador estabilizar o layout dos iframes
      await new Promise((r) => setTimeout(r, 1200));

      window.print();
    } catch (err) {
      console.error('Erro na impressão:', err);
      alert('Não foi possível preparar a impressão. Tente novamente ou use "Abrir em nova aba".');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = original; }
    }
  },

  async recarregarIframes() {
    const btn = document.getElementById('btn-recarregar-iframes');
    const original = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Recarregando...'; }

    document.querySelectorAll('#section-relatorio .report-page').forEach((page) => {
      page.classList.remove('iframe-blocked');
    });

    document.querySelectorAll('#section-relatorio iframe').forEach((iframe) => {
      const src = iframe.getAttribute('data-src') || iframe.src;
      iframe.dataset.loaded = 'false';
      iframe.src = 'about:blank';
      setTimeout(() => { iframe.src = src; }, 100);
    });

    setTimeout(() => {
      if (btn) { btn.disabled = false; btn.innerHTML = original; }
    }, 2000);
  },

  async baixarPdfComLinks() {
    const status = document.getElementById('relatorio-status');

    if (typeof window.jspdf === 'undefined') {
      if (status) {
        status.hidden = false;
        status.className = 'relatorio-status erro';
        status.textContent = 'Biblioteca PDF ainda carregando. Tente em 2 segundos.';
      }
      return;
    }
    if (typeof html2canvas === 'undefined') {
      if (status) {
        status.hidden = false;
        status.className = 'relatorio-status erro';
        status.textContent = 'html2canvas não carregou. Recarregue a página (Ctrl+Shift+R).';
      }
      return;
    }
    if (status) {
      status.hidden = false;
      status.className = 'relatorio-status';
      status.textContent = 'Gerando PDF resumo (com links dos painéis)...';
    }

    let el = null;
    try {
      if (!this.prioridadeAtual) this.avaliarPrioridades();
      if (!this.previsaoBH) { try { await this.loadPrevisaoBH(); } catch (_) {} }

      el = this.montarPainelVisualPdf();
      document.body.appendChild(el);
      await this._esperarImagens(el, 4000);

      const canvas = await html2canvas(el, {
        scale: 2, useCORS: true, allowTaint: true,
        backgroundColor: '#0f172a', logging: false,
        width: 800, windowWidth: 800
      });

      const { jsPDF } = window.jspdf || window;
      const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
      const pageW = 210, pageH = 297, margin = 8;
      const imgW = pageW - margin * 2;
      const imgH = (canvas.height * imgW) / canvas.width;
      const pageContentH = pageH - margin * 2;
      const totalPages = Math.max(1, Math.ceil(imgH / pageContentH));
      const pxPerMm = canvas.width / imgW;

      for (let page = 0; page < totalPages; page++) {
        if (page > 0) doc.addPage();
        const srcY = page * pageContentH * pxPerMm;
        const srcH = Math.min(pageContentH * pxPerMm, canvas.height - srcY);
        const slice = document.createElement('canvas');
        slice.width = canvas.width;
        slice.height = Math.max(1, Math.floor(srcH));
        const ctx = slice.getContext('2d');
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, slice.width, slice.height);
        ctx.drawImage(canvas, 0, srcY, canvas.width, srcH, 0, 0, canvas.width, srcH);
        const sliceH = (slice.height * imgW) / slice.width;
        doc.addImage(slice.toDataURL('image/jpeg', 0.92), 'JPEG', margin, margin, imgW, sliceH);
      }

      // Página final: links clicáveis
      doc.addPage();
      doc.setFillColor(220, 38, 38);
      doc.rect(0, 0, 210, 10, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      doc.text('Painéis oficiais para consulta (links clicáveis)', 8, 7);
      doc.setTextColor(30, 30, 30);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      doc.text(
        'Restrições de segurança do navegador impedem capturar o conteúdo dos iframes no PDF. Use este índice para acessar os painéis oficiais diretamente.',
        8, 16, { maxWidth: 194 }
      );

      const paineis = [
        ['Painel de Alertas CEMADEN', 'https://painelalertas.cemaden.gov.br/'],
        ['GeoRisk – Deslizamentos (CEMADEN)', 'https://georisk.cemaden.gov.br/'],
        ['Mapa Interativo CEMADEN', 'https://mapainterativo.cemaden.gov.br/'],
        ['Avisos INMET', 'https://avisos.inmet.gov.br/'],
        ['SACE – Níveis de Rios (SGB)', 'https://www.sgb.gov.br/sace/'],
        ['Boletim Defesa Civil MG (Power BI)', 'https://app.powerbi.com/view?r=eyJrIjoiNjI0YWM4MTYtZTRkNy00ZTYzLTgxOGUtNjYyNjdkYWRhMzY3IiwidCI6ImIwZTM3MWRkLWEwMjUtNGZlOC05MThiLTM0YjkxMWFkNWJiOSJ9'],
        ['SAR – Reservatórios (ANA)', 'https://anagovbr.github.io/painel-marcos-regulatorios/#mapa'],
        ['Briefing CEMADEN-CENAD', 'https://www.gov.br/cemaden/pt-br/assuntos/briefing-cemaden-cenad']
      ];

      let y = 28;
      paineis.forEach(([titulo, url], i) => {
        if (y > 270) { doc.addPage(); y = 20; }
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(30, 30, 30);
        doc.text(`${i + 1}. ${titulo}`, 8, y);
        y += 4.5;
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(29, 78, 216);
        doc.textWithLink(url, 12, y, { url });
        y += 7;
      });

      const texto = this.ultimoRelatorioDetalhado || '';
      if (texto.length > 400 && (this.alertasInmet || []).length) {
        doc.addPage();
        doc.setFillColor(220, 38, 38);
        doc.rect(0, 0, 210, 10, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(11);
        doc.setFont('helvetica', 'bold');
        doc.text('Anexo – Lista completa de municípios e riscos', 8, 7);
        doc.setTextColor(30, 30, 30);
        doc.setFontSize(8);
        doc.setFont('helvetica', 'normal');
        let yy = 16;
        doc.splitTextToSize(texto, 194).forEach((linha) => {
          if (yy > 285) { doc.addPage(); yy = 16; }
          doc.text(linha, 8, yy);
          yy += 3.8;
        });
      }

      const nome = `resumo-riscos-mg_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.pdf`;
      doc.save(nome);

      if (status) {
        status.hidden = false;
        status.className = 'relatorio-status ok';
        status.textContent = '✅ PDF resumo gerado (com links + anexo).';
        setTimeout(() => { status.hidden = true; }, 4000);
      }
    } catch (err) {
      console.error('PDF com links:', err);
      if (status) {
        status.hidden = false;
        status.className = 'relatorio-status erro';
        status.textContent = 'Erro ao gerar o PDF. Tente novamente.';
      }
    } finally {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }
  },

  // ========== PWA INSTALL ==========
  checkInstallPrompt() {
    if (window.matchMedia('(display-mode: standalone)').matches) {
      const banner = document.getElementById('install-banner');
      if (banner) banner.style.display = 'none';
    }
  },

  async installPWA() {
    if (!this.deferredPrompt) return;
    this.deferredPrompt.prompt();
    const { outcome } = await this.deferredPrompt.userChoice;
    console.log('Install outcome:', outcome);
    this.deferredPrompt = null;
    const banner = document.getElementById('install-banner');
    if (banner) banner.classList.remove('show');
  }
};

document.addEventListener('DOMContentLoaded', () => APP.init());
