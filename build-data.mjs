// Gera data/dashboard.json: métricas agregadas dos últimos N dias (sem nome/telefone
// de lead individual — só números, pensado pra rodar em repo público + GitHub Pages).
//
// Uso: node --env-file=.env build-data.mjs > data/dashboard.json
//
// Variáveis de ambiente:
//   ZAP_API_TOKEN, ZAP_BASE_URL
//   DIAS_JANELA   - default 30
//   LIMITE_LEADS  - teto de leads (default 30000)
//   CONCURRENCY   - chamadas simultâneas na fase de classificação (default 15)

import {
  getDepartamentosAtivos,
  getLeadsRecentes,
  getConversaPorChatId,
  getMensagens,
  mapWithConcurrency,
  classificarMensagem,
  classificarOrigem,
  dataDoProtocolo,
} from './zap-api.mjs';
import { extrairDddEUf } from './ddd-estado.mjs';

const TOKEN = process.env.ZAP_API_TOKEN;
const DIAS_JANELA = Number(process.env.DIAS_JANELA || 30);
const LIMITE_LEADS = Number(process.env.LIMITE_LEADS || 30000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 15);

if (!TOKEN) {
  console.error('Faltou ZAP_API_TOKEN.');
  process.exit(1);
}

function textoDaMensagem(msg) {
  return (msg.mensagem?.mensagem || '').toString();
}

async function main() {
  const t0 = Date.now();

  console.error('Buscando departamentos ativos...');
  const departamentosAtivos = await getDepartamentosAtivos();
  console.error(`${departamentosAtivos.size} distribuidores ativos.`);

  console.error(`Buscando leads dos últimos ${DIAS_JANELA} dias (teto: ${LIMITE_LEADS})...`);
  const { leads, atingiuJanela } = await getLeadsRecentes(DIAS_JANELA, LIMITE_LEADS);
  console.error(`${leads.length} leads coletados. Janela completa? ${atingiuJanela}`);

  // Breakdown por UF direto da lista de leads (rápido, sem chamada extra).
  const porUFMap = new Map();
  for (const lead of leads) {
    const info = extrairDddEUf(lead.chatId);
    const uf = info?.uf || 'desconhecido';
    porUFMap.set(uf, (porUFMap.get(uf) || 0) + 1);
  }

  console.error(`Classificando conversas (concorrência=${CONCURRENCY})...`);
  const resultados = await mapWithConcurrency(leads, CONCURRENCY, async (lead) => {
    const conversa = await getConversaPorChatId(lead.chatId);
    if (!conversa) return null;
    const depId = conversa.departamento_responsavel_atendimento;
    const distribuidor = departamentosAtivos.get(depId) || null;
    if (!distribuidor) return null;

    const mensagensOrdenadas = (await getMensagens(conversa._id)).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    let status = 'sem_mencao';
    for (const m of mensagensOrdenadas) {
      const c = classificarMensagem(textoDaMensagem(m).toUpperCase());
      if (c) status = c;
    }
    const origem = classificarOrigem(mensagensOrdenadas[0]);
    return {
      distribuidor,
      status,
      origem,
      data: dataDoProtocolo(conversa.protocolo),
    };
  });

  const cache = resultados.filter(Boolean);
  const tempoSegundos = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`Classificação concluída: ${cache.length} leads vinculados a distribuidor ativo, ${tempoSegundos}s.`);

  const statusCount = { aprovado: 0, reprovado: 0, sem_mencao: 0 };
  const origemCount = { clique_anuncio_confirmado: 0, outbound_distribuidor_iniciou: 0, indeterminado: 0 };
  const porDiaMap = new Map();
  const porDistribuidorMap = new Map();

  for (const item of cache) {
    statusCount[item.status] = (statusCount[item.status] || 0) + 1;
    origemCount[item.origem] = (origemCount[item.origem] || 0) + 1;

    if (item.data) {
      const dia = porDiaMap.get(item.data) || { data: item.data, total: 0, aprovados: 0, reprovados: 0 };
      dia.total += 1;
      if (item.status === 'aprovado') dia.aprovados += 1;
      if (item.status === 'reprovado') dia.reprovados += 1;
      porDiaMap.set(item.data, dia);
    }

    const dist = porDistribuidorMap.get(item.distribuidor) || { nome: item.distribuidor, total: 0, aprovados: 0, reprovados: 0 };
    dist.total += 1;
    if (item.status === 'aprovado') dist.aprovados += 1;
    if (item.status === 'reprovado') dist.reprovados += 1;
    porDistribuidorMap.set(item.distribuidor, dist);
  }

  const porDia = [...porDiaMap.values()].sort((a, b) => a.data.localeCompare(b.data));
  const porDistribuidor = [...porDistribuidorMap.values()].sort((a, b) => b.total - a.total);
  const porUF = [...porUFMap.entries()]
    .map(([uf, total]) => ({ uf, total }))
    .sort((a, b) => b.total - a.total);

  const totalClassificados = statusCount.aprovado + statusCount.reprovado;
  const taxaAprovacao = totalClassificados > 0 ? statusCount.aprovado / totalClassificados : null;

  const saida = {
    geradoEm: new Date().toISOString(),
    diasJanela: DIAS_JANELA,
    janelaCompleta: atingiuJanela,
    distribuidoresAtivos: departamentosAtivos.size,
    totalLeads: leads.length,
    totalLeadsVinculados: cache.length,
    status: statusCount,
    taxaAprovacao,
    origem: origemCount,
    porDia,
    porUF,
    porDistribuidor,
  };

  console.log(JSON.stringify(saida, null, 2));
  console.error(`=== data.json gerado em ${tempoSegundos}s ===`);
}

main().catch((err) => {
  console.error('Erro:', err);
  process.exit(1);
});
