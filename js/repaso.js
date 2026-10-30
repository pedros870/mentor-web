// El repaso: preguntas sobre lo que Pedro leyó y su vocabulario, con repeticiones espaciadas.
// Recordar con esfuerzo es lo que fija lo leído. Todo sale de lo que ya está guardado (el
// índice del buscador, sus marcas y el Cuaderno), sin Claude.

import { esLetra, normalizar } from "./buscador.js";

export const DIAS_DE_HISTORIAS = 7; // se pregunta por lo que abrió en la última semana
const ESPERA_TRAS_FALLAR = 864e5; // lo que falló vuelve al día siguiente
// Los nombres que se tapan, del más útil de recordar al menos.
const ORDEN_DE_TIPOS = { persona: 0, organizacion: 1, empresa: 2, lugar: 3 };
// Cada cuántos días vuelve una palabra según su caja: la que ya se sabe se espacia más.
export const INTERVALOS = [0, 1, 3, 7, 16, 35];

// Un azar fijo por semilla, para que una pregunta no cambie al volver a la página el mismo día.
function azar(semilla) {
  let h = 2166136261;
  for (let i = 0; i < semilla.length; i++) h = Math.imul(h ^ semilla.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function barajar(lista, aleatorio) {
  const copia = [...lista];
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(aleatorio() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
}

// Dónde está un nombre en un texto, como palabra completa y sin importar tildes. Devuelve las
// posiciones en el texto original, o null.
export function dondeEsta(texto, nombre) {
  let normal = "";
  const origen = [];
  for (let i = 0; i < texto.length; i++) {
    const n = normalizar(texto[i]);
    for (let k = 0; k < n.length; k++) origen.push(i);
    normal += n;
  }
  origen.push(texto.length);
  const buscado = normalizar(nombre);
  for (let i = normal.indexOf(buscado); i >= 0; i = normal.indexOf(buscado, i + 1)) {
    if (!esLetra(normal[i - 1]) && !esLetra(normal[i + buscado.length])) return [origen[i], origen[i + buscado.length]];
  }
  return null;
}

// Los nombres de cada tipo, con cuántas veces aparecen en el índice, en general y por página.
function nombresPorTipo(indice) {
  const general = new Map();
  const porHoja = new Map();
  for (const h of indice.historias) {
    for (const nombre of h.e || []) {
      const tipo = indice.tipos[nombre];
      if (!(tipo in ORDEN_DE_TIPOS)) continue;
      const clave = `${tipo}|${nombre}`;
      general.set(clave, (general.get(clave) || 0) + 1);
      const hoja = `${h.h}|${clave}`;
      porHoja.set(hoja, (porHoja.get(hoja) || 0) + 1);
    }
  }
  return { general, porHoja };
}

// La última palabra de un nombre, sin "al-" ni "el-": así "Abdel Fattah El Sisi" y "Abdel
// Fattah al-Sisi" cuentan como el mismo y no salen los dos entre las opciones.
const apellido = (nombre) => normalizar(nombre).split(/\s+/).at(-1).replace(/^(al|el)-/, "");

// Tres nombres del mismo tipo que podrían ser la respuesta: primero los de la misma página que
// salen en más de una historia, después los más conocidos de ese tipo.
function distractores(respuesta, tipo, h, conteos, aleatorio) {
  const tapado = normalizar(respuesta);
  const titular = normalizar(h.t);
  const vistos = new Set([apellido(respuesta)]);
  const sirve = (nombre) => {
    const n = normalizar(nombre);
    return !n.includes(tapado) && !tapado.includes(n) && !titular.includes(n) && !vistos.has(apellido(nombre));
  };
  const deTipo = (mapa, prefijo) => [...mapa].filter(([clave]) => clave.startsWith(prefijo))
    .sort((a, b) => b[1] - a[1]).map(([clave]) => clave.slice(prefijo.length));
  const conocidos = (n) => (conteos.general.get(`${tipo}|${n}`) || 0) >= 2;
  const cercanos = deTipo(conteos.porHoja, `${h.h}|${tipo}|`).filter(conocidos).slice(0, 8);
  const generales = deTipo(conteos.general, `${tipo}|`).slice(0, 16);
  const elegidos = [];
  for (const nombre of [...barajar(cercanos, aleatorio), ...barajar(generales, aleatorio)]) {
    if (elegidos.length === 3) break;
    if (!sirve(nombre)) continue;
    elegidos.push(nombre);
    vistos.add(apellido(nombre));
  }
  return elegidos;
}

// Las preguntas sobre las historias que Pedro abrió: el titular con un nombre tapado y cuatro
// opciones. Primero lo que leyó hace más días; no vuelve lo que ya acertó.
export function preguntasDeHistorias({ indice, leidas, repasos, fusionadas = {}, ahora = Date.now(), maximo = 6 }) {
  const porId = new Map(indice.historias.map((h) => [h.id, h]));
  const resolver = (id) => (fusionadas[id] && fusionadas[id] !== id ? resolver(fusionadas[id]) : id);
  const acertadas = new Set(repasos.filter((r) => r.acierto).map((r) => resolver(r.historia)));
  const falladas = new Map(repasos.filter((r) => !r.acierto).map((r) => [resolver(r.historia), Date.parse(r.ts)]));
  const desde = ahora - DIAS_DE_HISTORIAS * 864e5;
  const abiertas = new Map();
  for (const [id, ts] of leidas) {
    const real = resolver(id);
    if (Date.parse(ts) >= desde && porId.has(real) && !acertadas.has(real)
      && !(ahora - (falladas.get(real) || 0) < ESPERA_TRAS_FALLAR)) abiertas.set(real, ts);
  }
  const conteos = nombresPorTipo(indice);
  const dia = new Date(ahora).toISOString().slice(0, 10);
  const preguntas = [];
  for (const [id] of [...abiertas].sort((a, b) => a[1].localeCompare(b[1]))) {
    const h = porId.get(id);
    const nombres = (h.e || []).filter((n) => indice.tipos[n] in ORDEN_DE_TIPOS)
      .map((n) => ({ nombre: n, tipo: indice.tipos[n], lugar: dondeEsta(h.t, n) }))
      .filter((n) => n.lugar && n.nombre.length < h.t.length * 0.6)
      .sort((a, b) => ORDEN_DE_TIPOS[a.tipo] - ORDEN_DE_TIPOS[b.tipo] || b.nombre.length - a.nombre.length);
    if (!nombres.length) continue;
    const { nombre, tipo, lugar: [inicio, fin] } = nombres[0];
    const aleatorio = azar(`${id}|${dia}`);
    const otros = distractores(nombre, tipo, h, conteos, aleatorio);
    if (otros.length < 3) continue;
    preguntas.push({
      historia: id, tipo, respuesta: h.t.slice(inicio, fin), titular: h.t, hoja: h.h,
      antes: h.t.slice(0, inicio), despues: h.t.slice(fin), opciones: barajar([h.t.slice(inicio, fin), ...otros], aleatorio),
    });
    if (preguntas.length === maximo) break;
  }
  return preguntas;
}

// "La sabía" pasa una palabra a la caja siguiente, "Más o menos" la deja donde estaba y "No la
// recordaba" la devuelve a la primera.
export const siguienteCaja = (caja, resultado) => (resultado === "si" ? Math.min(caja + 1, INTERVALOS.length - 1)
  : resultado === "algo" ? Math.max(caja, 1) : 1);

// Cada palabra con su caja, cuándo vuelve y si le toca hoy.
export function estadoDePalabras(palabras, repasos, ahora = Date.now()) {
  return palabras.map((p) => {
    let caja = 0;
    let ultima = null;
    for (const r of repasos.filter((x) => x.entrada === p.id).sort((a, b) => a.ts.localeCompare(b.ts))) {
      caja = siguienteCaja(caja, r.resultado);
      ultima = r.ts;
    }
    const vuelve = ultima ? Date.parse(ultima) + INTERVALOS[caja] * 864e5 : 0;
    return { ...p, caja, ultima, vuelve, toca: vuelve <= ahora };
  });
}

// Una de sus frases, la misma todo el día.
export function fraseDelDia(frases, dia) {
  return frases.length ? frases[Math.floor(azar(dia)() * frases.length)] : null;
}
