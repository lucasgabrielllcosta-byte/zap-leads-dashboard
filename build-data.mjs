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
//   GEMINI_API_KEY  - chave dedicada deste projeto p/ origem-ia.mjs e audio-transcricao.mjs
//                     (opcional — sem ela, esses dois enriquecimentos só ficam pulados)
//   CONCURRENCY_IA  - concorrência das chamadas Gemini de origem (default 5)
//   CONCURRENCY_ENTENDIMENTO - concorrência da resolução de status por entendimento (default 8)
//   CONCURRENCY_AUDIO - concorrência das transcrições de áudio, mais pesada (default 3)

import { readFileSync, writeFileSync } from 'fs';
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
import { resolverStatusPorEntendimento } from './audio-transcricao.mjs';

const TOKEN = process.env.ZAP_API_TOKEN;
const DIAS_JANELA = Number(process.env.DIAS_JANELA || 30);
const LIMITE_LEADS = Number(process.env.LIMITE_LEADS || 30000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 15);
const CANDIDATOS_PATH = process.env.CANDIDATOS_PATH || './candidatos-regex.json';

if (!TOKEN) {
  console.error('Faltou ZAP_API_TOKEN.');
  process.exit(1);
}

function textoDaMensagem(msg) {
  return (msg.mensagem?.mensagem || '').toString();
}

// Só vale gastar IA numa conversa "sem_mencao" se ela parece ENCERRADA — senão a gente
// pergunta pra IA toda hora e ela responde "indefinido" de novo e de novo até a conversa
// realmente terminar (desperdício, já que o resultado muda a cada mensagem nova mesmo).
// Última mensagem do atendente sem resposta há mais de 24h = provável mensagem final que
// o regex não pegou. Última mensagem do lead (esperando resposta) sem retorno do
// atendente há mais de 72h = provável abandono, vale registrar como indefinido e parar de
// reprocessar. Assim que uma nova mensagem chegar, o hash da conversa muda e ela volta a
// ser reavaliada do zero (ver cache em resolverStatusPorEntendimento) — nada fica perdido,
// só atrasado até a conversa esfriar de novo.
const HORAS_ATENDENTE_MS = 24 * 60 * 60 * 1000;
const HORAS_LEAD_MS = 72 * 60 * 60 * 1000;
function conversaPareceConcluida(mensagensOrdenadas) {
  if (!mensagensOrdenadas.length) return false;
  const ultima = mensagensOrdenadas[mensagensOrdenadas.length - 1];
  const decorrido = Date.now() - new Date(ultima.createdAt).getTime();
  const limite = ultima.autor === 'usuario' ? HORAS_LEAD_MS : HORAS_ATENDENTE_MS;
  return decorrido > limite;
}

// Frases que a IA usou como evidência pra resolver status "sem_mencao" (ver
// resolverStatusPorEntendimento), acumuladas entre execuções — pra eventualmente promover
// alguma pra regex de verdade (classificarMensagem em zap-api.mjs) e a IA parar de ser
// chamada pra ela. Nunca promove sozinho: só acumula, revisão e promoção são manuais.
function carregarCandidatosRegex() {
  try {
    return JSON.parse(readFileSync(CANDIDATOS_PATH, 'utf8'));
  } catch {
    return { atualizadoEm: null, candidatos: [] };
  }
}

function normalizarFrase(frase) {
  return frase.toString().trim().toLowerCase().replace(/\s+/g, ' ');
}

function registrarCandidatoRegex(arquivo, { distribuidor, status, frase, data }) {
  // se o regex atual já reconheceria essa frase sozinha, não é candidato — já está coberto.
  if (classificarMensagem(frase.toUpperCase()) === status) return;

  const chave = `${status}::${normalizarFrase(frase)}`;
  const existente = arquivo.candidatos.find((c) => `${c.status}::${normalizarFrase(c.frase)}` === chave);
  if (existente) {
    existente.ocorrencias += 1;
    existente.ultimaData = data;
    if (!existente.distribuidores.includes(distribuidor)) existente.distribuidores.push(distribuidor);
  } else {
    arquivo.candidatos.push({ frase: frase.trim(), status, ocorrencias: 1, ultimaData: data, distribuidores: [distribuidor] });
  }
}

// Brasil não tem horário de verão desde 2019, então UTC-3 é fixo o ano todo — dá pra
// só subtrair 3h antes de extrair a data em vez de depender de timezone database.
const BRASILIA_OFFSET_MS = 3 * 60 * 60 * 1000;
function diaISO(dataISOouDate) {
  return new Date(new Date(dataISOouDate).getTime() - BRASILIA_OFFSET_MS).toISOString().slice(0, 10);
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

      // Todo lead "sem_mencao" é candidato à IA — não dá pra saber de antemão quais
      // distribuidores usam linguagem informal ou áudio (ver resolverStatusPorEntendimento)
      // — mas só vale gastar a chamada se a conversa já parece encerrada (ver
      // conversaPareceConcluida), senão fica pedindo pra IA toda hora à toa.
      const precisaEntendimentoIA = status === 'sem_mencao' && conversaPareceConcluida(mensagensOrdenadas);
      const precisaMensagens = origem === 'indeterminado' || precisaEntendimentoIA;

      return {
        distribuidor,
        status,
        origem,
        uf: info?.uf || 'desconhecido',
        data: diaISO(lead.createdAt),
        // campos temporários — removidos antes da saída final
        _telefone: origem === 'indeterminado' ? lead.chatId : undefined,
        _mensagens: precisaMensagens ? mensagensOrdenadas : undefined,
        _precisaEntendimentoIA: precisaEntendimentoIA || undefined,
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

  // Resolução por entendimento de IA: todo lead que ficou "sem_mencao" no texto — a IA lê
  // a conversa inteira (texto + áudio transcrito, se tiver) e entende o status pelo sentido,
  // em vez de procurar só "aprovado"/"reprovado" literal (perde "deu certo", "aprovou",
  // áudio, etc.). Cada frase usada como evidência vira candidato de regex (ver
  // registrarCandidatoRegex) — é assim que fica "salvo" quais distribuidores usam
  // comunicação informal, sem precisar manter uma lista manual.
  const precisamEntendimento = registros.filter((r) => r._precisaEntendimentoIA);
  console.error(`Resolvendo status por entendimento de IA em ${precisamEntendimento.length} leads (concorrência=${process.env.CONCURRENCY_ENTENDIMENTO || 8})...`);
  const statusResolvidos = await resolverStatusPorEntendimento(precisamEntendimento.map((r) => ({ mensagens: r._mensagens })));
  const candidatosRegex = carregarCandidatosRegex();
  precisamEntendimento.forEach((r, i) => {
    const { status, frase } = statusResolvidos[i];
    if (status === 'indefinido') return;
    r.status = status;
    if (frase) registrarCandidatoRegex(candidatosRegex, { distribuidor: r.distribuidor, status, frase, data: r.data });
  });
  candidatosRegex.atualizadoEm = new Date().toISOString();
  writeFileSync(CANDIDATOS_PATH, JSON.stringify(candidatosRegex, null, 2));

  for (const r of registros) {
    delete r._telefone;
    delete r._mensagens;
    delete r._precisaEntendimentoIA;
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
