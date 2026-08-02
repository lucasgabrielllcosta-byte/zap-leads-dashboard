// Portão de segurança: roda depois de gerar o dashboard.json novo e antes de publicar.
// Se qualquer checagem falhar, sai com código de erro — o workflow para aí e o site
// continua servindo a última versão publicada (nada quebrado ou duplicado vai pro ar).

import { readFileSync } from 'fs';

const NOVO_PATH = process.argv[2] || 'data/dashboard.json';
const ANTERIOR_PATH = process.argv[3] || null;

// Configuráveis por env var — o novos.json (janela de 1-2 dias) oscila muito mais em
// proporção que o dashboard.json (30 dias), então usa limites mais soltos (ver novos.yml).
const QUEDA_MAX = Number(process.env.VALIDAR_QUEDA_MAX || 0.5); // não aceita cair mais de 50% de uma publicação pra outra
const AUMENTO_MAX = Number(process.env.VALIDAR_AUMENTO_MAX || 3); // nem mais que triplicar — indício de duplicação/erro

const STATUS_VALIDOS = new Set(['aprovado', 'reprovado', 'sem_mencao']);
const ORIGEM_VALIDA = new Set(['clique_anuncio_confirmado', 'outbound_distribuidor_iniciou', 'indeterminado']);

function erro(msg) {
  console.error(`[validação] FALHOU: ${msg}`);
  process.exit(1);
}

function carregar(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined; // marca "existe mas está corrompido", diferente de "não existe"
  }
}

const novo = carregar(NOVO_PATH);
if (novo === null) erro(`não encontrei ${NOVO_PATH}`);
if (novo === undefined) erro(`${NOVO_PATH} não é um JSON válido`);

if (!Array.isArray(novo.registros)) erro('campo "registros" ausente ou não é array');
if (typeof novo.distribuidoresAtivosTotal !== 'number') erro('campo "distribuidoresAtivosTotal" ausente');
if (!novo.geradoEm) erro('campo "geradoEm" ausente');

for (const [i, r] of novo.registros.entries()) {
  if (!r.distribuidor) erro(`registro #${i} sem distribuidor`);
  if (!STATUS_VALIDOS.has(r.status)) erro(`registro #${i} com status inválido: ${r.status}`);
  if (!ORIGEM_VALIDA.has(r.origem)) erro(`registro #${i} com origem inválida: ${r.origem}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.data || '')) erro(`registro #${i} com data inválida: ${r.data}`);
}

if (novo.registros.length === 0) erro('dashboard novo veio com 0 leads — provável falha silenciosa na API');
if (novo.distribuidoresAtivosTotal === 0) erro('dashboard novo veio com 0 distribuidores ativos — provável falha na API do Zap Responder');

const anterior = ANTERIOR_PATH ? carregar(ANTERIOR_PATH) : null;
if (anterior && Array.isArray(anterior.registros) && anterior.registros.length > 0) {
  const totalAntigo = anterior.registros.length;
  const totalNovo = novo.registros.length;
  const variacao = totalNovo / totalAntigo;
  if (variacao < QUEDA_MAX) {
    erro(`total de leads caiu de ${totalAntigo} pra ${totalNovo} (${Math.round((1 - variacao) * 100)}% a menos) — variação suspeita, bloqueando publicação`);
  }
  if (variacao > AUMENTO_MAX) {
    erro(`total de leads subiu de ${totalAntigo} pra ${totalNovo} (${Math.round(variacao * 100)}% do anterior) — variação suspeita, bloqueando publicação`);
  }
}

console.error(`[validação] OK — ${novo.registros.length} leads, ${novo.distribuidoresAtivosTotal} distribuidores ativos.`);
