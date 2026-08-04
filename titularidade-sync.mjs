// Detecta troca de titular de departamento sozinho, comparando o snapshot de nomes desta
// execução com o da execução anterior — mesma lógica do rotina-diaria.mjs do
// zap-dashboard-sync, só que rodando aqui (nuvem, hora em hora), então nunca fica
// desatualizado e não depende de copiar arquivo manualmente entre os dois projetos.
//
// Convenção já usada na operação (ver titularidade.mjs): quando um cliente sai, o nome do
// departamento vira "❌<nome antigo>"; quando alguém recontrata, o "❌" some.

import { readFileSync, writeFileSync } from 'fs';
import { aplicarTrocas } from './titularidade.mjs';

const SNAPSHOT_PATH = process.env.SNAPSHOT_PATH || './departamentos-snapshot.json';

function carregarSnapshotAnterior() {
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'))));
  } catch {
    return null; // primeira execução — sem base de comparação ainda, não é erro
  }
}

function salvarSnapshot(todos) {
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(Object.fromEntries(todos), null, 2));
}

// todosAtuais: Map(departamentoId -> nome), de getDepartamentosAtivos().todos
// titularidade: objeto carregado de carregarTitularidade() (ver titularidade.mjs)
// Retorna a titularidade atualizada (mesma referência, mutada) + avisos legíveis pra log.
export function sincronizarTitularidade(titularidade, todosAtuais) {
  const anterior = carregarSnapshotAnterior();
  salvarSnapshot(todosAtuais); // sempre grava o snapshot novo, mesmo sem anterior pra comparar

  if (!anterior) {
    return { titularidade, avisos: ['Sem snapshot anterior — primeira execução, nada pra comparar ainda.'] };
  }

  const trocas = [];
  const agora = new Date().toISOString();
  for (const [id, nomeAtual] of todosAtuais) {
    const nomeAnterior = anterior.get(id);
    if (nomeAnterior && nomeAnterior.trim() !== nomeAtual.trim()) {
      trocas.push({ departamentoId: id, nomeAnterior, nomeAtual, detectadoEm: agora });
    }
  }

  if (!trocas.length) return { titularidade, avisos: [] };
  return aplicarTrocas(titularidade, trocas);
}
