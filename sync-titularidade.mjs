// Detecta troca de titular de departamento (cliente saiu / outro assumiu o mesmo
// número) SEM Gemini — só compara a lista de departamentos atual com o snapshot
// salvo da última execução. Extraído de build-data.mjs pra poder rodar sozinho,
// 2x/dia (manhã e fim do dia), sem disparar o pipeline caro de classificação por IA.
//
// Uso: node --env-file=.env sync-titularidade.mjs
import { getDepartamentosAtivos } from './zap-api.mjs';
import { carregarTitularidade, salvarTitularidade } from './titularidade.mjs';
import { sincronizarTitularidade } from './titularidade-sync.mjs';

const TOKEN = process.env.ZAP_API_TOKEN;
if (!TOKEN) {
  console.error('Faltou ZAP_API_TOKEN.');
  process.exit(1);
}

console.error('Buscando departamentos ativos...');
const { todos: todosDepartamentos } = await getDepartamentosAtivos();

let titularidade = carregarTitularidade();
const { titularidade: titularidadeAtualizada, avisos } = sincronizarTitularidade(titularidade, todosDepartamentos);

if (avisos.length) {
  for (const aviso of avisos) console.error(`  [titularidade] ${aviso}`);
  salvarTitularidade(titularidadeAtualizada);
  console.error(`${avisos.length} troca(s) de titular detectada(s) e salva(s).`);
} else {
  console.error('Nenhuma troca de titular detectada.');
}
