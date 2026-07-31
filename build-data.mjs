// Gera data/dashboard.json: métricas agregadas dos últimos N dias (sem nome/telefone
// de lead individual — só números, pensado pra rodar em repo público + GitHub Pages).
// Inclui recortes prontos por período (hoje / 7 dias / 15 dias / 30 dias) pro dashboard
// trocar de visão sem precisar recalcular nada no navegador além de somar dias já agregados.
//
// Uso: node --env-file=.env build-data.mjs > data/dashboard.json
//
// Variáveis de ambiente:
//   ZAP_API_TOKEN, ZAP_BASE_URL
//   DIAS_JANELA   - default 30 (cobre os 4 recortes: hoje, 7 dias, 15 dias, 30 dias)
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
} from './zap-api.mjs';
import { extrairDddEUf } from './ddd-estado.mjs';

const TOKEN = process.env.ZAP_API_TOKEN;
const DIAS_JANELA = Number(process.env.DIAS_JANELA || 30);
const LIMITE_LEADS = Number(process.env.LIMITE_LEADS || 30000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 15);
const PERIODOS = [
  { chave: 'hoje', dias: 1 },
  { chave: '7dias', dias: 7 },
  { chave: '15dias', dias: 15 },
  { chave: '30dias', dias: 30 },
];

if (!TOKEN) {
  console.error('Faltou ZAP_API_TOKEN.');
  process.exit(1);
}

function textoDaMensagem(msg) {
  return (msg.mensagem?.mensagem || '').toString();
}

function diaISO(dataISOouDate) {
  return new Date(dataISOouDate).toISOString().slice(0, 10);
}

function agregar(registros) {
  const statusCount = { aprovado: 0, reprovado: 0, sem_mencao: 0 };
  const origemCount = { clique_anuncio_confirmado: 0, outbound_distribuidor_iniciou: 0, indeterminado: 0 };
  const porUFMap = new Map();
  const porDistribuidorMap = new Map();

  for (const r of registros) {
    statusCount[r.status] = (statusCount[r.status] || 0) + 1;
    origemCount[r.origem] = (origemCount[r.origem] || 0) + 1;
    porUFMap.set(r.uf, (porUFMap.get(r.uf) || 0) + 1);

    const dist = porDistribuidorMap.get(r.distribuidor) || { nome: r.distribuidor, total: 0, aprovados: 0, reprovados: 0 };
    dist.total += 1;
    if (r.status === 'aprovado') dist.aprovados += 1;
    if (r.status === 'reprovado') dist.reprovados += 1;
    porDistribuidorMap.set(r.distribuidor, dist);
  }

  const totalClassificados = statusCount.aprovado + statusCount.reprovado;
  return {
    totalLeads: registros.length,
    distribuidoresAtivos: new Set(registros.map((r) => r.distribuidor)).size,
    status: statusCount,
    taxaAprovacao: totalClassificados > 0 ? statusCount.aprovado / totalClassificados : null,
    origem: origemCount,
    porUF: [...porUFMap.entries()].map(([uf, total]) => ({ uf, total })).sort((a, b) => b.total - a.total),
    porDistribuidor: [...porDistribuidorMap.values()].sort((a, b) => b.total - a.total),
  };
}

async function main() {
  const t0 = Date.now();

  console.error('Buscando departamentos ativos...');
  const departamentosAtivos = await getDepartamentosAtivos();
  console.error(`${departamentosAtivos.size} distribuidores ativos.`);

  console.error(`Buscando leads dos últimos ${DIAS_JANELA} dias (teto: ${LIMITE_LEADS})...`);
  const { leads, atingiuJanela } = await getLeadsRecentes(DIAS_JANELA, LIMITE_LEADS);
  console.error(`${leads.length} leads coletados. Janela completa? ${atingiuJanela}`);

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
    const info = extrairDddEUf(lead.chatId);
    return {
      distribuidor,
      status,
      origem,
      uf: info?.uf || 'desconhecido',
      data: diaISO(lead.createdAt),
    };
  });

  const registros = resultados.filter(Boolean);
  const tempoSegundos = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`Classificação concluída: ${registros.length} leads vinculados a distribuidor ativo, ${tempoSegundos}s.`);

  // Série diária (janela completa) pro gráfico de tendência.
  const porDiaMap = new Map();
  for (const r of registros) {
    const dia = porDiaMap.get(r.data) || { data: r.data, total: 0, aprovados: 0, reprovados: 0 };
    dia.total += 1;
    if (r.status === 'aprovado') dia.aprovados += 1;
    if (r.status === 'reprovado') dia.reprovados += 1;
    porDiaMap.set(r.data, dia);
  }
  const porDia = [...porDiaMap.values()].sort((a, b) => a.data.localeCompare(b.data));

  const hojeISO = diaISO(new Date());
  const periodos = {};
  for (const { chave, dias } of PERIODOS) {
    const filtrados = dias === 1
      ? registros.filter((r) => r.data === hojeISO)
      : registros.filter((r) => r.data >= diaISO(Date.now() - dias * 86400000));
    periodos[chave] = { dias, ...agregar(filtrados) };
  }

  const saida = {
    geradoEm: new Date().toISOString(),
    diasJanela: DIAS_JANELA,
    janelaCompleta: atingiuJanela,
    distribuidoresAtivosTotal: departamentosAtivos.size,
    porDia,
    periodos,
  };

  console.log(JSON.stringify(saida, null, 2));
  console.error(`=== data.json gerado em ${tempoSegundos}s ===`);
}

main().catch((err) => {
  console.error('Erro:', err);
  process.exit(1);
});
