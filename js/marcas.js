// Las marcas de Pedro: qué leyó, cómo lo calificó, qué categorías dejó listas.
// Se guardan primero en el navegador y luego se agregan al repositorio privado,
// en datos/marcas/AAAA/MM/DD-<dispositivo>.jsonl: un archivo por día y por
// dispositivo, al que solo se le agregan líneas. Las tareas de GitHub nunca
// escriben esos archivos, así que no hay choques.
//
// Las de los últimos días llegan con la revisión de la copia (datos.js), que trae en una sola
// consulta todos los archivos de marcas del mes; si GitHub no la responde, se leen todos a la vez.

import { config, copiaAlDia, despuesDeCadaRevision, guardarAparte, leerAparte, modoLocal, revisarTambien, revision } from "./datos.js";

const CLAVE_COLA = "mentor.marcas.cola";
const CLAVE_DISPOSITIVO = "mentor.dispositivo";
const API = "https://api.github.com/repos";
const DIAS_DE_MARCAS = 10;
const COPIA_DE_MARCAS = "marcas.json";

const estado = { enviando: false, error: null, enviadas: 0 };
const oyentes = new Set();
let recibidas = null; // las marcas ya guardadas en el repositorio
let cargando = null; // la primera lectura: todas las partes de la página esperan la misma
const enviadasAhora = []; // las que salieron en esta visita, por si la lectura empezó antes
let temporizador = null;

function leerAlmacen(clave, defecto) {
  try { return JSON.parse(localStorage.getItem(clave)) ?? defecto; } catch { return defecto; }
}

function guardarAlmacen(clave, valor) {
  try { localStorage.setItem(clave, JSON.stringify(valor)); } catch { /* sin almacenamiento */ }
}

export function dispositivo() {
  let id = leerAlmacen(CLAVE_DISPOSITIVO, null);
  if (!id) {
    const tipo = /Mobi|Android|iPhone/i.test(navigator.userAgent) ? "celular"
      : /iPad|Tablet/i.test(navigator.userAgent) ? "tableta" : "computador";
    id = `${tipo}-${Math.random().toString(36).slice(2, 6)}`;
    guardarAlmacen(CLAVE_DISPOSITIVO, id);
  }
  return id;
}

// La fecha en Bogotá, para repartir las marcas por día.
function diaDeBogota(fecha) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(fecha);
}

export function estadoDeEnvio() {
  return { ...estado, pendientes: leerAlmacen(CLAVE_COLA, []).length, local: modoLocal() };
}

export function alCambiar(funcion) {
  oyentes.add(funcion);
  return () => oyentes.delete(funcion);
}

function avisarCambio() {
  for (const funcion of oyentes) funcion(estadoDeEnvio());
}

// Las marcas se juntan unos segundos antes de enviarse, para no hacer un
// guardado en el repositorio por cada toque.
const ESPERA_ANTES_DE_ENVIAR = 20000;

// Registra una marca: queda de inmediato en el navegador y se envía poco después.
export function marcar(evento) {
  const marca = { ...evento, id: crypto.randomUUID(), ts: new Date().toISOString(), dispositivo: dispositivo(), origen: "pedro" };
  guardarAlmacen(CLAVE_COLA, [...leerAlmacen(CLAVE_COLA, []), marca]);
  avisarCambio();
  clearTimeout(temporizador);
  temporizador = setTimeout(enviar, ESPERA_ANTES_DE_ENVIAR);
  return marca;
}

// ---------- Codificación base64 de texto UTF-8, como la pide la API de GitHub ----------

function aBase64(texto) {
  const bytes = new TextEncoder().encode(texto);
  let binario = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binario += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binario);
}

function deBase64(b64) {
  const binario = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(binario, (c) => c.charCodeAt(0)));
}

function cabeceras() {
  return { Authorization: `Bearer ${config().token}`, Accept: "application/vnd.github+json" };
}

async function leerArchivo(ruta) {
  const r = await fetch(`${API}/${config().repo}/contents/${ruta}`, { headers: cabeceras(), cache: "no-store" });
  if (r.status === 404) return { texto: "", sha: null };
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} al leer ${ruta}`), { estado: r.status });
  const datos = await r.json();
  return { texto: deBase64(datos.content), sha: datos.sha };
}

async function agregarLineas(ruta, lineas) {
  // Si otro dispositivo o pestaña escribió en medio, GitHub responde 409 y se reintenta.
  for (let intento = 0; intento < 3; intento++) {
    const { texto, sha } = await leerArchivo(ruta);
    const cuerpo = { message: `Marcas de Pedro (${ruta.split("/").pop()})`, content: aBase64(texto + lineas) };
    if (sha) cuerpo.sha = sha;
    const r = await fetch(`${API}/${config().repo}/contents/${ruta}`, {
      method: "PUT", headers: { ...cabeceras(), "Content-Type": "application/json" }, body: JSON.stringify(cuerpo),
    });
    if (r.ok) return;
    if (r.status !== 409 && r.status !== 422) {
      throw Object.assign(new Error(`HTTP ${r.status} al guardar ${ruta}`), { estado: r.status });
    }
  }
  throw new Error(`No se pudo guardar ${ruta} tras varios intentos`);
}

// Envía al repositorio las marcas que esperan en el navegador.
export async function enviar() {
  if (estado.enviando || modoLocal() || !config().token) return;
  const cola = leerAlmacen(CLAVE_COLA, []);
  if (!cola.length) return;
  estado.enviando = true;
  avisarCambio();
  try {
    const porArchivo = new Map();
    for (const marca of cola) {
      const dia = diaDeBogota(new Date(marca.ts));
      const ruta = `datos/marcas/${dia.slice(0, 4)}/${dia.slice(5, 7)}/${dia.slice(8, 10)}-${marca.dispositivo}.jsonl`;
      if (!porArchivo.has(ruta)) porArchivo.set(ruta, []);
      porArchivo.get(ruta).push(marca);
    }
    for (const [ruta, marcas] of porArchivo) {
      await agregarLineas(ruta, marcas.map((m) => JSON.stringify(m) + "\n").join(""));
      // Solo se quitan de la cola las que ya quedaron guardadas.
      const enviadas = new Set(marcas.map((m) => m.id));
      guardarAlmacen(CLAVE_COLA, leerAlmacen(CLAVE_COLA, []).filter((m) => !enviadas.has(m.id)));
      enviadasAhora.push(...marcas);
      estado.enviadas += marcas.length;
    }
    // La copia queda con lo enviado, para que la próxima visita no lo tome por nuevo.
    if (recibidas) guardarAparte(COPIA_DE_MARCAS, JSON.stringify([...recibidas, ...enviadasAhora]));
    estado.error = null;
  } catch (error) {
    estado.error = [401, 403, 404].includes(error.estado)
      ? "El token no tiene permiso para escribir. Tus marcas siguen guardadas en este navegador."
      : "No se pudo conectar con GitHub. Tus marcas siguen guardadas en este navegador y se enviarán luego.";
  } finally {
    estado.enviando = false;
    avisarCambio();
  }
}

// Las marcas de los últimos días, las del repositorio más las que esperan aquí.
export async function todasLasMarcas() {
  cargando ??= cargarMarcas();
  await cargando;
  const vistas = new Set();
  return [...recibidas, ...enviadasAhora, ...leerAlmacen(CLAVE_COLA, [])]
    .filter((m) => !m.id || (!vistas.has(m.id) && vistas.add(m.id)))
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

// Con la copia al día, las marcas guardadas sirven ya y la revisión trae las nuevas después; si
// no, se espera la revisión. Sin revisión, se leen los archivos uno por uno (todos a la vez), y
// sin conexión queda lo que había en la copia.
async function cargarMarcas() {
  if (modoLocal() || !config().token) {
    recibidas = [];
    return;
  }
  if (copiaAlDia()) {
    const guardadas = await marcasDeLaCopia();
    if (guardadas) {
      recibidas ??= guardadas;
      revision().catch(() => {});
      return;
    }
  }
  await revision().catch(() => {});
  if (recibidas === null) {
    recibidas = await archivosUnoPorUno().then(marcasDe).catch(() => null);
    if (recibidas) guardarAparte(COPIA_DE_MARCAS, JSON.stringify(recibidas));
  }
  recibidas ??= (await marcasDeLaCopia()) || [];
}

async function marcasDeLaCopia() {
  try { return JSON.parse(await leerAparte(COPIA_DE_MARCAS)); } catch { return null; }
}

// Las carpetas de los meses que cubren los últimos días.
function carpetasDeMarcas() {
  const meses = new Set();
  for (let d = 0; d <= DIAS_DE_MARCAS; d++) meses.add(diaDeBogota(new Date(Date.now() - d * 864e5)).slice(0, 7));
  return [...meses].map((mes) => `datos/marcas/${mes.replace("-", "/")}`);
}

const fechaDe = (ruta) => ruta.match(/(\d{4})\/(\d{2})\/(\d{2})-[^/]*\.jsonl$/)?.slice(1).join("-");

function marcasDe(archivos) {
  const desde = diaDeBogota(new Date(Date.now() - DIAS_DE_MARCAS * 864e5));
  const marcas = [];
  for (const { ruta, texto } of archivos) {
    if (!(fechaDe(ruta) >= desde)) continue;
    for (const linea of texto.split("\n")) {
      if (linea.trim()) { try { marcas.push(JSON.parse(linea)); } catch { /* línea dañada */ } }
    }
  }
  return marcas;
}

async function leerCrudo(ruta) {
  const r = await fetch(`${API}/${config().repo}/contents/${ruta}`,
    { headers: { ...cabeceras(), Accept: "application/vnd.github.raw+json" }, cache: "no-store" });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} al leer ${ruta}`), { estado: r.status });
  return r.text();
}

async function archivosUnoPorUno() {
  const listas = await Promise.all(carpetasDeMarcas().map(async (carpeta) => {
    const r = await fetch(`${API}/${config().repo}/contents/${carpeta}`, { headers: cabeceras(), cache: "no-store" });
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`HTTP ${r.status} al leer ${carpeta}`);
    return (await r.json()).map((archivo) => archivo.path);
  }));
  const desde = diaDeBogota(new Date(Date.now() - DIAS_DE_MARCAS * 864e5));
  return Promise.all(listas.flat().filter((ruta) => fechaDe(ruta) >= desde)
    .map(async (ruta) => ({ ruta, texto: await leerCrudo(ruta) })));
}

// Cada revisión trae los archivos de marcas de todos los dispositivos. Si hay marcas que esta
// página no tenía (las del celular, por ejemplo), la vista puede volver a pintarse con ellas.
revisarTambien(carpetasDeMarcas);
despuesDeCadaRevision(async ({ textos }) => {
  const carpetas = carpetasDeMarcas().filter((carpeta) => carpeta in textos);
  if (!carpetas.length) return false;
  const archivos = await Promise.all(carpetas.flatMap((carpeta) => textos[carpeta].map(async (e) => {
    const ruta = `${carpeta}/${e.name}`;
    return { ruta, texto: e.object?.isTruncated ? await leerCrudo(ruta) : e.object?.text || "" };
  })));
  const frescas = marcasDe(archivos);
  const conocidas = recibidas && new Set([...recibidas, ...enviadasAhora, ...leerAlmacen(CLAVE_COLA, [])].map((m) => m.id));
  recibidas = frescas;
  guardarAparte(COPIA_DE_MARCAS, JSON.stringify(frescas));
  return Boolean(conocidas) && frescas.some((m) => m.id && !conocidas.has(m.id));
});

// Al salir de la página, intenta enviar lo pendiente.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") enviar();
});
