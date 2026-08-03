// Gera data/recontatacao.json: por distribuidor, quantos leads foram recontatados
// (via o projeto de reativação, pasta irmã zap-reativacao-leads) e quantos aprovaram
// depois disso. Só reabre a conversa de quem já foi recontatado (dezenas, não a conta
// inteira) — rápido, não precisa do rebuild completo de 30 dias.
//
// Uso: node --env-file=.env build-recontatacao.mjs > data/recontatacao.json
import { readFileSync } from 'fs';
import { getConversaPorChatId, getMensagens, classificarMensagem } from './zap-api.mjs';

const HISTORICO_PATH = '../zap-reativacao-leads/historico_reativacao.json';

if (!process.env.ZAP_API_TOKEN) {
  console.error('Faltou ZAP_API_TOKEN.');
  process.exit(1);
}

const historico = JSON.parse(readFileSync(HISTORICO_PATH, 'utf8'));
const entradas = Object.entries(historico.leads).map(([telefone, dados]) => ({ telefone, ...dados }));

console.error(`Verificando ${entradas.length} lead(s) recontatado(s)...`);

function textoDaMensagem(msg) {
  return (msg.mensagem?.mensagem || '').toString();
}

async function checarLead(lead) {
  const primeiraTentativa = lead.tentativas[0]?.data;
  const conversa = await getConversaPorChatId(lead.telefone);
  if (!conversa) return { ...lead, resultado: 'conversa_nao_encontrada' };

  const mensagensOrdenadas = (await getMensagens(conversa._id)).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  let status = 'sem_mencao';
  let dataDecisao = null;
  for (const m of mensagensOrdenadas) {
    const c = classificarMensagem(textoDaMensagem(m).toUpperCase());
    if (c) { status = c; dataDecisao = m.createdAt; }
  }

  if (status === 'sem_mencao') return { ...lead, resultado: 'ainda_sem_retorno' };
  const aprovouDepois = dataDecisao && primeiraTentativa && new Date(dataDecisao) > new Date(primeiraTentativa);
  if (status === 'aprovado') return { ...lead, resultado: aprovouDepois ? 'aprovado_apos_reativacao' : 'aprovado_antes_da_reativacao' };
  return { ...lead, resultado: aprovouDepois ? 'reprovado_apos_reativacao' : 'reprovado_antes_da_reativacao' };
}

const resultados = [];
for (const lead of entradas) {
  resultados.push(await checarLead(lead));
}

const porDistribuidorMap = new Map();
for (const r of resultados) {
  const d = porDistribuidorMap.get(r.distribuidor) || {
    distribuidor: r.distribuidor, recontatados: 0, aprovados: 0, reprovados: 0, semRetorno: 0, perdidos: 0, cancelados: 0,
  };
  d.recontatados += 1;
  if (r.resultado === 'aprovado_apos_reativacao') d.aprovados += 1;
  else if (r.resultado.startsWith('reprovado')) d.reprovados += 1;
  else if (r.resultado === 'ainda_sem_retorno') {
    d.semRetorno += 1;
    if (r.status === 'perdido') d.perdidos += 1;
  }
  if (r.status === 'cancelado') d.cancelados += 1;
  porDistribuidorMap.set(r.distribuidor, d);
}

console.log(JSON.stringify({
  geradoEm: new Date().toISOString(),
  porDistribuidor: [...porDistribuidorMap.values()].sort((a, b) => b.recontatados - a.recontatados),
}, null, 2));
