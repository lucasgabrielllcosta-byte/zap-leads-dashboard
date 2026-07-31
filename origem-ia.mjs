// Classifica, via Gemini, a origem provável dos leads cuja origem não deu pra confirmar
// pela regra técnica (regex na 1ª mensagem) — sem inventar, só com base em menções
// explícitas na própria conversa. Métrica secundária, nunca substitui a "confirmada".
//
// Cache persistente por hash(telefone + transcrição): se a conversa não mudou desde a
// última rodada, reaproveita o resultado sem gastar Gemini de novo. O cache guarda só
// hash + resultado — nunca telefone nem transcrição em texto puro.
//
// Variáveis de ambiente:
//   GEMINI_API_KEY (se ausente, todos os itens voltam como "nao_da_pra_saber")
//   GEMINI_MODEL (default: gemini-flash-lite-latest)
//   CONCURRENCY_IA (default 5 — nível gratuito do Gemini tem limite de requisições/min)
//   ORIGEM_IA_CACHE_PATH (default ./cache/origem-ia.json)

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createHash } from 'crypto';
import { GoogleGenAI } from '@google/genai';
import { mapWithConcurrency } from './zap-api.mjs';

const CACHE_PATH = process.env.ORIGEM_IA_CACHE_PATH || './cache/origem-ia.json';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
const CONCURRENCY_IA = Number(process.env.CONCURRENCY_IA || 5);
const VALORES_VALIDOS = new Set(['anuncio', 'organico_outro', 'nao_da_pra_saber']);

// Textos de mídia/introdução que se repetem em toda conversa — cortar pra economizar tokens.
const LINHA_MIDIA_RE = /^https:\/\/s3\.zapresponder\.com\.br\/|^uploads\/smartphone\.png$/;

const PROMPT_SISTEMA = `Você está analisando uma conversa de WhatsApp entre um lead em potencial (LEAD) e o atendimento de um distribuidor de semijoias (ATENDENTE/bot). Esse lead NÃO clicou no botão automático de anúncio — não temos confirmação técnica de que veio de tráfego pago.

Sua tarefa: ler a conversa e dizer se há algum indício EXPLÍCITO de que essa pessoa chegou através de um anúncio pago (tráfego pago, Instagram/Facebook Ads, "vi o anúncio de vocês", etc.) versus outra origem (indicação de alguém, já conhecia a marca, contato anterior, distribuidor que puxou assunto).

Responda só com base em algo dito EXPLICITAMENTE na conversa — nunca invente ou assuma pelo tom da conversa. Se não há nenhuma pista clara, responda "nao_da_pra_saber".

Responda em JSON, só isso, sem markdown, no formato:
{"origemProvavel": "anuncio" | "organico_outro" | "nao_da_pra_saber", "evidencia": "trecho curto da conversa que embasa a resposta, ou null"}`;

function montarTranscricao(mensagens) {
  return mensagens
    .map((m) => {
      const txt = (m.mensagem?.mensagem || '').toString().trim();
      if (!txt || LINHA_MIDIA_RE.test(txt)) return null;
      const papel = m.autor === 'usuario' ? 'LEAD' : 'ATENDENTE';
      return `${papel}: ${txt}`;
    })
    .filter(Boolean)
    .join('\n');
}

function carregarCache() {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function salvarCache(cache) {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache));
}

function chaveCache(telefone, transcricao) {
  return createHash('sha1').update(`${telefone}|${transcricao}`).digest('hex');
}

function limparResultado(parsed) {
  return {
    origemProvavel: VALORES_VALIDOS.has(parsed?.origemProvavel) ? parsed.origemProvavel : 'nao_da_pra_saber',
    evidencia: parsed?.evidencia ? String(parsed.evidencia).slice(0, 200) : null,
  };
}

// itens: [{ telefone, mensagens }] — retorna array paralelo de { origemProvavel, evidencia }
export async function classificarOrigemIA(itens) {
  if (!itens.length) return [];

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY ausente — origem-IA pulada, itens ficam como "nao_da_pra_saber".');
    return itens.map(() => ({ origemProvavel: 'nao_da_pra_saber', evidencia: null }));
  }

  const ai = new GoogleGenAI({ apiKey });
  const cache = carregarCache();
  let novasChamadas = 0;
  let reaproveitados = 0;
  let erros = 0;

  const resultados = await mapWithConcurrency(itens, CONCURRENCY_IA, async (item) => {
    const transcricao = montarTranscricao(item.mensagens);
    if (!transcricao) return { origemProvavel: 'nao_da_pra_saber', evidencia: null };

    const chave = chaveCache(item.telefone, transcricao);
    if (cache[chave]) {
      reaproveitados += 1;
      return cache[chave];
    }

    try {
      const resp = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: 'user', parts: [{ text: `${PROMPT_SISTEMA}\n\n--- CONVERSA ---\n${transcricao}\n--- FIM DA CONVERSA ---` }] }],
        config: { responseMimeType: 'application/json', temperature: 0 },
      });
      const limpo = limparResultado(JSON.parse(resp.text));
      cache[chave] = limpo;
      novasChamadas += 1;
      return limpo;
    } catch {
      erros += 1;
      return { origemProvavel: 'nao_da_pra_saber', evidencia: null };
    }
  });

  salvarCache(cache);
  console.error(`Origem-IA: ${novasChamadas} chamadas novas, ${reaproveitados} do cache, ${erros} erros.`);
  return resultados;
}
