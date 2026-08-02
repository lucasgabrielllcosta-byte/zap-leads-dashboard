// Cliente da API do Zap Responder + lógica de classificação (regex) trazida do
// projeto zap-dashboard-sync — mesma "inteligência" já validada lá, reaproveitada
// aqui pra alimentar o dashboard sem duplicar/discordar da lógica original.

const BASE_URL = process.env.ZAP_BASE_URL || 'https://api.zapresponder.com.br';
const TOKEN = process.env.ZAP_API_TOKEN;

export async function apiGet(path, internal = false) {
  const headers = { Authorization: `Bearer ${TOKEN}` };
  if (internal) headers['x-zr-client-app'] = 'app-client';
  const res = await fetch(`${BASE_URL}${path}`, { headers });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i]);
      } catch (err) {
        results[i] = { error: err.message };
      }
      done++;
      if (done % 200 === 0) console.error(`  progresso: ${done}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

// Só departamentos com sessão de WhatsApp conectada contam como distribuidor ativo de verdade.
export async function getDepartamentosAtivos() {
  const data = await apiGet('/api/departamento/all');
  const departamentos = data.departamentos || [];
  const statusList = await mapWithConcurrency(departamentos, 10, async (d) => {
    try {
      const info = await apiGet(`/api/whatsapp/${d._id}`);
      return { ...d, isConected: !!info.sessao?.isConected };
    } catch {
      return { ...d, isConected: false };
    }
  });
  const ativos = statusList.filter((d) => d.isConected);
  return new Map(ativos.map((d) => [d._id, d.nome]));
}

// Endpoint interno (não documentado publicamente) que lista leads por ordem de chegada.
export async function getLeadsRecentes(diasJanela, limiteLeads = 30000) {
  const cutoff = new Date(Date.now() - diasJanela * 86400000);
  const leads = [];
  let page = 1;
  const limitPorPagina = 100;
  while (leads.length < limiteLeads) {
    const data = await apiGet(`/leads?page=${page}&limit=${limitPorPagina}&sortField=createdAt&sortDirection=desc`, true);
    if (!data.docs?.length) break;
    for (const lead of data.docs) {
      if (new Date(lead.createdAt) < cutoff) return { leads, atingiuJanela: true };
      leads.push(lead);
      if (leads.length >= limiteLeads) break;
    }
    if (!data.hasNextPage) break;
    page += 1;
  }
  return { leads, atingiuJanela: false };
}

export async function getConversaPorChatId(chatId) {
  try {
    const data = await apiGet(`/api/v2/conversations/chatId/${encodeURIComponent(chatId)}?includeClosed=true`);
    return data.conversation || null;
  } catch {
    return null;
  }
}

export async function getMensagens(conversationId) {
  const todas = [];
  let cursor = null;
  let paginas = 0;
  do {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const data = await apiGet(`/api/v2/conversations/${conversationId}/messages${qs}`);
    todas.push(...(data.messages || []));
    cursor = data.nextCursor || null;
    paginas += 1;
  } while (cursor && paginas < 10);
  return todas;
}

// --- Classificação rápida por palavra-chave (regex) — barata e instantânea, usada pro
// contador ao vivo do dashboard. A classificação profunda por IA (Gemini) fica no projeto
// zap-dashboard-sync, reservada pras análises sob demanda por distribuidor. ---

// Frases abaixo (fora as originais) vieram de candidatos-regex.json — evidências reais
// que a IA usou pra resolver "sem_mencao", confirmadas e promovidas manualmente (ver
// registrarCandidatoRegex em build-data.mjs). Cada uma tinha 3+ ocorrências reais.
const REPROVADO_RE = /\bREPROVAD[OA]S?\b|\bNEGAD[OA]\b/;
const NAO_APROVADO_RE = /N[AÃ]O\s+(FOI\s+)?APROVAD[OA]S?|N[AÃ]O\s+APROVOU|N[AÃ]O\s+FOI\s+LIBERAD[OA]|N[AÃ]O\s+PASSOU|N[AÃ]O\s+ATENDEMOS|N[AÃ]O\s+FOI\s+AUTORIZAD[OA]|POSSUI\s+D[EÉ]BITO/;
const APROVADO_RE = /\bAPROVAD[OA]S?\b|\bAPROVAMOS\b|\bAPROVOU\b|\bLIBERAD[OA]\b|DEU\s+CERTO|BEM-VINDA\s+AO\s+TIME/;

export function classificarMensagem(txtUpper) {
  if (REPROVADO_RE.test(txtUpper) || NAO_APROVADO_RE.test(txtUpper)) return 'reprovado';
  if (APROVADO_RE.test(txtUpper)) return 'aprovado';
  return null;
}

// As únicas 4 frases que de fato acionam o bot automático do Zap Responder
// (texto padrão do botão de anúncio "clique para conversar no WhatsApp").
const FRASES_ANUNCIO = [
  'QUERO SABER MAIS SOBRE O ANUNCIO',
  'OLA! TENHO INTERESSE E QUERIA MAIS INFORMACOES, POR FAVOR.',
  'OLA! QUERIA MAIS INFORMACOES, POR FAVOR.',
  'OLA! POSSO TER MAIS INFORMACOES SOBRE ISSO?',
];

export function normalizar(txt) {
  return txt
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Métrica oficial do funil (ver memória do projeto): só 'clique_anuncio_confirmado' conta
// como lead chegado de tráfego pago. Nunca contar 'outbound_distribuidor_iniciou' como chegada.
export function classificarOrigem(primeiraMensagem) {
  if (!primeiraMensagem) return 'indeterminado';
  if (primeiraMensagem.autor !== 'usuario') return 'outbound_distribuidor_iniciou';
  const texto = normalizar((primeiraMensagem.mensagem?.mensagem || '').toString());
  if (FRASES_ANUNCIO.includes(texto)) return 'clique_anuncio_confirmado';
  return 'indeterminado';
}

// protocolo tem formato YYYYMMDDxxxx — extrai a data sem chamada extra à API.
export function dataDoProtocolo(protocolo) {
  if (!protocolo || protocolo.length < 8) return null;
  const y = protocolo.slice(0, 4);
  const m = protocolo.slice(4, 6);
  const d = protocolo.slice(6, 8);
  return `${y}-${m}-${d}`;
}
