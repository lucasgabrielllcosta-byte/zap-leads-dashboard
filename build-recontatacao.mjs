// Gera data/recontatacao.json: por distribuidor, quantos leads foram recontatados
// (via o projeto de reativação, pasta irmã zap-reativacao-leads) e quantos aprovaram
// depois disso. Só reabre a conversa de quem já foi recontatado (dezenas, não a conta
// inteira) — rápido, não precisa do rebuild completo de 30 dias.
//
// Uso: node --env-file=.env build-recontatacao.mjs
// (escreve direto em data/recontatacao.json — não precisa mais de "> data/..." no shell)
import { readFileSync, writeFileSync, renameSync } from 'fs';
import { getConversaPorChatId, getMensagens, classificarMensagem, mapWithConcurrency } from './zap-api.mjs';

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

// Concorrência 15 — era sequencial (1 lead por vez, 2 chamadas de API cada), o que pra
// ~6200 leads passou de 1h40 rodando sozinho (descoberto em 2026-08-20, mesmo problema
// já corrigido no verificar-recusas.mjs). mapWithConcurrency já isola erro por item
// (não derruba o lote inteiro se uma chamada falhar).
let processados = 0;
const resultados = await mapWithConcurrency(entradas, 15, async (lead) => {
  const r = await checarLead(lead);
  processados++;
  if (processados % 500 === 0) console.error(`  progresso: ${processados}/${entradas.length}`);
  return r;
});

const porDistribuidorMap = new Map();
for (const r of resultados) {
  // mapWithConcurrency captura erro por item (em vez de derrubar o lote inteiro) e
  // devolve { error } sem o formato esperado — pula em vez de quebrar a agregação.
  if (!r || r.error) { if (r?.error) console.error(`  [aviso] lead pulado por erro: ${r.error}`); continue; }
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

// Escreve num arquivo temporário e só então renomeia por cima do definitivo — nunca
// deixa data/recontatacao.json num estado truncado/incompleto no meio do caminho. Antes
// disso, o script só imprimia no stdout e quem chamava fazia `> data/recontatacao.json`
// (redirecionamento do shell) — se duas execuções (a tarefa de hora em hora e o
// fechamento do turno da tarde) batessem quase ao mesmo tempo, cada uma abria/truncava o
// arquivo por conta própria e podia deixar ele vazio/cortado no meio (bug real,
// descoberto em 2026-08-05: o arquivo ficou com 0 bytes, só não foi publicado porque
// ninguém tinha comitado ainda). writeFileSync + renameSync é atômico no mesmo disco —
// mesmo que duas execuções rodem juntas, cada uma só troca o arquivo por uma versão
// completa de uma vez, nunca por um pedaço.
const saida = JSON.stringify({
  geradoEm: new Date().toISOString(),
  porDistribuidor: [...porDistribuidorMap.values()].sort((a, b) => b.recontatados - a.recontatados),
}, null, 2);
const caminhoFinal = './data/recontatacao.json';
const caminhoTemp = `${caminhoFinal}.tmp-${process.pid}`;
writeFileSync(caminhoTemp, saida);
renameSync(caminhoTemp, caminhoFinal);
console.error(`Escrito em ${caminhoFinal}.`);
