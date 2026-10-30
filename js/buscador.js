// El buscador de Mentor. Busca sin tildes ni mayúsculas, por palabras completas o por su
// comienzo, en lo que la página le pase: historias (del índice datos/v2/buscar.json, que
// escribe scripts/organizar.py cada noche), nombres, secciones, lecturas, fuentes y el
// Cuaderno. Aquí no hay nada de la página: solo cómo se compara y se ordena.

// Palabras que no ayudan a encontrar nada.
const VACIAS = new Set("a al con de del el en es la las lo los o para por que se su sus un una y and of the".split(" "));

export const normalizar = (texto) => (texto || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export const esLetra = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

export function palabrasDe(consulta) {
  return normalizar(consulta).split(/[^\p{L}\p{N}]+/u).filter((p) => p && !VACIAS.has(p));
}

// Qué tan bien aparece una palabra en un texto ya normalizado: 4 si está completa, 2 si es el
// comienzo de una palabra (mientras se escribe) y 1 si va dentro de otra (solo con cuatro
// letras o más). La completa vale el doble para que "petro" no traiga primero "petróleo".
export function coincidencia(texto, palabra) {
  let mejor = 0;
  for (let i = texto.indexOf(palabra); i >= 0; i = texto.indexOf(palabra, i + 1)) {
    if (esLetra(texto[i - 1])) {
      if (palabra.length >= 4) mejor = Math.max(mejor, 1);
    } else if (!esLetra(texto[i + palabra.length])) {
      return 4;
    } else {
      mejor = 2;
    }
  }
  return mejor;
}

// El puntaje de una cosa por sus campos ([texto normalizado, peso]). Todas las palabras de la
// búsqueda tienen que aparecer en alguno; cada una suma lo que vale en su mejor campo.
export function puntaje(campos, palabras) {
  let total = 0;
  for (const palabra of palabras) {
    let mejor = 0;
    for (const [texto, peso] of campos) mejor = Math.max(mejor, coincidencia(texto, palabra) * peso);
    if (!mejor) return 0;
    total += mejor;
  }
  return total;
}

// Lo que coincide con la búsqueda, de mayor a menor puntaje. Cada candidato trae sus campos y
// un impulso (lo reciente o lo que cuentan muchas fuentes pesa más).
export function buscar(candidatos, consulta, maximo = 8) {
  const palabras = palabrasDe(consulta);
  if (!palabras.length) return [];
  const halladas = [];
  for (const c of candidatos) {
    const p = puntaje(c.campos, palabras);
    if (p) halladas.push({ ...c, puntaje: p * (c.impulso || 1) });
  }
  return halladas.sort((a, b) => b.puntaje - a.puntaje).slice(0, maximo);
}

// Lo que impulsa una historia: que sea de hoy o de ayer, que la cuenten varias fuentes y que
// siga abierta. Pesa menos que dónde aparece lo buscado.
export function impulsoDeHistoria(h, dia) {
  const dias = dia && h.a ? Math.round((Date.parse(dia) - Date.parse(h.a)) / 864e5) : 7;
  const reciente = dias <= 0 ? 1.3 : dias === 1 ? 1.2 : dias <= 3 ? 1.1 : 1;
  return reciente * (1 + 0.1 * Math.log2(h.f || 1)) * (h.c ? 0.85 : 1);
}
