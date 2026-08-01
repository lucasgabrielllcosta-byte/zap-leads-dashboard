// Resolve o status (aprovado/reprovado/indefinido) de conversas que ficaram "sem_mencao"
// no regex, pra distribuidores confirmados com linguagem que o regex não pega — seja
// porque respondem por áudio (transcrito aqui) ou porque usam frases informais em texto
// ("deu certo", "ele reprovou aqui", "a mesa de crédito aprovou") em vez de "aprovado"/
// "reprovado" literal. Manda a CONVERSA INTEIRA (texto + áudio transcrito, quando tiver)
// pra IA entender o sentido, em vez de bater só na palavra exata.
//
// Dois caches persistentes e independentes:
//  - transcrição de áudio, por hash da URL (a URL não muda, nunca precisa retranscrever)
//  - decisão de status, por hash da conversa montada (texto+transcrições) — muda se a
//    conversa mudar (nova mensagem), senão reaproveita.
//
// Variáveis de ambiente:
//   GEMINI_API_KEY (se ausente, pula tudo — leads ficam "sem_mencao" como antes)
//   GEMINI_MODEL (default: gemini-flash-lite-latest)
//   CONCURRENCY_AUDIO (default 3 — áudio é mais pesado que texto por chamada)
//   AUDIO_CACHE_PATH (default ./cache/audio-transcricao.json)
//   STATUS_AUDIO_CACHE_PATH (default ./cache/status-audio.json)

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createHash } from 'crypto';
import { GoogleGenAI } from '@google/genai';
import { mapWithConcurrency } from './zap-api.mjs';

const CACHE_PATH = process.env.AUDIO_CACHE_PATH || './cache/audio-transcricao.json';
const STATUS_CACHE_PATH = process.env.STATUS_AUDIO_CACHE_PATH || './cache/status-audio.json';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
const CONCURRENCY_AUDIO = Number(process.env.CONCURRENCY_AUDIO || 3);
const VALORES_STATUS = new Set(['aprovado', 'reprovado', 'indefinido']);

const AUDIO_RE = /\.(ogg|mp3|m4a|wav|opus)(\?|$)/i;
const MIME_POR_EXT = { ogg: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mp3', m4a: 'audio/mp4', wav: 'audio/wav' };
const LINHA_MIDIA_RE = /^https:\/\/s3\.zapresponder\.com\.br\/.*\.(jpe?g|png|gif)(\?|$)/i;

const PROMPT_STATUS = `Você está analisando uma conversa de WhatsApp entre uma revendedora em potencial (LEAD) e o atendimento de um distribuidor de semijoias/produtos (ATENDENTE). Parte da conversa foi transcrita de áudio (marcado como [transcrição de áudio]) — pode ter pequenos erros de transcrição, use o contexto pra entender mesmo assim.

Sua tarefa: ler a conversa inteira e dizer qual é o status FINAL do cadastro dessa lead como revendedora, considerando a mensagem mais recente e relevante sobre o resultado (se ela tentou de novo depois de uma reprovação e foi aprovada depois, o status final é aprovado).

Entenda o SENTIDO da conversa, não procure só por uma palavra exata — "aprovou", "foi aprovado", "liberou", "deu certo" (aprovado), "reprovou", "não vai dar", "não deu certo" (reprovado) etc. todos contam, dependendo do contexto.

Responda em JSON, só isso, sem markdown, no formato:
{"status": "aprovado" | "reprovado" | "indefinido"}

Use "indefinido" se a conversa não chegou a uma decisão clara (ainda em andamento, sem resposta final, ou não é sobre esse cadastro).`;

export function ehAudio(texto) {
  return AUDIO_RE.test((texto || '').toString().trim());
}

function ehImagem(texto) {
  return LINHA_MIDIA_RE.test((texto || '').toString().trim());
}

function mimeTypeDoUrl(url) {
  const ext = url.split('.').pop().split('?')[0].toLowerCase();
  return MIME_POR_EXT[ext] || 'audio/ogg';
}

function carregarCache(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function salvarCache(path, cache) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cache));
}

function chaveCache(texto) {
  return createHash('sha1').update(texto).digest('hex');
}

function comTimeout(promise, ms, rotulo) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout (${rotulo})`)), ms)),
  ]);
}

// urls: string[] — retorna array paralelo de string (transcrição, ou '' se falhou/pulou)
export async function transcreverAudios(urls) {
  if (!urls.length) return [];

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY ausente — transcrição de áudio pulada.');
    return urls.map(() => '');
  }

  const ai = new GoogleGenAI({ apiKey });
  const cache = carregarCache(CACHE_PATH);
  let novasChamadas = 0;
  let reaproveitados = 0;
  let erros = 0;

  const resultados = await mapWithConcurrency(urls, CONCURRENCY_AUDIO, async (url) => {
    const chave = chaveCache(url);
    if (cache[chave] != null) {
      reaproveitados += 1;
      return cache[chave];
    }
    try {
      const resp = await comTimeout(fetch(url, { signal: AbortSignal.timeout(20000) }), 25000, 'download');
      if (!resp.ok) throw new Error(`download falhou: HTTP ${resp.status}`);
      const buffer = Buffer.from(await resp.arrayBuffer());
      if (buffer.length > 15 * 1024 * 1024) throw new Error('áudio grande demais, pulando');

      const result = await comTimeout(ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{
          role: 'user',
          parts: [
            { text: 'Transcreva esse áudio em português (Brasil). Responda só com a transcrição, sem comentário nenhum. Se não conseguir entender nada, responda com uma string vazia.' },
            { inlineData: { mimeType: mimeTypeDoUrl(url), data: buffer.toString('base64') } },
          ],
        }],
      }), 45000, 'gemini');
      const texto = (result.text || '').trim();
      cache[chave] = texto;
      novasChamadas += 1;
      return texto;
    } catch (err) {
      erros += 1;
      console.error(`  aviso: falha ao transcrever áudio (${err.message}).`);
      return '';
    }
  });

  salvarCache(CACHE_PATH, cache);
  console.error(`Transcrição de áudio: ${novasChamadas} chamadas novas, ${reaproveitados} do cache, ${erros} erros.`);
  return resultados;
}

function montarTranscricao(mensagens, transcricoesPorUrl) {
  return mensagens
    .map((m) => {
      const txt = (m.mensagem?.mensagem || '').toString().trim();
      if (!txt || ehImagem(txt)) return null;
      const papel = m.autor === 'usuario' ? 'LEAD' : 'ATENDENTE';
      if (ehAudio(txt)) {
        const transcricao = transcricoesPorUrl.get(txt);
        if (!transcricao) return null; // falhou ou vazio, não polui o contexto
        return `${papel} [transcrição de áudio]: ${transcricao}`;
      }
      return `${papel}: ${txt}`;
    })
    .filter(Boolean)
    .join('\n');
}

// leads: [{ mensagens }] (mesmo shape que vem de getMensagens, já ordenadas) — leads de
// distribuidores confirmados que o regex marcou como "sem_mencao". Retorna array paralelo
// de 'aprovado' | 'reprovado' | 'indefinido'.
export async function resolverStatusPorEntendimento(leads) {
  if (!leads.length) return [];

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY ausente — resolução de status por áudio pulada.');
    return leads.map(() => 'indefinido');
  }

  // 1) transcreve todo áudio (de qualquer autor, pro contexto ficar completo) de uma vez,
  // reaproveitando o cache de transcrição por URL.
  const todasUrlsAudio = [...new Set(
    leads.flatMap((l) => l.mensagens
      .map((m) => (m.mensagem?.mensagem || '').toString().trim())
      .filter(ehAudio))
  )];
  const transcricoes = await transcreverAudios(todasUrlsAudio);
  const transcricoesPorUrl = new Map(todasUrlsAudio.map((url, i) => [url, transcricoes[i]]));

  // 2) monta a conversa completa de cada lead e pergunta o status pra IA, com cache
  // próprio por hash da conversa montada.
  const ai = new GoogleGenAI({ apiKey });
  const cache = carregarCache(STATUS_CACHE_PATH);
  let novasChamadas = 0;
  let reaproveitados = 0;
  let erros = 0;

  const resultados = await mapWithConcurrency(leads, CONCURRENCY_AUDIO, async (lead) => {
    const transcricaoCompleta = montarTranscricao(lead.mensagens, transcricoesPorUrl);
    if (!transcricaoCompleta) return 'indefinido';

    const chave = chaveCache(transcricaoCompleta);
    if (cache[chave]) {
      reaproveitados += 1;
      return cache[chave];
    }
    try {
      const result = await comTimeout(ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: 'user', parts: [{ text: `${PROMPT_STATUS}\n\n--- CONVERSA ---\n${transcricaoCompleta}\n--- FIM DA CONVERSA ---` }] }],
        config: { responseMimeType: 'application/json', temperature: 0 },
      }), 30000, 'gemini-status');
      const parsed = JSON.parse(result.text);
      const status = VALORES_STATUS.has(parsed?.status) ? parsed.status : 'indefinido';
      cache[chave] = status;
      novasChamadas += 1;
      return status;
    } catch (err) {
      erros += 1;
      console.error(`  aviso: falha ao resolver status por áudio (${err.message}).`);
      return 'indefinido';
    }
  });

  salvarCache(STATUS_CACHE_PATH, cache);
  console.error(`Status por áudio: ${novasChamadas} chamadas novas, ${reaproveitados} do cache, ${erros} erros.`);
  return resultados;
}
