// Mapeamento oficial ANATEL de DDD -> UF.
const DDD_PARA_UF = {
  11: 'SP', 12: 'SP', 13: 'SP', 14: 'SP', 15: 'SP', 16: 'SP', 17: 'SP', 18: 'SP', 19: 'SP',
  21: 'RJ', 22: 'RJ', 24: 'RJ',
  27: 'ES', 28: 'ES',
  31: 'MG', 32: 'MG', 33: 'MG', 34: 'MG', 35: 'MG', 37: 'MG', 38: 'MG',
  41: 'PR', 42: 'PR', 43: 'PR', 44: 'PR', 45: 'PR', 46: 'PR',
  47: 'SC', 48: 'SC', 49: 'SC',
  51: 'RS', 53: 'RS', 54: 'RS', 55: 'RS',
  61: 'DF',
  62: 'GO', 64: 'GO',
  63: 'TO',
  65: 'MT', 66: 'MT',
  67: 'MS',
  68: 'AC',
  69: 'RO',
  71: 'BA', 73: 'BA', 74: 'BA', 75: 'BA', 77: 'BA',
  79: 'SE',
  81: 'PE', 87: 'PE',
  82: 'AL',
  83: 'PB',
  84: 'RN',
  85: 'CE', 88: 'CE',
  86: 'PI', 89: 'PI',
  91: 'PA', 93: 'PA', 94: 'PA',
  92: 'AM', 97: 'AM',
  95: 'RR',
  96: 'AP',
  98: 'MA', 99: 'MA',
};

// telefone no formato "55DDNNNNNNNNN" (com DDI 55). Retorna { ddd, uf } ou null se não bater o padrão.
export function extrairDddEUf(telefone) {
  const digitos = (telefone || '').toString().replace(/\D/g, '');
  const semDDI = digitos.startsWith('55') ? digitos.slice(2) : digitos;
  if (semDDI.length < 10) return null;
  const ddd = Number(semDDI.slice(0, 2));
  const uf = DDD_PARA_UF[ddd] || null;
  return { ddd, uf };
}
