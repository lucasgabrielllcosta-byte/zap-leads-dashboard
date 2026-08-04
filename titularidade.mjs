// Rastreia qual cliente é "dono" de cada departamento ao longo do tempo, porque o
// departamentoId é reaproveitado quando um cliente sai da agência e outro entra depois
// (mesmo WhatsApp/departamento, dono diferente). Sem isso, leads antigos do cliente
// anterior acabam contados/reativados como se fossem do cliente novo.
//
// Convenção já usada na operação: quando um cliente sai, o nome do departamento vira
// "❌<nome antigo>" no Zap Responder. Quando alguém recontrata esse departamento, o nome
// muda de "❌algo" pra um nome novo (sem ❌).
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Resolvido relativo a este arquivo (não ao cwd de quem chama) por padrão, mas pode ser
// sobrescrito por TITULARIDADE_PATH — usado pelo fast-track (novos.yml) pra apontar pra
// um arquivo descartável em /tmp, evitando que duas execuções escrevam no mesmo arquivo
// real ao mesmo tempo (mesmo cuidado já usado com CANDIDATOS_PATH em build-data.mjs).
const PATH = process.env.TITULARIDADE_PATH || join(dirname(fileURLToPath(import.meta.url)), 'titularidade-departamentos.json');

export function carregarTitularidade() {
  if (!existsSync(PATH)) return {};
  return JSON.parse(readFileSync(PATH, 'utf8'));
}

export function salvarTitularidade(titularidade) {
  writeFileSync(PATH, JSON.stringify(titularidade, null, 2));
}

// 'churn' = cliente saiu (nome ganhou o ❌)
// 'reatribuicao' = departamento vago (❌algo) foi passado pra um cliente novo
// 'ambiguo' = mudança de nome que não segue o padrão ❌ — pode ser só correção de nome
//             do mesmo cliente; não mexe na titularidade sozinho, só avisa pra revisão manual.
//
// Não exige que o nome bata exatamente depois de tirar o ❌ — na prática quem marca o
// ❌ às vezes digita errado/abrevia o nome junto (ex: "Danieli pengo" -> "❌Danieli peng").
// O que importa é só o ❌ ter aparecido ou desaparecido.
export function classificarTroca(nomeAnterior, nomeAtual) {
  const eraX = nomeAnterior.trim().startsWith('❌');
  const ehX = nomeAtual.trim().startsWith('❌');
  if (!eraX && ehX) return 'churn';
  if (eraX && !ehX) return 'reatribuicao';
  return 'ambiguo';
}

// Aplica uma lista de trocas detectadas (mesmo formato do historico_trocas_departamento.json)
// na titularidade. Retorna a titularidade atualizada + avisos legíveis pra log.
export function aplicarTrocas(titularidade, trocas) {
  const avisos = [];
  for (const t of trocas) {
    const tipo = classificarTroca(t.nomeAnterior, t.nomeAtual);
    const periodos = titularidade[t.departamentoId] || [];
    if (tipo === 'churn') {
      const atual = periodos[periodos.length - 1];
      if (atual && !atual.fim) atual.fim = t.detectadoEm;
      avisos.push(`Departamento ${t.departamentoId} ("${t.nomeAnterior}") ficou vago — cliente saiu em ${t.detectadoEm}.`);
    } else if (tipo === 'reatribuicao') {
      const atual = periodos[periodos.length - 1];
      if (atual && !atual.fim) atual.fim = t.detectadoEm;
      periodos.push({ cliente: t.nomeAtual.trim(), inicio: t.detectadoEm, fim: null });
      avisos.push(`Departamento ${t.departamentoId} reatribuído: agora é "${t.nomeAtual}" a partir de ${t.detectadoEm}. Leads anteriores a essa data continuam atribuídos ao dono anterior.`);
    } else {
      avisos.push(`Departamento ${t.departamentoId}: mudança de nome "${t.nomeAnterior}" -> "${t.nomeAtual}" não segue o padrão ❌ — titularidade NÃO foi alterada automaticamente. Revise manualmente se for handover de cliente.`);
    }
    titularidade[t.departamentoId] = periodos;
  }
  return { titularidade, avisos };
}

// Nome do dono "correto" de um departamento numa data específica (string YYYY-MM-DD ou
// ISO completo), baseado no histórico de titularidade. null se não achar período (chamador
// deve cair pro nome atual do departamento como fallback, pra departamentos sem troca ainda).
export function titularNaData(titularidade, departamentoId, dataISO) {
  const periodos = titularidade[departamentoId];
  if (!periodos?.length || !dataISO) return null;
  const data = new Date(dataISO);
  for (const p of periodos) {
    const inicio = new Date(p.inicio);
    const fim = p.fim ? new Date(p.fim) : null;
    if (data >= inicio && (!fim || data < fim)) return p.cliente;
  }
  return null;
}

// Início da titularidade ATUAL (período aberto) de um departamento — usado pra cortar
// leads antigos em consultas "últimos N dias" de um distribuidor. null = sem período aberto
// registrado ainda (departamento nunca teve troca detectada) ou está vago no momento.
export function inicioTitularidadeAtual(titularidade, departamentoId) {
  const periodos = titularidade[departamentoId];
  if (!periodos?.length) return null;
  const atual = periodos[periodos.length - 1];
  return atual.fim ? null : atual.inicio;
}
