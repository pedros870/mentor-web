// Acceso a los datos. En GitHub Pages se leen del repositorio privado con el
// token de Pedro, guardado solo en su navegador. En el computador de
// desarrollo (localhost) se leen de la carpeta del proyecto.
//
// Lo que se baja queda en una copia en este navegador, con la huella que git le da a cada
// archivo. Los datos cambian casi solo con la corrida de la mañana, así que Mentor se pinta
// desde la copia, y una sola consulta a GitHub, la revisión, dice qué archivos cambiaron (y de
// paso trae las marcas de los últimos días). Solo lo que cambió se vuelve a bajar.

const CLAVE_TOKEN = "mentor.token";
const CLAVE_REPO = "mentor.repo";
const CLAVE_COPIA = "mentor.copia";
const NOMBRE_COPIA = "mentor-copia-1";
export const REPO_POR_DEFECTO = "pedros870/mentor";
const API = "https://api.github.com";
// Revisada hace menos de esto, la copia se usa sin esperar otra revisión (al recargar la página).
const HACE_POCO = 10 * 60000;
// Los artículos no cambian después de guardados, y son una carpeta por fuente y día: no se revisan.
const SIN_REVISAR = /^datos\/crudo\//;
// Lo que no se abre en estos días sale de la copia.
const DIAS_EN_LA_COPIA = 5;

export class ErrorDeDatos extends Error {
  constructor(estado, ruta) {
    super(`HTTP ${estado} al leer ${ruta}`);
    this.estado = estado;
    this.ruta = ruta;
  }
}

export function modoLocal() {
  return ["localhost", "127.0.0.1"].includes(location.hostname);
}

// El almacenamiento del navegador puede fallar (ventana privada, permisos);
// la página sigue funcionando y solo pide el token de nuevo.
function leerAlmacen(clave) {
  try { return localStorage.getItem(clave); } catch { return null; }
}

export function config() {
  return { token: leerAlmacen(CLAVE_TOKEN), repo: leerAlmacen(CLAVE_REPO) || REPO_POR_DEFECTO };
}

// Un token nuevo empieza sin copia: lo primero que lea va a GitHub y así se sabe si sirve.
export function guardarConfig(token, repo) {
  borrarCopia();
  try {
    localStorage.setItem(CLAVE_TOKEN, token);
    localStorage.setItem(CLAVE_REPO, repo);
    return true;
  } catch {
    return false;
  }
}

export function borrarConfig() {
  try {
    localStorage.removeItem(CLAVE_TOKEN);
    localStorage.removeItem(CLAVE_REPO);
  } catch { /* nada que borrar */ }
  borrarCopia();
}

// ---------- Leer ----------

const memoria = new Map(); // lo que ya se leyó en esta visita
const usadasEnLaVista = new Set(); // lo que pidió la vista que está en pantalla

export function leerTexto(ruta) {
  usadasEnLaVista.add(ruta);
  if (!memoria.has(ruta)) {
    const promesa = modoLocal() ? leerDelProyecto(ruta) : traer(ruta);
    promesa.catch(() => memoria.delete(ruta));
    memoria.set(ruta, promesa);
  }
  return memoria.get(ruta);
}

export async function leerJSON(ruta) {
  return JSON.parse(await leerTexto(ruta));
}

async function leerDelProyecto(ruta) {
  const r = await fetch(`../${ruta}`, { cache: "no-store" });
  if (!r.ok) throw new ErrorDeDatos(r.status, ruta);
  return r.text();
}

async function traer(ruta) {
  if (enCopia(ruta) && await sirveLaCopia(ruta)) {
    const texto = await deLaCopia(ruta);
    if (texto !== null) {
      usar(ruta);
      return texto;
    }
  }
  try {
    return await bajar(ruta);
  } catch (error) {
    // Sin conexión con GitHub: lo que haya en la copia, aunque no se haya podido revisar.
    const sinRespuesta = !(error instanceof ErrorDeDatos) || error.estado >= 500;
    const guardado = sinRespuesta ? await deLaCopia(ruta) : null;
    if (guardado === null) throw error;
    avisar({ sinConexion: true });
    return guardado;
  }
}

async function bajar(ruta) {
  const { token, repo } = config();
  const r = await fetch(`${API}/repos/${repo}/contents/${encodeURI(ruta)}`, {
    // Solo encabezados que GitHub autoriza desde el navegador (CORS).
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.raw+json",
    },
    cache: "no-store",
  });
  if (!r.ok) throw new ErrorDeDatos(r.status, ruta);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const texto = new TextDecoder().decode(bytes);
  guardarEnLaCopia(ruta, texto, bytes);
  return texto;
}

// Lo que pide cada vista, para saber si lo que cambió le toca a la que está en pantalla.
export function nuevaVista() {
  usadasEnLaVista.clear();
}

export function laVistaUsa(rutas) {
  return rutas.some((ruta) => usadasEnLaVista.has(ruta));
}

// Deja en la copia algo que seguramente se va a abrir, sin frenar lo que está en pantalla.
export async function tenerListo(ruta) {
  if (modoLocal() || memoria.has(ruta)) return;
  await revision();
  if (!enCopia(ruta)) await bajar(ruta);
}

// ---------- La copia en el navegador ----------
// El texto va en el Cache Storage; el índice (la huella y el último día de uso de cada archivo,
// cuándo se revisó y de qué día es la última corrida que vio la revisión) va en localStorage,
// para saberlo sin esperar.

let copia = leerIndice();

function leerIndice() {
  try {
    const indice = JSON.parse(localStorage.getItem(CLAVE_COPIA));
    if (indice?.archivos) return indice;
  } catch { /* sin almacenamiento */ }
  return { archivos: {}, revisada: null, diaDeLosDatos: null };
}

let temporizadorIndice = null;
function guardarIndice() {
  clearTimeout(temporizadorIndice);
  temporizadorIndice = setTimeout(() => {
    try { localStorage.setItem(CLAVE_COPIA, JSON.stringify(copia)); } catch { /* sin almacenamiento */ }
  });
}

function diaEnBogota(fecha = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(fecha);
}

// La copia se usa sin preguntar si ya tiene la corrida de hoy o si se revisó hace un momento.
export function copiaAlDia() {
  return copia.diaDeLosDatos === diaEnBogota()
    || (Boolean(copia.revisada) && Date.now() - Date.parse(copia.revisada) < HACE_POCO);
}

const enCopia = (ruta) => Boolean(copia.archivos[ruta]?.oid);

function usar(ruta) {
  const archivo = copia.archivos[ruta];
  if (archivo && archivo.usada !== diaEnBogota()) {
    archivo.usada = diaEnBogota();
    guardarIndice();
  }
}

let almacen = null;
function abrirAlmacen() {
  almacen ??= Promise.resolve().then(() => caches.open(NOMBRE_COPIA)).catch(() => null);
  return almacen;
}

const claveDe = (ruta) => new URL(`copia/${encodeURIComponent(ruta)}`, document.baseURI).href;

async function deLaCopia(ruta) {
  try {
    const respuesta = await (await abrirAlmacen())?.match(claveDe(ruta));
    return respuesta ? await respuesta.text() : null;
  } catch {
    return null;
  }
}

async function aLaCopia(ruta, texto) {
  try {
    const caja = await abrirAlmacen();
    if (!caja) return false;
    await caja.put(claveDe(ruta), new Response(texto, { headers: { "Content-Type": "text/plain; charset=utf-8" } }));
    return true;
  } catch {
    return false; // sin espacio o sin permiso: queda sin copia
  }
}

async function guardarEnLaCopia(ruta, texto, bytes) {
  const oid = await huellaGit(bytes).catch(() => null);
  if (oid && await aLaCopia(ruta, texto)) {
    copia.archivos[ruta] = { oid, usada: diaEnBogota() };
    guardarIndice();
  }
}

function sacarDeLaCopia(ruta) {
  delete copia.archivos[ruta];
  guardarIndice();
  abrirAlmacen().then((caja) => caja?.delete(claveDe(ruta))).catch(() => {});
}

function borrarCopia() {
  copia = { archivos: {}, revisada: null, diaDeLosDatos: null };
  try { localStorage.removeItem(CLAVE_COPIA); } catch { /* sin almacenamiento */ }
  memoria.clear();
  almacen = null;
  Promise.resolve().then(() => caches.delete(NOMBRE_COPIA)).catch(() => {});
}

// Lo que otro módulo guarda en la copia por su cuenta (las marcas): no pasa por la revisión.
export async function guardarAparte(nombre, texto) {
  await aLaCopia(`aparte/${nombre}`, texto);
}

export function leerAparte(nombre) {
  return deLaCopia(`aparte/${nombre}`);
}

// La huella que git le da a un archivo: con ella se compara la copia con el repositorio.
async function huellaGit(bytes) {
  const cabecera = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const todo = new Uint8Array(cabecera.length + bytes.length);
  todo.set(cabecera);
  todo.set(bytes, cabecera.length);
  const resumen = new Uint8Array(await crypto.subtle.digest("SHA-1", todo));
  return Array.from(resumen, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Lo que no se abrió en varios días sale de la copia, y también lo que quedó sin índice.
async function podar() {
  const limite = diaEnBogota(new Date(Date.now() - DIAS_EN_LA_COPIA * 864e5));
  for (const [ruta, archivo] of Object.entries(copia.archivos)) {
    if (!archivo.usada || archivo.usada < limite) sacarDeLaCopia(ruta);
  }
  const caja = await abrirAlmacen();
  for (const pedido of (await caja?.keys()) || []) {
    const ruta = decodeURIComponent(new URL(pedido.url).pathname.split("/copia/")[1] || "");
    if (ruta && !ruta.startsWith("aparte/") && !copia.archivos[ruta]) caja.delete(pedido);
  }
}

if (!modoLocal()) setTimeout(() => podar().catch(() => {}), 10000);

// ---------- La revisión ----------
// Una consulta a la API GraphQL de GitHub con la huella de cada archivo de las carpetas que hay
// en la copia, la fecha de la última corrida y el texto de las carpetas que otros módulos piden
// (las marcas). Lo que cambió sale de la copia; si ya estaba en pantalla, se avisa.

let revisionActual = null;
let estadoRevision = "sin empezar"; // andando, lista o fallida
const porConfirmar = new Set(); // lo que se mostró de la copia antes de que la revisión terminara
const conTexto = new Set(); // funciones que dicen qué carpetas traer con el texto de sus archivos
const alRevisar = new Set(); // lo que hace cada módulo con lo que trae la revisión
const oyentes = new Set();

export function revisarTambien(carpetas) {
  conTexto.add(carpetas);
}

// La función recibe { textos } y responde si cambió algo que la página deba mostrar.
export function despuesDeCadaRevision(funcion) {
  alRevisar.add(funcion);
}

export function alActualizar(funcion) {
  oyentes.add(funcion);
}

function avisar(cambio) {
  for (const funcion of oyentes) funcion(cambio);
}

export function revision() {
  if (modoLocal()) return Promise.reject(new Error("En el computador de desarrollo no hay revisión"));
  revisionActual ??= revisar();
  return revisionActual;
}

// Si la copia no está al día, primero la revisión, que saca de la copia lo que cambió.
async function sirveLaCopia(ruta) {
  if (SIN_REVISAR.test(ruta)) return true;
  if (copiaAlDia()) {
    if (estadoRevision !== "lista") porConfirmar.add(ruta);
    revision().catch(() => {});
    return true;
  }
  try {
    await revision();
  } catch {
    return false;
  }
  return enCopia(ruta);
}

async function revisar() {
  estadoRevision = "andando";
  try {
    const rutas = Object.keys(copia.archivos).filter((ruta) => !SIN_REVISAR.test(ruta));
    const carpetas = [...new Set(rutas.map((ruta) => ruta.slice(0, ruta.lastIndexOf("/"))))];
    const conTextos = [...new Set([...conTexto].flatMap((carpetasDe) => carpetasDe()))];
    const [dueno, nombre] = config().repo.split("/");
    const objeto = (ruta) => `object(expression: ${JSON.stringify(`HEAD:${ruta}`)})`;
    const repositorio = await consultar(`query { repository(owner: ${JSON.stringify(dueno)}, name: ${JSON.stringify(nombre)}) {
      ultima: ${objeto("datos/indice/ultima.json")} { ... on Blob { text } }
      ${carpetas.map((c, i) => `c${i}: ${objeto(c)} { ... on Tree { entries { name oid } } }`).join("\n")}
      ${conTextos.map((c, i) => `t${i}: ${objeto(c)} { ... on Tree { entries { name oid object { ... on Blob { text isTruncated } } } } }`).join("\n")}
    } }`);
    const huellas = new Map();
    carpetas.forEach((carpeta, i) => {
      for (const { name, oid } of repositorio[`c${i}`]?.entries || []) huellas.set(`${carpeta}/${name}`, oid);
    });
    const cambiadas = rutas.filter((ruta) => copia.archivos[ruta] && huellas.get(ruta) !== copia.archivos[ruta].oid);
    for (const ruta of cambiadas) sacarDeLaCopia(ruta);
    // Lo que ya se mostró de la copia y resultó viejo: hay que volver a pedirlo.
    const viejas = cambiadas.filter((ruta) => porConfirmar.has(ruta));
    for (const ruta of viejas) memoria.delete(ruta);
    porConfirmar.clear();
    copia.revisada = new Date().toISOString();
    try { copia.diaDeLosDatos = JSON.parse(repositorio.ultima?.text || "{}").fecha || null; } catch { /* sin fecha */ }
    guardarIndice();
    estadoRevision = "lista";
    const textos = Object.fromEntries(conTextos.map((carpeta, i) => [carpeta, repositorio[`t${i}`]?.entries || []]));
    const respuestas = await Promise.all([...alRevisar].map((funcion) =>
      Promise.resolve().then(() => funcion({ textos })).catch(() => false)));
    const cambio = { archivos: viejas, marcas: respuestas.some(Boolean) };
    if (viejas.length || cambio.marcas) avisar(cambio);
    return { cambiadas };
  } catch (error) {
    estadoRevision = "fallida";
    throw error;
  }
}

async function consultar(consulta) {
  const r = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config().token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: consulta }),
  });
  if (!r.ok) throw new ErrorDeDatos(r.status, "la revisión");
  const { data, errors } = await r.json();
  if (errors?.length || !data?.repository) throw new Error(errors?.[0]?.message || "La revisión no trajo el repositorio");
  return data.repository;
}

// Al volver a Mentor después de un rato se revisa otra vez: pudo llegar la corrida de la mañana
// o una respuesta de Claude.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || modoLocal() || !config().token || !revisionActual) return;
  if (estadoRevision === "andando") return;
  if (estadoRevision === "lista" && Date.now() - Date.parse(copia.revisada) < HACE_POCO) return;
  for (const ruta of memoria.keys()) porConfirmar.add(ruta);
  revisionActual = null;
  revision().catch(() => {});
});
