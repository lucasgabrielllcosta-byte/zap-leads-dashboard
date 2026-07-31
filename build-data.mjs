// Gera data/dashboard.json: lista de registros brutos por lead (sem nome/telefone —
// só distribuidor/status/origem/UF/data), pensado pra rodar em repo público + GitHub
// Pages. Toda a agregação por período (hoje/7/15/30 dias), filtros e regras de negócio
// (ex: "aprovado só conta se veio de anúncio confirmado") ficam no navegador (index.html)
// — assim, mudar uma regra de exibição não exige reprocessar os leads de novo, só editar
// o front e fazer push (rápido). Só a busca de leads novos precisa desse script (lento,
// depende da API do Zap Responder), rodado a cada hora via cron ou manualmente.
//
// Uso: node --env-file=.env build-data.mjs > data/dashboard.json
//
// Variáveis de ambiente:
//   ZAP_API_TOKEN, ZAP_BASE_URL
//   DIAS_JANELA     - default 30 (cobre os recortes hoje/7/15/30 dias calculados no front)
//   LIMITE_LEADS    - teto de leads (default 30000)
//   CONCURRENCY     - chamadas simultâneas na fase de classificação (default 15)
//   GEMINI_API_KEY  - chave dedicada deste projeto p/ origem-ia.mjs (opcional — sem ela,
//                     os leads "indeterminado" só não ganham o dado extra de origem-IA)
//   CONCURRENCY_IA  - concorrência das chamadas Gemini (default 5)

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
import { classificarOrigemIA } from './origem-ia.mjs';

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

function diaISO(dataISOouDate) {
  return new Date(dataISOouDate).toISOString().slice(0, 10);
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
    try {
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
        // campos temporários, só pra origem-indeterminada — removidos antes da saída final
        _telefone: origem === 'indeterminado' ? lead.chatId : undefined,
        _mensagens: origem === 'indeterminado' ? mensagensOrdenadas : undefined,
      };
    } catch (err) {
      console.error(`  aviso: falha ao processar um lead (${err.message}), pulando.`);
      return null;
    }
  });

  // mapWithConcurrency também pode devolver { error } se algo escapar do try acima —
  // nunca deixar um registro sem "data" chegar na saída (já quebrou um build antes).
  const registros = resultados.filter((r) => r && typeof r.data === 'string');
  console.error(`Classificação concluída: ${registros.length} leads vinculados a distribuidor ativo, ${((Date.now() - t0) / 1000).toFixed(1)}s.`);

  const indeterminados = registros.filter((r) => r.origem === 'indeterminado');
  console.error(`Rodando origem-IA em ${indeterminados.length} leads "indeterminado" (concorrência=${process.env.CONCURRENCY_IA || 5})...`);
  const resultadosIA = await classificarOrigemIA(indeterminados.map((r) => ({ telefone: r._telefone, mensagens: r._mensagens })));
  indeterminados.forEach((r, i) => { r.origemIA = resultadosIA[i].origemProvavel; });

  for (const r of registros) {
    delete r._telefone;
    delete r._mensagens;
  }

  const saida = {
    geradoEm: new Date().toISOString(),
    diasJanela: DIAS_JANELA,
    janelaCompleta: atingiuJanela,
    distribuidoresAtivosTotal: departamentosAtivos.size,
    registros,
  };

  console.log(JSON.stringify(saida));
  console.error(`=== data.json gerado em ${((Date.now() - t0) / 1000).toFixed(1)}s ===`);
}

main().catch((err) => {
  console.error('Erro:', err);
  process.exit(1);
});
