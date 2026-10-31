// Mentor: la interfaz de lectura. Una sola página con vistas por dirección
// (#/hoy, #/geografia, #/areas, #/sectores, #/p/…, #/h/…, #/leer/…, #/para-leer, #/cuaderno, #/repaso, #/estado…).
import { buscar, impulsoDeHistoria, normalizar } from "./buscador.js";
import { ErrorDeDatos, REPO_POR_DEFECTO, alActualizar, borrarConfig, config, guardarConfig, laVistaUsa, leerJSON, leerTexto, modoLocal,
  nuevaVista, tenerListo } from "./datos.js";
import { enLinea, escapar, markdownAHtml, separarFicha } from "./markdown.js";
import { alCambiar, enviar, estadoDeEnvio, marcar, todasLasMarcas } from "./marcas.js";
import { INTERVALOS, dondeEsta, estadoDePalabras, fraseDelDia, preguntasDeHistorias, siguienteCaja } from "./repaso.js";
import { escuchar, partir, pausarOSeguir, puedeHablar } from "./voz.js";

const contenido = document.getElementById("contenido");

// Un aviso breve al pie de la pantalla, para confirmar que una marca quedó guardada. Con una
// acción, lleva un botón y dura más.
let temporizadorAviso = null;
function avisar(texto, accion) {
  const aviso = document.getElementById("aviso");
  aviso.replaceChildren(texto);
  if (accion) {
    const boton = document.createElement("button");
    boton.type = "button";
    boton.className = "aviso-accion";
    boton.textContent = accion.texto;
    boton.addEventListener("click", () => {
      aviso.hidden = true;
      accion.hacer();
    });
    aviso.append(" ", boton);
  }
  aviso.hidden = false;
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => { aviso.hidden = true; }, accion ? 20000 : 2500);
}

let ultimoError = null;
alCambiar((estado) => {
  if (estado.error && estado.error !== ultimoError) avisar(estado.error);
  ultimoError = estado.error;
});

const CATEGORIAS = [
  "IA y tecnología", "Capital, empresas y señales", "Economía y mundo", "Ciencia",
  "Cultura e ideas", "Tus sectores", "Avances técnicos",
];

const TIPOS_DE_FALLA = {
  sin_direccion: "Sin dirección real en el catálogo",
  pendiente_de_pedro: "Pendientes de una acción tuya",
  vigilar_pagina: "Esperan el vigilante de páginas",
  sin_feed: "Sin feed",
  pagina_js: "Página armada en el navegador y sin feed",
  robots: "robots.txt no permite recolectar",
  bloqueo: "El sitio bloquea la descarga",
  pago: "Contenido de pago",
  no_encontrado: "Dirección no encontrada",
  feed_invalido: "El feed dejó de funcionar",
  error_de_red: "Error de red",
  error_del_sitio: "Error del sitio",
  error_inesperado: "Error inesperado del recolector",
};

const MOTIVOS_DE_EXTRACTO = {
  pago: "de pago", bloqueo: "el sitio bloquea", robots: "robots.txt", no_encontrado: "no encontrado",
  sin_texto: "sin texto", pagina_js: "página armada en el navegador", error_de_red: "error de red",
  error_del_sitio: "error del sitio",
};

// ---------- Plantillas: todo valor se escapa salvo lo marcado como seguro ----------

class Seguro {
  constructor(texto) { this.texto = texto; }
}
const seguro = (texto) => new Seguro(texto);

function convertir(valor) {
  if (valor instanceof Seguro) return valor.texto;
  if (Array.isArray(valor)) return valor.map(convertir).join("");
  if (valor === null || valor === undefined || valor === false) return "";
  return escapar(valor);
}

function html(partes, ...valores) {
  return seguro(partes.reduce((acc, parte, i) => acc + parte + (i < valores.length ? convertir(valores[i]) : ""), ""));
}

function pintar(plantilla, destino = contenido) {
  destino.innerHTML = plantilla.texto;
}

// ---------- Formatos ----------

const numero = (n) => n.toLocaleString("es-CO");

function fechaLarga(iso, conHora = false) {
  if (!iso) return "";
  const fecha = new Date(iso.length === 10 ? `${iso}T12:00:00-05:00` : iso);
  return new Intl.DateTimeFormat("es-CO", {
    day: "numeric", month: "long", year: conHora ? undefined : "numeric",
    hour: conHora ? "numeric" : undefined, minute: conHora ? "2-digit" : undefined,
    timeZone: "America/Bogota",
  }).format(fecha);
}

function hora(iso) {
  return new Intl.DateTimeFormat("es-CO", { hour: "numeric", minute: "2-digit", timeZone: "America/Bogota" })
    .format(new Date(iso));
}

function dominio(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

const sinTildes = (texto) => (texto || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function agrupar(lista, clave) {
  const grupos = new Map();
  for (const item of lista) {
    const k = clave(item);
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(item);
  }
  return grupos;
}

const diaEnBogota = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date(iso));
const diaDeHoy = () => diaEnBogota(new Date().toISOString());
const recortar = (texto, largo) => (texto.length > largo ? `${texto.slice(0, largo).replace(/\s+\S*$/, "")}…` : texto);

// Lo que cada vista deja listo para el resto de la página: qué se escucha con "Escuchar" (o la
// tecla e), las historias que tiene a la vista y las teclas propias de la vista. Se limpian al
// cambiar de vista.
let paraEscuchar = null;
let teclasDeLaVista = null;
const historiasEnVista = new Map();

async function ultimaRecoleccion() {
  const ultima = await leerJSON("datos/indice/ultima.json");
  const indice = await leerJSON(ultima.indice);
  return { ultima, indice, articulos: indice.corridas.flatMap((c) => c.articulos) };
}

function enlaceLector(articulo) {
  return `#/leer/${encodeURIComponent(articulo.archivo)}`;
}

function itemArticulo(a) {
  const extracto = a.extraccion === "extracto"
    ? html`<span class="insignia insignia-aviso">extracto · ${MOTIVOS_DE_EXTRACTO[a.motivo_extracto] || a.motivo_extracto}</span>` : "";
  const tambien = a.tambien_en?.length ? html`<span class="insignia">también en ${a.tambien_en.length + 1} fuentes</span>` : "";
  return html`<li><a class="articulo" href="${enlaceLector(a)}">
    <span class="articulo-titulo">${a.titulo}</span>
    <span class="meta">${a.fuente} · ${a.minutos_lectura} min ${extracto}${tambien}</span>
  </a></li>`;
}

// ---------- Lo que Claude recomienda y lo que Pedro leyó ----------

const RECOMENDACIONES = { leer: "Leer completo", resumen: "Basta el resumen", saltar: "Saltar" };
const ORDEN_RECOMENDACION = { leer: 0, resumen: 1, saltar: 2 };

async function leerResumen() {
  try {
    const puntero = await leerJSON("datos/resumenes/ultimo.json");
    return await leerJSON(puntero.json);
  } catch (error) {
    if (error instanceof ErrorDeDatos && error.estado === 404) return null;
    throw error;
  }
}

// Qué clase de pieza es (scripts/organizar.py); las noticias no llevan etiqueta.
const TIPOS_DE_PIEZA = { "investigación": "Investigación", "análisis": "Análisis", "opinión": "Opinión", informe: "Informe", mercado: "Mercado" };

// El organizador guarda, por día, el tipo de las piezas que no son noticias.
function tiposDelDia(ruta) {
  const dia = ruta.match(/^datos\/crudo\/(\d{4}\/\d{2}\/\d{2})\//)?.[1];
  return dia ? leerJSON(`datos/v2/tipos/${dia}.json`).catch(() => ({})) : Promise.resolve({});
}

// Quién está detrás de cada fuente: dueño, de qué vive y su línea (catalogo/fichas_fuentes.json).
function fichasDeFuentes() {
  return leerJSON("catalogo/fichas_fuentes.json").then((d) => d.fuentes).catch(() => ({}));
}

function quienEstaDetras(f, nombre) {
  if (!f) return "";
  const filas = [["Qué es", f.clase], ["Dueño", f.dueno], ["De qué vive", f.financiacion], ["Línea editorial", f.linea]]
    .filter(([, v]) => v);
  return html`<details class="quien-detras"><summary>Quién está detrás de ${nombre}</summary>
    ${f.tener_en_cuenta ? html`<p class="tener-en-cuenta">${f.tener_en_cuenta}</p>` : ""}
    <dl>${filas.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
    <p class="meta">Ficha de Claude${f.confianza === "baja" ? ", con datos por confirmar" : ""}${f.enlaces?.length
      ? html`: ${f.enlaces.map((u, i) => html`${i ? " · " : ""}<a href="${u}" target="_blank" rel="noopener noreferrer">${dominio(u)}</a>`)}` : ""}</p>
  </details>`;
}

// Lo que Pedro ha marcado, reducido a su estado actual: la última marca manda.
async function estadoDeLectura() {
  const leidos = new Set();
  const calificaciones = new Map();
  const notas = new Map();
  const listas = new Map();
  const preferencias = new Map();
  const marcadas = new Set(); // lo que tiene alguna marca de leído o calificación en estos días
  for (const m of await todasLasMarcas()) {
    // Un artículo o una lectura de la biblioteca se marca por su archivo; una lectura
    // que no está en la biblioteca, por su id.
    const clave = m.archivo || (m.lectura ? `lectura:${m.lectura}` : null);
    if (m.tipo === "leido") {
      if (m.valor === false) leidos.delete(clave); else leidos.add(clave);
      marcadas.add(clave);
    } else if (m.tipo === "calificacion") {
      calificaciones.set(clave, m.valor);
      leidos.add(clave);
      marcadas.add(clave);
    } else if (m.tipo === "nota") {
      notas.set(clave, m.texto);
    } else if (m.tipo === "categoria") {
      listas.set(`${m.resumen}|${m.categoria}`, m.estado === "lista");
    } else if (m.tipo === "preferencia") {
      preferencias.set(`${m.resumen}|${m.categoria}|${m.tema}`, m.valor);
    }
  }
  return { leidos, calificaciones, notas, listas, preferencias, marcadas };
}

// ---------- Lector ----------

// ---------- Dónde quedó Pedro en una lectura larga ----------

const CLAVE_AVANCE = "mentor-avance"; // en este navegador, para retomar al instante
const CLAVE_IR_A = "mentor-ir-a"; // el párrafo de una frase guardada, para abrir el lector ahí
const VOLVER_SOLO = 30 * 60000; // si saliste hace menos de media hora, vuelves solo a donde ibas
const MINIMO_DE_BLOQUES = 12; // con menos párrafos no es una lectura larga
const GUARDAR_AVANCE_CADA = 180000;

function avancesLocales() {
  try { return JSON.parse(localStorage.getItem(CLAVE_AVANCE) || "{}"); } catch { return {}; }
}

// El párrafo donde quedó cada lectura: lo que se junta cada noche, las marcas de los últimos
// días (de cualquier dispositivo) y lo de este navegador. Manda lo más reciente; "Lo leí" lo borra.
async function avances() {
  const mapa = new Map(Object.entries(await leerJSON("datos/biblioteca/progreso.json").catch(() => ({}))));
  const poner = (archivo, a) => {
    if ((mapa.get(archivo)?.fecha || "") < a.fecha) mapa.set(archivo, a);
  };
  for (const m of await todasLasMarcas()) {
    if (!m.archivo) continue;
    if (m.tipo === "progreso") poner(m.archivo, { parrafo: m.parrafo, total: m.total, fecha: m.ts, titulo: m.titulo });
    else if (["leido", "calificacion"].includes(m.tipo) && m.valor !== false) poner(m.archivo, { borrado: true, fecha: m.ts });
  }
  for (const [archivo, a] of Object.entries(avancesLocales())) poner(archivo, a);
  return new Map([...mapa].filter(([, a]) => !a.borrado));
}

const porcentaje = (a) => Math.min(99, Math.round((100 * (a.parrafo + 1)) / (a.total || 1)));

// En el lector: una barra con lo leído, el botón para seguir donde quedó y, al salir
// (o cada tres minutos), una marca con el párrafo que tenía a la vista y el título, para
// ofrecer en Hoy seguir donde quedó.
function seguirAvance(ruta, avance, leido, titulo) {
  const bloques = [...contenido.querySelectorAll(".lector .cuerpo > *")];
  const ir = (i) => {
    if (!bloques[i]) return;
    bloques[i].classList.add("aqui-quedaste");
    bloques[i].scrollIntoView({ block: "start" });
  };
  let irA = null;
  try {
    irA = JSON.parse(localStorage.getItem(CLAVE_IR_A) || "null");
    localStorage.removeItem(CLAVE_IR_A);
  } catch { /* sin almacenamiento */ }
  const deUnaFrase = irA?.archivo === ruta && Date.now() - irA.ts < 600000;
  if (deUnaFrase) ir(irA.parrafo);
  if (bloques.length < MINIMO_DE_BLOQUES) return;
  const barra = document.createElement("div");
  barra.className = "avance-barra";
  barra.innerHTML = "<span></span>";
  contenido.querySelector(".lector").prepend(barra);
  const enCurso = avance && !leido && avance.parrafo >= 2 && avance.parrafo < bloques.length - 2;
  if (enCurso && !deUnaFrase && Date.now() - Date.parse(avance.fecha) < VOLVER_SOLO) {
    ir(avance.parrafo); // saliste un momento (al Cuaderno, a otra pestaña): vuelves solo
    avisar("Volviste a donde ibas");
  } else if (enCurso && !deUnaFrase) {
    const aviso = document.createElement("p");
    aviso.className = "retomar";
    aviso.innerHTML = `<button class="boton" type="button">Seguir donde quedaste</button>
      <span class="meta">Vas en el ${porcentaje({ ...avance, total: bloques.length })} %</span>`;
    contenido.querySelector(".lector header").append(aviso);
    aviso.querySelector("button").addEventListener("click", () => {
      const bloque = bloques[avance.parrafo];
      bloque.classList.add("aqui-quedaste");
      bloque.scrollIntoView({ block: "start" });
      aviso.remove();
    });
  }
  let actual = 0;
  let enviado = avance?.parrafo ?? 0;
  const medir = () => {
    const tope = document.querySelector(".cabecera")?.getBoundingClientRect().bottom || 0;
    const i = bloques.findIndex((b) => b.getBoundingClientRect().bottom > tope + 8);
    actual = i === -1 ? bloques.length - 1 : i;
    barra.firstChild.style.width = `${(100 * (actual + 1)) / bloques.length}%`;
  };
  const guardar = () => {
    if (actual < 2 || actual === enviado) return;
    enviado = actual;
    const a = { parrafo: actual, total: bloques.length, fecha: new Date().toISOString(), titulo };
    try {
      localStorage.setItem(CLAVE_AVANCE, JSON.stringify({ ...avancesLocales(), [ruta]: a }));
    } catch { /* sin almacenamiento: queda la marca */ }
    marcar({ tipo: "progreso", archivo: ruta, parrafo: actual, total: bloques.length, titulo });
  };
  let cuadro = null;
  const alDesplazar = () => {
    if (!cuadro) cuadro = requestAnimationFrame(() => { cuadro = null; medir(); });
  };
  const alOcultar = () => { if (document.visibilityState === "hidden") guardar(); };
  const cada = setInterval(guardar, GUARDAR_AVANCE_CADA);
  window.addEventListener("scroll", alDesplazar, { passive: true });
  document.addEventListener("visibilitychange", alOcultar);
  window.addEventListener("hashchange", () => {
    guardar();
    window.removeEventListener("scroll", alDesplazar);
    document.removeEventListener("visibilitychange", alOcultar);
    clearInterval(cada);
  }, { once: true });
  medir();
}

async function vistaLector(ruta) {
  if (!/^datos\/(crudo|biblioteca)\/[\w/.-]+\.md$/.test(ruta)) throw new Error("La dirección no corresponde a un artículo.");
  const deLaBiblioteca = ruta.startsWith("datos/biblioteca/");
  const { ficha, cuerpo } = separarFicha(await leerTexto(ruta));
  const texto = cuerpo
    .replace(/^\s*# .*\n/, "") // el título ya va en la cabecera
    .replace(/\n---\n\nSolo se obtuvo el extracto[\s\S]*$/, "");
  const extracto = ficha.extraccion === "extracto";
  const [resumen, lectura, cuadernoLector, avancesGuardados, tipos, fichas] = await Promise.all([leerResumen().catch(() => null),
    estadoDeLectura(), leerCuaderno().catch(() => []), avances(), tiposDelDia(ruta), fichasDeFuentes()]);
  const tipo = TIPOS_DE_PIEZA[tipos[ruta]];
  const hilosDeLaPieza = hilosDe(cuadernoLector).filter((x) => x[0].archivo === ruta && x[0].clase !== "palabra" && !x[0].archivada);
  const clasificacion = resumen?.titulares.find((t) => t.archivo === ruta);
  // Lo que el sistema recomendó leer completo (y lo de Para leer) se califica con
  // "¿valió la pena?" (mide si acierta); lo demás, con "¿te sirvió?" (mide lo que se está perdiendo).
  const recomendada = deLaBiblioteca || resumen?.lecturas_del_dia.some((l) => l.archivo === ruta)
    || resumen?.aviso_noche_archivo === ruta || clasificacion?.recomendacion === "leer";
  const pregunta = recomendada ? "valio_la_pena" : "te_sirvio";
  const calificacion = lectura.calificaciones.get(ruta);
  const leido = lectura.leidos.has(ruta);
  marcar({ tipo: "abierto", archivo: ruta });
  pintar(html`
    <article class="lector" data-archivo="${ruta}" data-titulo="${ficha.titulo}">
      ${deLaBiblioteca ? html`<a class="volver" href="#/para-leer">← Para leer</a>` : html`<a class="volver" href="#/hoy">← Hoy</a>`}
      <header>
        <p class="sobretitulo">${ficha.fuente}${ficha.categoria_inicial ? ` · ${ficha.categoria_inicial}` : ""}</p>
        <h1>${ficha.titulo}</h1>
        <p class="meta">${tipo ? html`<span class="insignia insignia-tipo">${tipo}</span> ` : ""}${[ficha.autor,
          fechaLarga(ficha.fecha_publicacion, true), `${ficha.minutos_lectura} min de lectura`].filter(Boolean).join(" · ")}</p>
        ${botonEscuchar("Escuchar desde aquí")}
        ${quienEstaDetras(fichas[ficha.fuente_id], ficha.fuente)}
        ${clasificacion ? html`<p class="razon-claude"><span class="insignia insignia-${clasificacion.recomendacion}">${RECOMENDACIONES[clasificacion.recomendacion]}</span> ${clasificacion.razon}</p>` : ""}
        ${extracto ? html`<p class="aviso">Solo se obtuvo el extracto (${MOTIVOS_DE_EXTRACTO[ficha.motivo_extracto] || ficha.motivo_extracto}). El texto completo está en el original.</p>` : ""}
      </header>
      <div class="cuerpo">${seguro(markdownAHtml(texto))}</div>
      <section class="valoracion">
        <button class="boton-secundario" type="button" id="leido" aria-pressed="${String(leido)}">${leido ? "✓ Leído" : "Lo leí"}</button>
        <h2>${recomendada ? "¿Valió la pena?" : "¿Te sirvió?"}</h2>
        <div class="opciones" role="group" aria-label="Calificación">
          ${["mucho", "algo", "nada"].map((v) => html`<button class="opcion" type="button" data-valor="${v}" aria-pressed="${String(calificacion === v)}">${v[0].toUpperCase() + v.slice(1)}</button>`)}
        </div>
        <label class="nota-lector">¿Qué te dejó o qué te cambió? <span class="meta">(opcional)</span>
          <textarea id="nota" rows="3">${lectura.notas.get(ruta) || ""}</textarea>
        </label>
        <label class="discutir"><input type="checkbox" id="discutir"> Quiero discutirlo con Claude <span class="meta">(queda en el Cuaderno)</span></label>
        <button class="boton" type="button" id="guardar-nota">Guardar nota</button>
      </section>
      <section class="preguntas-lector">
        <h2>Pregúntale a Claude</h2>
        <p class="meta">Selecciona una palabra o una frase del texto para guardarla en el vocabulario.</p>
        ${hilosDeLaPieza.map((x) => hilo(x, { conContexto: false }))}
        <details class="preguntar"><summary>Preguntar sobre esta pieza</summary>
          ${formularioCuaderno({ archivo: ruta, titulo: ficha.titulo, rapidas: true })}</details>
      </section>
      <footer class="pie-lector">
        <a class="boton-secundario" href="${ficha.url}" target="_blank" rel="noopener noreferrer">Abrir el original ↗</a>
        ${ficha.tambien_en?.length ? html`<p class="meta">También publicado en:</p>
          <ul class="tambien">${ficha.tambien_en.map((u) => html`<li><a href="${u}" target="_blank" rel="noopener noreferrer">${dominio(u)}</a></li>`)}</ul>` : ""}
        <p class="meta">Texto de ${deLaBiblioteca ? "la biblioteca, guardado" : "la fuente, recolectado"} el ${fechaLarga(ficha.fecha_recoleccion)}.</p>
      </footer>
    </article>
  `);

  seguirAvance(ruta, avancesGuardados.get(ruta), leido, ficha.titulo);
  // Escuchar empieza en el párrafo que está arriba en la pantalla, o en el título si no ha bajado.
  paraEscuchar = () => {
    const bloques = [...contenido.querySelectorAll(".lector .cuerpo > *")];
    const tope = (document.querySelector(".cabecera")?.getBoundingClientRect().bottom || 0) + 8;
    const visible = bloques.findIndex((b) => b.getBoundingClientRect().bottom > tope);
    const cola = bloques.map((b, i) => ({ clave: String(i), titulo: ficha.titulo, partes: partir(b.textContent) }))
      .filter((item) => item.partes.length);
    const desde = Math.max(0, cola.findIndex((item) => Number(item.clave) >= visible));
    if (visible <= 0) cola.unshift({ clave: "titulo", titulo: ficha.titulo, partes: partir(`${ficha.titulo}.`) });
    escucharCola(cola, { titulo: "Lectura", desde: visible <= 0 ? 0 : desde,
      alEmpezar: (item) => resaltarSonando(item && (item.clave === "titulo" ? ".lector h1" : `.lector .cuerpo > :nth-child(${Number(item.clave) + 1})`)) });
  };
  const botonLeido = document.getElementById("leido");
  const marcarLeido = (valor) => {
    botonLeido.setAttribute("aria-pressed", String(valor));
    botonLeido.textContent = valor ? "✓ Leído" : "Lo leí";
  };
  botonLeido.addEventListener("click", () => {
    const valor = botonLeido.getAttribute("aria-pressed") !== "true";
    marcar({ tipo: "leido", archivo: ruta, valor });
    marcarLeido(valor);
    avisar(valor ? "Marcado como leído" : "Quitado de leídos");
  });
  for (const boton of contenido.querySelectorAll("[data-valor]")) {
    boton.addEventListener("click", () => {
      marcar({ tipo: "calificacion", archivo: ruta, pregunta, valor: boton.dataset.valor });
      for (const otro of contenido.querySelectorAll("[data-valor]")) otro.setAttribute("aria-pressed", String(otro === boton));
      marcarLeido(true);
      avisar(`Calificado: ${boton.textContent.toLowerCase()}`);
    });
  }
  // La misma nota no se guarda dos veces; si pide discutirla, también queda como pregunta en el Cuaderno.
  let notaGuardada = lectura.notas.get(ruta) || "";
  document.getElementById("guardar-nota").addEventListener("click", () => {
    const texto = document.getElementById("nota").value.trim();
    const discutir = document.getElementById("discutir");
    if (texto !== notaGuardada) marcar({ tipo: "nota", archivo: ruta, texto });
    if (discutir.checked && texto) {
      marcar({ tipo: "cuaderno", clase: "pregunta", texto, archivo: ruta, titulo: ficha.titulo, desde: "nota" });
      discutir.checked = false;
      avisar("Nota guardada. Quedó en el Cuaderno para discutirla");
    } else {
      avisar(texto === notaGuardada ? "La nota ya estaba guardada" : texto ? "Nota guardada" : "Nota borrada");
    }
    notaGuardada = texto;
  });
}

// ---------- Fuentes: el catálogo de Pedro, por tema y con su estado ----------

const TEMAS_DE_FUENTE = [...CATEGORIAS, "Varios temas"];
const ESTADOS = { resume: "Se resume", consulta: "Consulta", fuera: "Fuera" };
const estadoFuentes = { filtro: "todas", buscar: "", abiertos: new Set() };

// Cómo está hoy cada fuente: se resume, es de consulta, está fuera, espera algo o falla.
function situacionDeFuente(f, ajuste, falla, articulos) {
  if (f.estado === "fuera") {
    return { clase: "fuera", texto: ajuste.motivo === "inactiva" ? "Fuera: dejó de publicar" : "Fuera" };
  }
  if (f.estado === "consulta") return { clase: "consulta", texto: "De consulta: no se recolecta" };
  if (f.pendiente_de_aplicar) return { clase: "pendiente", texto: "Cambio tuyo: se aplica en la próxima recolección" };
  if (ajuste.pendiente) return { clase: "pendiente", texto: ajuste.pendiente };
  if (ajuste.espera) return { clase: "pendiente", texto: "Espera el vigilante de páginas" };
  if (falla) return { clase: "problema", texto: TIPOS_DE_FALLA[falla.tipo] || falla.tipo };
  return { clase: "resume", texto: articulos ? `Se resume · ${articulos} en la última recolección` : "Se resume" };
}

async function vistaFuentes(subvista) {
  if (subvista?.startsWith("tema/")) estadoFuentes.abiertos.add(subvista.slice(5)); // #/fuentes/tema/<tema>
  const [catalogo, agregadas, clasificacion, ajustes, { ultima, articulos }, consolidadas, marcas] = await Promise.all([
    leerJSON("catalogo/fuentes.json"),
    leerJSON("catalogo/fuentes_agregadas.json").catch(() => ({ fuentes: [] })),
    leerJSON("catalogo/clasificacion_fuentes.json").catch(() => ({ fuentes: {} })),
    leerJSON("catalogo/ajustes.json"),
    ultimaRecoleccion(),
    leerJSON("catalogo/reclasificaciones.json").catch(() => ({ fuentes: {} })),
    todasLasMarcas(),
  ]);
  const quien = await fichasDeFuentes();
  const fuentes = [...catalogo.fuentes, ...agregadas.fuentes];
  const fallas = new Map((await leerJSON(ultima.fallas)).corridas.at(-1).fallas.map((f) => [f.fuente_id, f]));
  const porFuente = new Map();
  for (const a of articulos) porFuente.set(a.fuente_id, (porFuente.get(a.fuente_id) || 0) + 1);

  // Los cambios de Pedro: los ya aplicados por el recolector y los recientes que
  // esperan la próxima recolección. Por cada campo manda el último.
  const cambios = new Map(Object.entries(consolidadas.fuentes).map(([id, c]) => [id, { ...c }]));
  const pendientes = new Set();
  for (const m of marcas) {
    if (m.tipo !== "fuente" || !["estado", "tema"].includes(m.campo)) continue;
    const actual = cambios.get(m.fuente_id) || {};
    if ((actual[`fecha_${m.campo}`] || "") < m.ts) {
      cambios.set(m.fuente_id, { ...actual, [m.campo]: m.valor, [`fecha_${m.campo}`]: m.ts });
      pendientes.add(m.fuente_id);
    }
  }
  for (const [id, c] of Object.entries(consolidadas.fuentes)) {
    const reciente = cambios.get(id);
    if (reciente.fecha_estado === c.fecha_estado && reciente.fecha_tema === c.fecha_tema) pendientes.delete(id);
  }

  const armar = (f) => {
    const base = clasificacion.fuentes[f.id] || { estado: f.recolectar ? "resume" : "consulta", tema: f.categoria_inicial || "Varios temas", tema_segun: "catálogo" };
    const cambio = cambios.get(f.id) || {};
    const ajuste = ajustes.fuentes[f.id] || {};
    const fuente = {
      ...f,
      estado: cambio.estado || base.estado,
      tema: cambio.tema || base.tema,
      tema_segun: cambio.tema ? "tú" : base.tema_segun,
      pendiente_de_aplicar: pendientes.has(f.id),
      enlace: ajuste.url || f.url,
    };
    fuente.situacion = situacionDeFuente(fuente, cambio.estado === "resume" ? {} : ajuste, fallas.get(f.id), porFuente.get(f.id));
    return fuente;
  };
  let lista = fuentes.map(armar);
  const cuenta = (filtro) => lista.filter((f) => coincideFiltro(f, filtro)).length;
  function coincideFiltro(f, filtro) {
    if (filtro === "todas") return true;
    if (filtro === "problema") return f.estado === "resume" && ["pendiente", "problema"].includes(f.situacion.clase);
    return f.estado === filtro;
  }

  const segun = (f) => f.tema_segun === "tú" ? "lo elegiste tú"
    : f.tema_segun?.startsWith("articulos") ? `según sus artículos ${f.tema_segun.replace("articulos ", "")}`
      : "según su descripción";

  const tarjeta = (f) => html`<li class="fuente">
    <a class="articulo-titulo" href="${f.enlace}" target="_blank" rel="noopener noreferrer">${f.nombre} ↗</a>
    ${f.autor_o_responsable && f.autor_o_responsable !== f.nombre ? html`<span class="meta">${f.autor_o_responsable}</span>` : ""}
    ${f.que_es ? html`<p class="por-que">${f.que_es}</p>` : ""}
    ${quienEstaDetras(quien[f.id], f.nombre)}
    ${f.nota_de_pedro ? html`<p class="nota-pedro"><strong>Tu nota:</strong> ${f.nota_de_pedro}</p>` : ""}
    <span class="estado-fuente estado-${f.situacion.clase}">${f.situacion.texto}</span>
    <div class="reclasificar">
      <label>Estado
        <select data-fuente="${f.id}" data-campo="estado">
          ${Object.entries(ESTADOS).map(([clave, nombre]) => html`<option value="${clave}" ${clave === f.estado ? "selected" : ""}>${nombre}</option>`)}
        </select>
      </label>
      <label>Tema
        <select data-fuente="${f.id}" data-campo="tema">
          ${TEMAS_DE_FUENTE.map((t) => html`<option value="${t}" ${t === f.tema ? "selected" : ""}>${t}</option>`)}
        </select>
      </label>
    </div>
    <span class="meta">Tema ${segun(f)}${f.subsector ? ` · sector: ${f.subsector}` : ""}${f.agregada ? " · agregada en Mentor" : ""}</span>
  </li>`;

  const dibujarLista = () => {
    const consulta = sinTildes(estadoFuentes.buscar);
    const elegidas = lista.filter((f) => coincideFiltro(f, estadoFuentes.filtro)
      && (!consulta || sinTildes(`${f.nombre} ${f.autor_o_responsable} ${f.que_es} ${(f.etiquetas || []).join(" ")}`).includes(consulta)));
    const grupos = agrupar(elegidas, (f) => f.tema);
    const temas = TEMAS_DE_FUENTE.filter((t) => grupos.has(t));
    pintar(html`
      <p class="meta">${numero(elegidas.length)} ${elegidas.length === 1 ? "fuente" : "fuentes"}</p>
      ${temas.map((tema) => html`<details class="grupo-fuentes" data-tema="${tema}" ${consulta || estadoFuentes.abiertos.has(tema) ? "open" : ""}>
        <summary>${tema} <span class="cuenta">${grupos.get(tema).length}</span></summary>
        <ul class="lista-fuentes">${grupos.get(tema).sort((a, b) => a.nombre.localeCompare(b.nombre, "es")).map(tarjeta)}</ul>
      </details>`)}
    `, document.getElementById("lista-fuentes"));
    for (const grupo of contenido.querySelectorAll("details.grupo-fuentes")) {
      grupo.addEventListener("toggle", () => {
        if (grupo.open) estadoFuentes.abiertos.add(grupo.dataset.tema);
        else estadoFuentes.abiertos.delete(grupo.dataset.tema);
      });
    }
  };

  pintar(html`
    <header class="encabezado-vista">
      <p class="sobretitulo">Tu biblioteca</p>
      <h1>Fuentes</h1>
      <p class="meta">Cada página por su tema: por qué vale la pena, si se resume y qué tal está funcionando. El tema de la fuente es una guía; en el resumen, cada artículo va al tema de su contenido.</p>
    </header>
    <div class="chips" role="group" aria-label="Filtrar por estado">
      ${[["todas", "Todas"], ["resume", "Se resumen"], ["problema", "Con pendiente o falla"], ["consulta", "De consulta"], ["fuera", "Fuera"]]
        .map(([clave, nombre]) => html`<button class="chip" type="button" data-filtro-fuente="${clave}" aria-pressed="${String(estadoFuentes.filtro === clave)}">${nombre} <span>${cuenta(clave)}</span></button>`)}
    </div>
    <label class="buscador"><span class="oculto">Buscar fuente</span>
      <input id="buscar-fuente" type="search" placeholder="Buscar por nombre, autor o tema" autocomplete="off" value="${estadoFuentes.buscar}">
    </label>
    <div id="lista-fuentes"></div>
  `);
  contenido.onclick = (evento) => {
    const chip = evento.target.closest("[data-filtro-fuente]");
    if (!chip) return;
    estadoFuentes.filtro = chip.dataset.filtroFuente;
    for (const otro of contenido.querySelectorAll("[data-filtro-fuente]")) otro.setAttribute("aria-pressed", String(otro === chip));
    dibujarLista();
  };
  document.getElementById("buscar-fuente").addEventListener("input", (evento) => {
    estadoFuentes.buscar = evento.target.value.trim();
    dibujarLista();
  });
  // Reclasificar: el cambio se guarda como marca y la lista se reagrupa al instante.
  contenido.onchange = (evento) => {
    const selector = evento.target.closest("select[data-fuente]");
    if (!selector) return;
    const id = selector.dataset.fuente;
    const campo = selector.dataset.campo;
    const actual = lista.find((f) => f.id === id);
    const marca = marcar({ tipo: "fuente", campo, fuente_id: id, valor: selector.value, anterior: actual[campo] });
    cambios.set(id, { ...(cambios.get(id) || {}), [campo]: selector.value, [`fecha_${campo}`]: marca.ts });
    pendientes.add(id);
    lista = fuentes.map(armar);
    if (campo === "tema") estadoFuentes.abiertos.add(selector.value);
    avisar(`${actual.nombre}: ${campo === "estado" ? ESTADOS[selector.value] : selector.value}`);
    dibujarLista();
  };
  dibujarLista();
}

// ---------- Para leer ----------

const ORDEN_MOMENTO = { "Este trimestre": 0, "Este año": 1, "Siguiente trimestre": 2, "Algún día": 3 };
const ACCESOS = { aqui: "Se lee aquí", libre: "Gratis en la web", pdf: "PDF gratis", pago: "De pago", libro: "Libro" };
const ACCIONES = { libre: "Leer en la web", pdf: "Abrir el PDF", pago: "Abrir el original", libro: "Ver el libro" };

// A dónde lleva cada lectura: al lector de Mentor si el texto ya está en la biblioteca;
// si no, al texto en la web o a la ficha del libro; en último caso, a la búsqueda del catálogo.
function destinoDeLectura(l, enlace, guardada) {
  if (guardada?.archivo) {
    return { href: `#/leer/${encodeURIComponent(guardada.archivo)}`, externo: false, acceso: "aqui", accion: "Leer aquí" };
  }
  if (enlace?.enlace && enlace.acceso in ACCIONES) {
    const acceso = enlace.acceso === "libre" && enlace.formato === "pdf" ? "pdf" : enlace.acceso;
    return { href: enlace.enlace, externo: true, acceso, accion: ACCIONES[acceso] };
  }
  return l.url ? { href: l.url, externo: true, acceso: null, accion: "Buscar en la web" } : null;
}

// ---------- La fuente de consulta del día (scripts/consulta.py) ----------

const DIAS_DE_CONSULTA = 7; // lo que no visitó en una semana se va; vuelve cuando le toque otra vez
const LECTURA_CONSULTA = {
  bloqueo: "Su sitio no deja entrar a programas", robots: "Su robots.txt no deja leerla", pago: "Es de pago",
  sin_pagina: "En el catálogo no tiene página propia", no_encontrado: "Su dirección no respondió",
  error_de_red: "Su sitio no respondió", error_del_sitio: "Su sitio dio un error",
};
const DECISION_CONSULTA = { consulta: "✓ Visitada", resume: "✓ Pasará a resumirse", fuera: "✓ Sale de tus fuentes" };

async function fuentesDeConsulta() {
  const [{ dias }, marcas] = await Promise.all([
    leerJSON("datos/consulta/rutina.json").catch(() => ({ dias: [] })), todasLasMarcas()]);
  const desde = new Date(Date.now() - (DIAS_DE_CONSULTA - 1) * 864e5).toISOString().slice(0, 10);
  const decidida = new Map();
  for (const m of marcas) if (m.tipo === "consulta_visitada") decidida.set(m.fuente_id, { valor: m.valor, ts: m.ts });
  return dias.filter((d) => d.fecha >= desde).reverse()
    .map((d) => ({ ...d, decision: decidida.get(d.fuente_id)?.ts.slice(0, 10) >= d.fecha ? decidida.get(d.fuente_id).valor : null }))
    .filter((d, i) => i === 0 || !d.decision);
}

function itemConsulta(d, i) {
  const busqueda = /google\.com\/search/.test(d.url || "");
  return html`<li><details class="noticia${d.decision ? " apagada" : ""}" ${i === 0 && !d.decision ? "open" : ""}>
    <summary>
      <span class="noticia-titulo">${d.nombre}</span>
      <span class="noticia-meta">${i === 0 ? "Hoy · " : ""}${d.tema}</span>
    </summary>
    <div class="noticia-cuerpo">
      ${d.por_que || d.que_es ? html`<p class="por-que">${d.por_que || d.que_es}</p>` : ""}
      ${d.como_usarla ? html`<p class="meta">${d.como_usarla}</p>` : ""}
      ${d.empezar ? html`<p class="empezar">Para empezar: <a href="${d.empezar.url}" target="_blank" rel="noopener noreferrer">${d.empezar.titulo} ↗</a>
        ${d.empezar.nota ? html`<span class="meta">${d.empezar.nota}</span>` : ""}</p>` : ""}
      ${d.lectura !== "abierta" ? html`<p class="meta">${LECTURA_CONSULTA[d.lectura] || "No se pudo leer su página"}: entra tú.</p>` : ""}
      <div class="acciones-lectura">
        ${d.url ? html`<a class="boton-secundario" href="${d.url}" target="_blank" rel="noopener noreferrer">${busqueda ? "Buscarla" : "Ir a la fuente"} ↗</a>` : ""}
        ${Object.entries({ consulta: "La visité", resume: "Que se resuma", fuera: "No me sirve" }).map(([estado, texto]) =>
          html`<button class="boton-secundario" type="button" data-consulta="${d.fuente_id}" data-estado="${estado}"
            aria-pressed="${String(d.decision === estado)}">${d.decision === estado ? DECISION_CONSULTA[estado] : texto}</button>`)}
      </div>
    </div>
  </details></li>`;
}

function insigniaAvance(avance) {
  return avance ? html`<span class="insignia insignia-acento">Vas en el ${porcentaje(avance)} %</span>` : "";
}

function itemLectura({ l, destino, guardada, leida, segundo, avance }) {
  const abrir = (clase, texto) => destino
    ? html`<a class="${clase}" href="${destino.href}"${destino.externo ? html` target="_blank" rel="noopener noreferrer"` : ""}>${texto}</a>`
    : html`<span class="${clase}">${texto}</span>`;
  const duracion = guardada?.minutos_lectura ? `${guardada.minutos_lectura} min` : l.horas_estimadas ? `${l.horas_estimadas} h` : "";
  return html`<li class="lectura">
    ${abrir("articulo-titulo", l.titulo)}
    <span class="meta">${[l.autor, duracion].filter(Boolean).join(" · ")}</span>
    <span class="insignias">${insigniaAvance(avance)}<span class="insignia">${l.momento_final}</span><span class="insignia">${l.hoja_origen}</span>${destino?.acceso ? html`<span class="insignia${destino.acceso === "aqui" ? " insignia-acento" : ""}">${ACCESOS[destino.acceso]}</span>` : ""}</span>
    ${l.por_que ? html`<p>${l.por_que}</p>` : ""}
    <div class="acciones-lectura">
      ${destino ? abrir("boton-secundario", `${destino.accion}${destino.externo ? " ↗" : ""}`) : ""}
      ${segundo ? html`<a class="boton-secundario" href="${segundo}" target="_blank" rel="noopener noreferrer">Otro texto ↗</a>` : ""}
      <button class="boton-secundario" type="button" data-leida="${l.id}" aria-pressed="${String(leida)}">${leida ? "✓ Leída" : "Lo leí"}</button>
    </div>
  </li>`;
}

async function vistaParaLeer() {
  const [{ lecturas }, { enlaces }, biblioteca, consolidado, lectura, guardadas, avance, deConsulta] = await Promise.all([
    leerJSON("catalogo/lecturas.json"),
    leerJSON("catalogo/lecturas_enlaces.json").catch(() => ({ enlaces: {} })),
    leerJSON("datos/biblioteca/indice.json").catch(() => ({})),
    leerJSON("datos/biblioteca/estado.json").catch(() => ({})),
    estadoDeLectura(),
    piezasGuardadas(),
    avances(),
    fuentesDeConsulta(),
  ]);
  // Leída si lo dice la biblioteca (que junta las marcas de cada noche) o una marca reciente.
  const leida = (l) => {
    const archivo = biblioteca[l.id]?.archivo;
    const reciente = [`lectura:${l.id}`, archivo].find((clave) => clave && lectura.marcadas.has(clave));
    return reciente ? lectura.leidos.has(reciente) : Boolean(consolidado[l.id]?.leida);
  };
  const conDestino = (l) => ({ l, destino: destinoDeLectura(l, enlaces[l.id], biblioteca[l.id]), guardada: biblioteca[l.id],
    segundo: enlaces[l.id]?.enlace_2, leida: false, avance: avance.get(biblioteca[l.id]?.archivo) });
  const enOrden = lecturas
    .filter((l) => l.momento_final !== "Ya leído" && !leida(l))
    .sort((a, b) => (ORDEN_MOMENTO[a.momento_final] ?? 9) - (ORDEN_MOMENTO[b.momento_final] ?? 9)
      || (a.horas_estimadas ?? 99) - (b.horas_estimadas ?? 99))
    .map(conDestino);
  // Las actividades de la hoja Recomendaciones (un grupo de lectura, un museo…) no son textos: van aparte.
  // Los cursos, las conferencias y los documentales están en Para ver.
  const pendientes = enOrden.filter(({ l }) => l.tipo !== "actividad" && !CLASES_PARA_VER.has(l.tipo));
  const paraHacer = enOrden.filter(({ l }) => l.tipo === "actividad");
  pintar(html`
    <header class="encabezado-vista">
      <p class="sobretitulo">${pendientes.length} lecturas en la cola</p>
      <h1>Para leer</h1>
    </header>
    ${deConsulta.length ? html`<section class="de-consulta">
      <h2>De tu consulta</h2>
      <p class="nota">Cada día, una de las fuentes que no se recolectan, para que no se queden guardadas.
        Visítala y decide: sigue en consulta, se resume o sale. Lo que no visites en una semana vuelve cuando le toque.</p>
      <ol class="relevante" id="de-consulta">${deConsulta.map(itemConsulta)}</ol>
    </section>` : ""}
    ${guardadas.size ? html`<section class="guardadas">
      <h2>Guardadas desde las noticias <span class="cuenta">${guardadas.size}</span></h2>
      <ul class="lista-lecturas" id="guardadas">${[...guardadas].reverse().map(([archivo, g]) => html`<li class="lectura">
        <a class="articulo-titulo" href="${enlaceLector({ archivo })}">${g.titulo}</a>
        <span class="meta">${[g.fuente, g.minutos ? `${g.minutos} min` : "", g.fecha ? `guardada el ${fechaCorta(g.fecha)}` : ""].filter(Boolean).join(" · ")}</span>
        ${avance.has(archivo) ? html`<span class="insignias">${insigniaAvance(avance.get(archivo))}</span>` : ""}
        <div class="acciones-lectura">
          <a class="boton-secundario" href="${enlaceLector({ archivo })}">Leer aquí</a>
          ${g.url ? html`<a class="boton-secundario" href="${g.url}" target="_blank" rel="noopener noreferrer">Original ↗</a>` : ""}
          ${botonGuardar(archivo, true)}
        </div>
      </li>`)}</ul>
    </section>` : ""}
    <p class="nota">Orden provisional: primero lo que marcaste para este trimestre y, dentro de cada momento, lo más corto.
      La prioridad con los cuatro criterios llega con la cola durable. Los cursos grabados, las conferencias y los
      documentales están en <a href="#/para-ver/cursos">Para ver</a>.</p>
    <label class="buscador">
      <span class="oculto">Buscar en la biblioteca</span>
      <input id="buscar" type="search" placeholder="Buscar por título, autor o tema" autocomplete="off">
    </label>
    <h2 id="titulo-lista">Las próximas 10</h2>
    <ul class="lista-lecturas" id="lista"></ul>
    ${paraHacer.length ? html`<section class="para-hacer">
      <h2>Para hacer <span class="cuenta">${paraHacer.length}</span></h2>
      <p class="nota">Lo de tu hoja de Recomendaciones que no es para leer, sino para hacer.</p>
      <ul class="lista-lecturas" id="para-hacer">${paraHacer.map(({ l }) => html`<li class="lectura">
        <span class="articulo-titulo">${l.titulo}</span>
        <span class="insignias"><span class="insignia">${l.momento_final}</span>${(l.etiquetas || []).map((t) => html`<span class="insignia">${t}</span>`)}</span>
        ${l.por_que ? html`<p>${l.por_que}</p>` : ""}
        <div class="acciones-lectura">
          <button class="boton-secundario" type="button" data-leida="${l.id}" aria-pressed="false">Lo hice</button>
        </div>
      </li>`)}</ul>
    </section>` : ""}
  `);
  const lista = document.getElementById("lista");
  const titulo = document.getElementById("titulo-lista");
  const buscar = document.getElementById("buscar");
  const dibujar = () => {
    const consulta = sinTildes(buscar.value.trim());
    if (!consulta) {
      titulo.textContent = "Las próximas 10";
      pintar(html`${pendientes.slice(0, 10).map(itemLectura)}`, lista);
      return;
    }
    const halladas = pendientes.filter(({ l }) =>
      sinTildes([l.titulo, l.autor, l.por_que, ...(l.etiquetas || [])].join(" ")).includes(consulta));
    titulo.textContent = halladas.length ? `${halladas.length} en la biblioteca` : "Nada con ese texto";
    pintar(html`${halladas.slice(0, 40).map(itemLectura)}`, lista);
  };
  buscar.addEventListener("input", dibujar);
  // La fuente de consulta del día: visitarla, pasarla a resumirse o sacarla (la misma marca de Fuentes).
  document.getElementById("de-consulta")?.addEventListener("click", (evento) => {
    const boton = evento.target.closest("[data-consulta]");
    if (!boton) return;
    const { consulta: fuente, estado } = boton.dataset;
    const botones = [...boton.parentElement.querySelectorAll("[data-consulta]")];
    const anterior = botones.find((b) => b.getAttribute("aria-pressed") === "true")?.dataset.estado || "consulta";
    marcar({ tipo: "consulta_visitada", fuente_id: fuente, valor: estado });
    if (estado !== anterior) marcar({ tipo: "fuente", campo: "estado", fuente_id: fuente, valor: estado, anterior });
    const textos = { consulta: "La visité", resume: "Que se resuma", fuera: "No me sirve" };
    for (const b of botones) {
      b.setAttribute("aria-pressed", String(b === boton));
      b.textContent = b === boton ? DECISION_CONSULTA[b.dataset.estado] : textos[b.dataset.estado];
    }
    boton.closest("details").classList.add("apagada");
    avisar({ consulta: "Sigue en consulta", resume: "Se resumirá desde la próxima recolección", fuera: "Sale de tus fuentes" }[estado]);
  });
  // Quitar una guardada la deja a la vista hasta la próxima visita, para poder deshacerlo.
  document.getElementById("guardadas")?.addEventListener("click", (evento) => {
    const boton = evento.target.closest("[data-guardar]");
    if (!boton) return;
    const g = guardadas.get(boton.dataset.guardar);
    const guardada = boton.getAttribute("aria-pressed") !== "true";
    marcar({ tipo: "guardar", archivo: boton.dataset.guardar, titulo: g.titulo, fuente: g.fuente, url: g.url, minutos: g.minutos, valor: guardada });
    boton.setAttribute("aria-pressed", String(guardada));
    boton.textContent = guardada ? "✓ En Para leer" : "Guardar en Para leer";
    avisar(guardada ? "Vuelve a Para leer" : "Quitada de Para leer");
  });
  // "Lo leí" (o "Lo hice") deja la lectura en su sitio hasta la próxima visita, para poder deshacerlo.
  const alMarcarLeida = (evento) => {
    const boton = evento.target.closest("[data-leida]");
    if (!boton) return;
    const p = enOrden.find(({ l }) => l.id === boton.dataset.leida);
    const actividad = p.l.tipo === "actividad";
    p.leida = !p.leida;
    marcar({ tipo: "leido", lectura: p.l.id, ...(p.guardada?.archivo ? { archivo: p.guardada.archivo } : {}), valor: p.leida });
    boton.setAttribute("aria-pressed", String(p.leida));
    boton.textContent = p.leida ? (actividad ? "✓ Hecho" : "✓ Leída") : (actividad ? "Lo hice" : "Lo leí");
    avisar(p.leida ? (actividad ? "Marcada como hecha" : "Marcada como leída: sale de la cola") : "Vuelve a la lista");
  };
  lista.addEventListener("click", alMarcarLeida);
  document.getElementById("para-hacer")?.addEventListener("click", alMarcarLeida);
  dibujar();
}

// ---------- Para ver: videos, cursos, conferencias y documentales ----------
// Lo propone Claude o lo agrega Pedro. Lo que Pedro pega llega al Cuaderno (clase "ver") y se ve
// aquí de una vez; Claude Code lo pasa a catalogo/para_ver.json con /cuaderno. Lo visto se marca
// como leído, igual que en Para leer, y se consolida cada noche en datos/biblioteca/estado.json.
// Los videos se ven con el reproductor de YouTube, que solo se carga al abrir cada uno.

const SUBPESTANAS_VER = [
  { slug: "videos", nombre: "Videos", clases: ["video"], invitacion: "Pega el enlace de un video de YouTube" },
  { slug: "cursos", nombre: "Cursos", clases: ["curso"], invitacion: "Pega el enlace de un curso" },
  { slug: "documentales", nombre: "Documentales y conferencias", clases: ["documental", "conferencia"],
    invitacion: "Pega el enlace de un documental o de una conferencia" },
];
const CLASES_PARA_VER = new Set(["curso", "documental", "conferencia"]);
const ACCION_VER = { video: "Ver en YouTube", curso: "Ir al curso", conferencia: "Ir a las conferencias", documental: "Dónde verlo" };
const TERMINAR_VER = { video: "Lo vi", curso: "Lo terminé", conferencia: "Las vi", documental: "Lo vi" };
const NIVELES_CANAL = { "Divulgacion alta": "Divulgación alta", Divulgacion: "Divulgación", Tecnico: "Técnico",
  Academico: "Académico", Oficio: "Oficio", "Académico": "Académico" };
const ID_YOUTUBE = /^[\w-]{6,64}$/;

// El video o la lista de un enlace de YouTube, para verlo aquí mismo.
function deYoutube(enlace) {
  try {
    const u = new URL(enlace);
    const sitio = u.hostname.replace(/^(www|m)\./, "");
    const [, tipo, id] = u.pathname.split("/");
    const video = sitio === "youtu.be" ? tipo
      : ["youtube.com", "youtube-nocookie.com"].includes(sitio)
        ? u.searchParams.get("v") || (["shorts", "embed", "live"].includes(tipo) ? id : null) : null;
    const lista = ["youtube.com", "youtube-nocookie.com"].includes(sitio) ? u.searchParams.get("list") : null;
    return { youtube: ID_YOUTUBE.test(video || "") ? video : null, youtube_lista: ID_YOUTUBE.test(lista || "") ? lista : null };
  } catch {
    return { youtube: null, youtube_lista: null };
  }
}

function sitioDe(enlace) {
  try {
    return new URL(enlace).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// El título y el canal de un video que Pedro acaba de pegar, mientras Claude completa la ficha.
async function datosDeYoutube(enlace) {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(enlace)}`);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

function duracionVer(item) {
  if (item.minutos) return item.minutos >= 90 ? `${String(Math.round(item.minutos / 6) / 10).replace(".", ",")} h` : `${item.minutos} min`;
  return item.horas_estimadas ? `${item.horas_estimadas} h` : "";
}

function itemParaVer(item, visto) {
  // "BBC · BBC Radio 4" o "Shoah · Claude Lanzmann (1985)": el autor ya está en la plataforma.
  const repetido = item.autor && item.plataforma && sinTildes(item.plataforma).includes(sinTildes(item.autor));
  const meta = [repetido ? "" : item.autor, item.plataforma, duracionVer(item)].filter(Boolean).join(" · ");
  const busqueda = /google\.com\/search/.test(item.url || "");
  return html`<li><details class="noticia${visto ? " apagada" : ""}" data-youtube="${item.youtube || ""}" data-lista="${item.youtube_lista || ""}">
    <summary>
      <span class="noticia-titulo">${item.titulo}</span>
      <span class="noticia-meta">${visto ? html`<span class="insignia insignia-vista">Ya ${item.clase === "conferencia" ? "las" : "lo"} viste</span>` : ""}${
        item.pendiente ? html`<span class="insignia insignia-actualizada">Lo agregaste</span>` : ""}${meta}</span>
    </summary>
    <div class="noticia-cuerpo">
      ${item.youtube || item.youtube_lista ? html`<div class="video-marco"></div>` : ""}
      ${item.por_que ? html`<p class="por-que">${item.por_que}</p>` : ""}
      ${item.pendiente ? html`<p class="pendiente">Claude le hace la ficha en la próxima sesión de Claude Code (/cuaderno).</p>` : ""}
      <div class="acciones-lectura">
        ${item.url ? html`<a class="boton-secundario" href="${item.url}" target="_blank" rel="noopener noreferrer">${busqueda ? "Buscar en la web" : ACCION_VER[item.clase]} ↗</a>` : ""}
        <button class="boton-secundario" type="button" data-visto="${item.id}" data-clase="${item.clase}" aria-pressed="${String(visto)}">${visto ? "✓ Visto" : TERMINAR_VER[item.clase]}</button>
      </div>
    </div>
  </details></li>`;
}

// Un canal de "Tus canales": de qué trata y por dónde entrar. La ficha la escribe Claude en para_ver.json.
function itemCanal(f, ficha) {
  const enlace = ficha.ruta ? `https://www.youtube.com/${ficha.ruta}` : f.url;
  const autor = f.autor_o_responsable && !["Anonimo", "Equipo", f.nombre].includes(f.autor_o_responsable) ? f.autor_o_responsable : "";
  const meta = [autor, NIVELES_CANAL[f.etiquetas[1]] || f.etiquetas[1], ficha.idioma].filter(Boolean).join(" · ");
  const empezar = ficha.empezar_youtube ? `https://www.youtube.com/watch?v=${ficha.empezar_youtube}`
    : ficha.empezar_lista ? `https://www.youtube.com/playlist?list=${ficha.empezar_lista}` : null;
  return html`<li>
    <a class="articulo-titulo" href="${enlace}" target="_blank" rel="noopener noreferrer">${f.nombre} ↗</a>
    ${meta ? html`<span class="meta">${meta}</span>` : ""}
    ${ficha.que_es ? html`<p>${ficha.que_es}</p>` : ""}
    ${ficha.empezar ? html`<p class="empezar">Para empezar: ${empezar
      ? html`<a href="${empezar}" target="_blank" rel="noopener noreferrer">${ficha.empezar}</a>` : ficha.empezar}</p>` : ""}
  </li>`;
}

// Al abrir un video se carga el reproductor; al cerrarlo se quita, para que no siga sonando.
function alAbrirVideo(evento) {
  const detalles = evento.target;
  const marco = detalles.querySelector?.(":scope > .noticia-cuerpo > .video-marco");
  if (!marco) return;
  if (!detalles.open) {
    marco.replaceChildren();
    return;
  }
  if (marco.firstChild) return;
  const { youtube, lista } = detalles.dataset;
  const iframe = document.createElement("iframe");
  iframe.src = ID_YOUTUBE.test(youtube) ? `https://www.youtube-nocookie.com/embed/${youtube}${ID_YOUTUBE.test(lista) ? `?list=${lista}` : ""}`
    : `https://www.youtube-nocookie.com/embed/videoseries?list=${lista}`;
  iframe.title = detalles.querySelector(".noticia-titulo").textContent;
  iframe.allow = "accelerometer; encrypted-media; gyroscope; picture-in-picture; web-share";
  iframe.allowFullscreen = true;
  // La página no manda referer a nadie; el reproductor de YouTube lo necesita para funcionar.
  iframe.referrerPolicy = "strict-origin-when-cross-origin";
  marco.append(iframe);
}

async function vistaParaVer(ruta) {
  const sub = SUBPESTANAS_VER.find((s) => s.slug === ruta) || SUBPESTANAS_VER[0];
  const enVideos = (ruta) => sub.slug === "videos" ? leerJSON(ruta).catch(() => null) : null;
  const [{ items, grupos_de_canales: grupos, canales: fichas = {} }, entradas, consolidado, lectura, fuentes, clasificacion, reclasificadas] = await Promise.all([
    leerJSON("catalogo/para_ver.json"),
    leerCuaderno().catch(() => []),
    leerJSON("datos/biblioteca/estado.json").catch(() => ({})),
    estadoDeLectura(),
    enVideos("catalogo/fuentes.json"),
    enVideos("catalogo/clasificacion_fuentes.json"),
    enVideos("catalogo/reclasificaciones.json"),
  ]);
  const visto = (id) => {
    const clave = `lectura:${id}`;
    return lectura.marcadas.has(clave) ? lectura.leidos.has(clave) : Boolean(consolidado[id]?.leida);
  };
  // Lo que Pedro agregó y Claude todavía no pasó al catálogo.
  const enCatalogo = new Set(items.flatMap((i) => [i.id, i.entrada]));
  const agregados = await Promise.all(entradas
    .filter((e) => e.clase === "ver" && !e.archivada && !enCatalogo.has(e.id))
    .reverse()
    .map(async (e) => {
      const para = SUBPESTANAS_VER.find((s) => s.slug === e.para) || SUBPESTANAS_VER[0];
      const yt = deYoutube(e.enlace);
      const datos = yt.youtube || yt.youtube_lista ? await datosDeYoutube(e.enlace) : null;
      return { id: e.id, clase: para.clases[0], titulo: datos?.title || e.enlace, autor: datos?.author_name,
        plataforma: yt.youtube || yt.youtube_lista ? "YouTube" : sitioDe(e.enlace),
        url: e.enlace, ...yt, por_que: e.texto !== e.enlace ? e.texto : "", pendiente: true };
    }));
  const todos = [...agregados, ...items];
  const deLa = (s) => todos.filter((i) => s.clases.includes(i.clase));
  const lista = deLa(sub);
  const ordenada = [...lista.filter((i) => !visto(i.id)), ...lista.filter((i) => visto(i.id))];
  // Todos los canales del catálogo, salvo los que Pedro saque desde Fuentes.
  const estadoDe = (f) => reclasificadas?.fuentes[f.id]?.estado || clasificacion?.fuentes[f.id]?.estado;
  const canales = fuentes ? fuentes.fuentes.filter((f) => f.hoja_origen === "Canales" && estadoDe(f) !== "fuera") : [];
  const grupoDe = new Map(Object.entries(grupos).flatMap(([g, etiquetas]) => etiquetas.map((e) => [e, g])));
  const deCadaGrupo = agrupar(canales, (f) => grupoDe.get(f.etiquetas[0]) || "Otros");
  const porGrupo = [...Object.keys(grupos), "Otros"].filter((g) => deCadaGrupo.has(g)).map((g) => [g, deCadaGrupo.get(g)]);

  pintar(html`
    <div class="encabezado-pestanas">
      <p class="sobretitulo">Videos, cursos y documentales</p>
      <nav class="pestanas" aria-label="Para ver">${SUBPESTANAS_VER.map((s) => html`<a href="#/para-ver/${s.slug}"
        aria-current="${s === sub ? "page" : "false"}">${s.nombre}<span class="cuenta">${deLa(s).filter((i) => !visto(i.id)).length}</span></a>`)}</nav>
    </div>
    <header class="encabezado-vista">
      <h1>${sub.nombre}</h1>
    </header>
    <form class="form-para-ver tarjeta">
      <input name="enlace" type="url" required placeholder="${sub.invitacion}" aria-label="${sub.invitacion}">
      <input name="nota" type="text" placeholder="Una nota (opcional)" aria-label="Una nota, por ejemplo por qué lo quieres ver">
      <button class="boton" type="submit">Agregar</button>
    </form>
    ${ordenada.length ? html`<ol class="relevante para-ver" id="para-ver">${ordenada.map((i) => itemParaVer(i, visto(i.id)))}</ol>`
      : html`<p class="nota">Todavía no hay nada aquí. Pega un enlace arriba y Claude le hace la ficha.</p>`}
    ${canales.length ? html`<section class="canales">
      <h2>Tus canales <span class="cuenta">${canales.length}</span></h2>
      <p class="nota">No son para verlos completos ni en orden: es un directorio para entrar cuando un tema te provoque.
        Cada uno dice de qué trata y por dónde empezar. Si un video te gusta, pega su enlace arriba y queda en tu lista.</p>
      ${porGrupo.map(([grupo, lista]) => html`<details class="mas">
        <summary>${grupo} (${lista.length})</summary>
        <ul class="lista-canales">${lista.map((f) => itemCanal(f, fichas[f.id] || {}))}</ul>
      </details>`)}
    </section>` : ""}
  `);

  document.getElementById("para-ver")?.addEventListener("toggle", alAbrirVideo, true);
  // "Lo vi" deja el video en su sitio hasta la próxima visita, para poder deshacerlo.
  document.getElementById("para-ver")?.addEventListener("click", (evento) => {
    const boton = evento.target.closest("[data-visto]");
    if (!boton) return;
    const ahora = boton.getAttribute("aria-pressed") !== "true";
    marcar({ tipo: "leido", lectura: boton.dataset.visto, valor: ahora });
    boton.setAttribute("aria-pressed", String(ahora));
    boton.textContent = ahora ? "✓ Visto" : TERMINAR_VER[boton.dataset.clase];
    avisar(ahora ? "Marcado como visto" : "Vuelve a la lista");
  });
  contenido.querySelector(".form-para-ver").addEventListener("submit", (evento) => {
    evento.preventDefault();
    const form = evento.target;
    const enlace = form.enlace.value.trim();
    const nota = form.nota.value.trim();
    if (!enlace) return;
    marcar({ tipo: "cuaderno", clase: "ver", texto: nota || enlace, enlace, para: sub.slug });
    avisar("Quedó en Para ver");
    vistaParaVer(sub.slug);
  });
}

// ---------- Radar ----------

async function vistaRadar() {
  const [radar, { articulos }] = await Promise.all([leerJSON("catalogo/radar_sectores.json"), ultimaRecoleccion()]);
  const porSector = agrupar(articulos.filter((a) => a.subsector), (a) => a.subsector);
  pintar(html`
    <header class="encabezado-vista">
      <p class="sobretitulo">Seis sectores</p>
      <h1>Radar</h1>
    </header>
    <p class="nota">El registro de señales empieza en la etapa del radar. Por ahora ves lo que trajeron hoy las fuentes de cada sector.</p>
    <details class="tarjeta">
      <summary>El filtro de las cuatro preguntas</summary>
      <ol>${radar.filtro_de_cuatro_preguntas.map((p) => html`<li>${p}</li>`)}</ol>
      <p class="meta">${radar.regla_del_filtro}</p>
    </details>
    ${radar.sectores.map((s) => {
      const hoy = porSector.get(s.nombre) || [];
      return html`<section class="tarjeta sector">
        <h2>${s.nombre} <span class="cuenta">${hoy.length} hoy</span></h2>
        <div class="insignias">${s.subtemas.map((t) => html`<span class="insignia">${t}</span>`)}</div>
        ${hoy.length ? html`<ul class="lista-articulos compacta">${hoy.slice(0, 5).map(itemArticulo)}</ul>` : html`<p class="meta">Sin artículos de sus fuentes en esta recolección.</p>`}
        <p class="meta">Desde la etapa del radar: ${s.consultas_es.length + s.consultas_en.length} búsquedas en Google Noticias${
          s.paginas_a_monitorear.length ? ` y ${s.paginas_a_monitorear.length === 1 ? "una página" : `${s.paginas_a_monitorear.length} páginas`} de reguladores` : ""}.</p>
      </section>`;
    })}
  `);
}

// ---------- Cuaderno: lo que Pedro le deja a Claude ----------
// Preguntas sobre una noticia o una pieza, palabras para el vocabulario y pedidos para Mentor.
// Llegan como marcas; Claude Code las responde en una sesión de Pedro (/cuaderno), sin gastar
// API, y las respuestas quedan en datos/cuaderno/respuestas.jsonl. Como las marcas se leen
// de los últimos días, cada noche se copia todo lo del cuaderno a datos/cuaderno/entradas.json.

const CLASES_CUADERNO = { pregunta: "Pregunta", palabra: "Palabra", frase: "Frase", pedido: "Pedido para Mentor" };
// Lo que es solo de Pedro (sus frases y lo que piensa de ellas): Claude no lo responde.
const PROPIAS_DE_PEDRO = new Set(["frase", "reflexion"]);
const ESTADOS_RESPUESTA = { hecho: "Hecho", en_curso: "En curso", descartado: "Descartado" };
const INVITACIONES = {
  pregunta: "Tu pregunta para Claude…",
  palabra: "La palabra o la frase…",
  pedido: "Qué quieres que cambie o se agregue en Mentor…",
  frase: "La frase que quieres guardar, de un libro o de donde sea…",
  reflexion: "Lo que te deja esta frase, o en qué te hace pensar…",
};
const PREGUNTAS_RAPIDAS = ["¿Qué implicaciones tiene?", "¿Qué significa para Colombia?", "¿Qué contexto me falta?",
  "¿Qué puede pasar ahora?"];

async function leerCuaderno() {
  const [copia, marcas, texto] = await Promise.all([
    leerJSON("datos/cuaderno/entradas.json").catch(() => ({ marcas: [] })), todasLasMarcas(),
    leerTexto("datos/cuaderno/respuestas.jsonl").catch(() => "")]);
  const respuestas = new Map();
  for (const linea of texto.split("\n")) {
    if (!linea.trim()) continue;
    try {
      const r = JSON.parse(linea);
      respuestas.set(r.entrada, [...(respuestas.get(r.entrada) || []), r]);
    } catch { /* línea dañada */ }
  }
  const delCuaderno = new Map([...copia.marcas, ...marcas.filter((m) => m.tipo?.startsWith("cuaderno") && m.id)]
    .map((m) => [m.id, m]));
  const todas = [...delCuaderno.values()].sort((a, b) => a.ts.localeCompare(b.ts));
  const archivadas = new Map(todas.filter((m) => m.tipo === "cuaderno_archivar").map((m) => [m.entrada, m.valor !== false]));
  return todas.filter((m) => m.tipo === "cuaderno")
    .map((m) => ({ ...m, respuestas: respuestas.get(m.id) || [], archivada: archivadas.get(m.id) || false }));
}

// Los hilos: cada entrada con las que siguieron la conversación, en orden.
function hilosDe(entradas) {
  const porId = new Map(entradas.map((e) => [e.id, e]));
  const raiz = (e) => (e.sigue && porId.has(e.sigue) ? raiz(porId.get(e.sigue)) : e);
  return [...agrupar(entradas, (e) => raiz(e).id).values()];
}

const pendienteHilo = (hilo) => !PROPIAS_DE_PEDRO.has(hilo.at(-1).clase) && !hilo.at(-1).respuestas.length;

// Las preguntas que ya se hicieron sobre cada historia, para mostrarlas al abrirla.
let hilosPorHistoria = new Map();
async function cargarHilosPorHistoria() {
  const hilos = hilosDe(await leerCuaderno().catch(() => []));
  hilosPorHistoria = agrupar(hilos.filter((h) => h[0].historia && !h[0].archivada), (h) => h[0].historia);
}

function formularioCuaderno({ clase = "pregunta", historia = "", archivo = "", titulo = "", sigue = "", rapidas = false, conClase = false } = {}) {
  return html`<form class="form-cuaderno" data-clase="${clase}" data-historia="${historia}" data-archivo="${archivo}"
      data-titulo="${titulo}" data-sigue="${sigue}">
    ${conClase ? html`<div class="clases-cuaderno" role="group" aria-label="Qué le dejas a Claude">${Object.entries(CLASES_CUADERNO)
      .map(([k, v]) => html`<button type="button" class="chip" data-clase-cuaderno="${k}" aria-pressed="${String(k === clase)}">${v}</button>`)}</div>` : ""}
    ${rapidas ? html`<div class="rapidas">${PREGUNTAS_RAPIDAS.map((p) => html`<button type="button" class="chip" data-rapida="${p}">${p}</button>`)}</div>` : ""}
    <textarea name="texto" rows="2" required placeholder="${INVITACIONES[clase]}"></textarea>
    ${conClase ? html`<input name="oracion" type="text" placeholder="La oración donde la viste (opcional)" hidden>` : ""}
    <button class="boton" type="submit">${PROPIAS_DE_PEDRO.has(clase) ? "Guardar" : "Dejar en el Cuaderno"}</button>
  </form>`;
}

function contextoDeHilo(e) {
  if (e.historia) return html`<p class="contexto-hilo">Sobre <a href="${enlaceHistoria(e.historia)}">${e.titulo || "la historia"}</a></p>`;
  if (e.archivo) return html`<p class="contexto-hilo">Sobre <a href="${enlaceLector(e)}">${e.titulo || "la pieza"}</a></p>`;
  return "";
}

function hilo(entradas, { conContexto = true, desde } = {}) {
  const [raiz] = entradas;
  return html`<article class="hilo${raiz.archivada ? " archivado" : ""}">
    ${conContexto ? contextoDeHilo(raiz) : ""}
    ${entradas.map((e) => html`<div class="turno turno-pedro">
        ${e.clase === "palabra" ? html`<p><strong>${e.texto}</strong>${e.oracion ? html` <span class="oracion">«${e.oracion}»</span>` : ""}</p>`
          : e.clase === "error" ? html`<p>Error en el texto: <strong>«${e.texto}»</strong>${e.oracion && e.oracion !== e.texto
            ? html` <span class="oracion">en «${e.oracion}»</span>` : ""}</p>`
          : e.clase === "ver" ? html`<p><a href="#/para-ver/${e.para || "videos"}">Para ver</a>: ${e.texto}${e.texto !== e.enlace
            ? html` · <a href="${e.enlace}" target="_blank" rel="noopener noreferrer">${sitioDe(e.enlace)} ↗</a>` : ""}</p>`
          : html`<p>${e.texto}</p>`}
        <span class="meta">${fechaLarga(e.ts, true)}</span>
      </div>
      ${e.respuestas.map((r) => html`<div class="turno turno-claude">
        <p class="sobretitulo">Claude${ESTADOS_RESPUESTA[r.estado] ? ` · ${ESTADOS_RESPUESTA[r.estado]}` : ""}${
          desde && despues(r.ts, desde) ? html` <span class="insignia insignia-nueva">Nueva</span>` : ""}</p>
        <div class="cuerpo">${seguro(markdownAHtml(r.texto))}</div>
      </div>`)}`)}
    ${pendienteHilo(entradas) ? html`<p class="pendiente">Por responder: Claude lo responde en la próxima sesión de Claude Code.</p>` : ""}
    <div class="acciones-hilo">
      <details class="seguir"><summary>Seguir la conversación</summary>${formularioCuaderno({ sigue: entradas.at(-1).id })}</details>
      <button class="boton-texto" type="button" data-archivar="${raiz.id}" data-valor="${String(!raiz.archivada)}">${raiz.archivada ? "Sacar del archivo" : "Archivar"}</button>
    </div>
  </article>`;
}

// Al final de cada noticia que se abre: lo que ya se preguntó y el formulario para preguntar.
function preguntarSobre(h) {
  const hilos = hilosPorHistoria.get(h.id) || [];
  return html`${hilos.map((x) => hilo(x, { conContexto: false }))}
    <details class="preguntar"><summary>Preguntarle a Claude</summary>
      ${formularioCuaderno({ historia: h.id, titulo: h.titulo, rapidas: true })}</details>`;
}

// Una frase guardada: el texto, de dónde salió (lleva al párrafo en el lector) y lo que Pedro pensó de ella.
function itemFrase([frase, ...siguientes]) {
  const reflexiones = siguientes.filter((e) => e.clase === "reflexion");
  return html`<article class="frase${frase.archivada ? " archivado" : ""}">
    <blockquote>${frase.texto}</blockquote>
    <p class="meta">${frase.archivo ? html`<a href="${enlaceLector(frase)}" data-ir-a="${frase.archivo}" data-parrafo="${frase.parrafo ?? ""}">${frase.titulo || "La lectura"}</a> · ` : ""}${fechaLarga(frase.ts, true)}</p>
    ${reflexiones.map((r) => html`<p class="reflexion">${r.texto}</p>`)}
    <div class="acciones-hilo">
      <details class="seguir"><summary>${reflexiones.length ? "Agregar otra reflexión" : "Agregar una reflexión"}</summary>
        ${formularioCuaderno({ clase: "reflexion", sigue: frase.id })}</details>
      <button class="boton-texto" type="button" data-archivar="${frase.id}" data-valor="${String(!frase.archivada)}">${frase.archivada ? "Sacar del archivo" : "Archivar"}</button>
    </div>
  </article>`;
}

async function vistaCuaderno() {
  const [entradas, { visitas }] = await Promise.all([leerCuaderno(), marcasV2()]);
  const desde = visitas.get("cuaderno");
  const todos = hilosDe(entradas).sort((a, b) => b.at(-1).ts.localeCompare(a.at(-1).ts));
  const frases = todos.filter((x) => x[0].clase === "frase" && !x[0].archivada);
  const hilos = todos.filter((x) => x[0].clase !== "frase" || x[0].archivada);
  const activos = hilos.filter((x) => !x[0].archivada);
  const pendientes = activos.filter(pendienteHilo);
  const respondidos = (clase) => activos.filter((x) => x[0].clase === clase && !pendienteHilo(x));
  const archivados = hilos.filter((x) => x[0].archivada);
  const seccion = (titulo, lista, vacio) => html`<section class="seccion-cuaderno">
    <h2>${titulo} <span class="cuenta">${lista.length}</span></h2>
    ${lista.length ? lista.map((x) => hilo(x, { desde })) : html`<p class="nota">${vacio}</p>`}
  </section>`;
  pintar(html`
    ${pestanasDeCuaderno("cuaderno")}
    <header class="encabezado-vista">
      <h1>Cuaderno</h1>
      <p class="meta">Lo que dejes aquí, en una noticia o en el lector, lo responde Claude en la próxima sesión de Claude Code
        (escribe <strong>/cuaderno</strong>). No gasta API y todo queda guardado.</p>
    </header>
    <section class="tarjeta">${formularioCuaderno({ conClase: true })}</section>
    ${pendientes.length ? seccion("Por responder", pendientes, "") : ""}
    <section class="seccion-cuaderno frases">
      <h2>Frases <span class="cuenta">${frases.length}</span></h2>
      ${frases.length ? frases.map(itemFrase)
        : html`<p class="nota">En el lector, selecciona una frase y toca "Guardar frase". Aquí queda con su lectura y lo que pienses de ella.</p>`}
    </section>
    ${seccion("Preguntas", respondidos("pregunta"), "Las preguntas que le hagas a Claude sobre una noticia aparecen aquí con su respuesta.")}
    ${seccion("Vocabulario", respondidos("palabra"), "En el lector, selecciona una palabra y toca \"Vocabulario\". El repaso diario llega cuando haya palabras.")}
    ${respondidos("error").length ? seccion("Errores en los textos", respondidos("error"), "") : ""}
    ${seccion("Pedidos para Mentor", respondidos("pedido"), "Lo que quieras cambiar o agregar en Mentor.")}
    ${archivados.length ? html`<details class="mas"><summary>Archivado (${archivados.length})</summary>
      ${archivados.map((x) => hilo(x))}</details>` : ""}
  `);
  marcarVisita("cuaderno");
}

const SUBPESTANAS_CUADERNO = [{ vista: "cuaderno", nombre: "Conversaciones" }, { vista: "repaso", nombre: "Repaso" }];

function pestanasDeCuaderno(activa) {
  return html`<div class="encabezado-pestanas">
    <p class="sobretitulo">Lo que conversamos y lo que aprendes</p>
    <nav class="pestanas" aria-label="Cuaderno">${SUBPESTANAS_CUADERNO.map((s) => html`<a href="#/${s.vista}"
      aria-current="${s.vista === activa ? "page" : "false"}">${s.nombre}</a>`)}</nav>
  </div>`;
}

// ---------- Repaso: el tutor ----------
// Preguntas sobre lo que Pedro leyó en la semana (el titular de una historia con un nombre
// tapado), su vocabulario con repeticiones espaciadas y una de sus frases. Lo arma la página con
// lo que ya está guardado; cada respuesta queda como marca, para que el repaso se espacie.

const QUE_FALTA = { persona: "Quién falta", organizacion: "Qué organización falta", empresa: "Qué empresa falta", lugar: "Qué lugar falta" };

async function vistaRepaso() {
  const [buscador, indice, entradas, marcas, { leidas }] = await Promise.all([indiceDelBuscador(), leerJSON("datos/v2/indice.json"),
    leerCuaderno().catch(() => []), todasLasMarcas(), marcasV2()]);
  const repasos = marcas.filter((m) => m.tipo === "repaso");
  const preguntas = buscador ? preguntasDeHistorias({ indice: buscador, leidas, fusionadas: indice.fusionadas,
    repasos: repasos.filter((r) => r.clase === "historia") }) : [];
  const nombres = Object.fromEntries(indice.paginas.map((t) => [t.pagina, t.nombre]));
  const palabras = estadoDePalabras(entradas.filter((e) => e.clase === "palabra" && !e.archivada && e.respuestas.length),
    repasos.filter((r) => r.clase === "palabra"));
  const tocan = palabras.filter((p) => p.toca).sort((a, b) => a.vuelve - b.vuelve);
  const proximas = palabras.filter((p) => !p.toca).map((p) => p.vuelve); // y las que se repasen ahora
  const frases = hilosDe(entradas).filter((x) => x[0].clase === "frase" && !x[0].archivada);
  const [frase, ...siguientes] = fraseDelDia(frases, diaDeHoy()) || [];
  pintar(html`
    ${pestanasDeCuaderno("repaso")}
    <header class="encabezado-vista">
      <h1>Repaso</h1>
      <p class="meta">Recordar con esfuerzo es lo que fija lo leído. Son un par de minutos: lo que falles vuelve al día
        siguiente y lo que aciertes se espacia. Todo sale de lo que leíste y guardaste, sin gastar API.</p>
    </header>
    <section class="seccion-repaso">
      <h2>Lo que leíste esta semana <span class="cuenta">${preguntas.length}</span></h2>
      <div id="preguntas"></div>
    </section>
    <section class="seccion-repaso">
      <h2>Vocabulario <span class="cuenta">${tocan.length ? `${tocan.length} para hoy` : palabras.length}</span></h2>
      <div id="palabras"></div>
    </section>
    ${frase ? html`<section class="seccion-repaso frases">
      <h2>Una de tus frases</h2>
      <article class="frase">
        <blockquote>${frase.texto}</blockquote>
        <p class="meta">${frase.archivo ? html`<a href="${enlaceLector(frase)}" data-ir-a="${frase.archivo}" data-parrafo="${frase.parrafo ?? ""}">${frase.titulo || "La lectura"}</a> · ` : ""}${fechaLarga(frase.ts)}</p>
        ${siguientes.filter((e) => e.clase === "reflexion").map((r) => html`<p class="reflexion">${r.texto}</p>`)}
      </article>
    </section>` : ""}
  `);

  // Una pregunta a la vez; al responder se ve si acertó y el titular completo.
  let k = 0;
  let aciertos = 0;
  const destinoPreguntas = document.getElementById("preguntas");
  const pintarPregunta = () => {
    if (!preguntas.length) {
      pintar(html`<p class="nota">${!buscador ? "Las preguntas aparecen después de la próxima recolección."
        : leidas.size ? "Ya repasaste todo lo que abriste esta semana. Mañana hay más."
          : "Abre algunas noticias en Hoy y vuelve: aquí te pregunto por ellas."}</p>`, destinoPreguntas);
      return;
    }
    if (k >= preguntas.length) {
      pintar(html`<div class="resultado-repaso">
        <p class="cifra-repaso">${aciertos} de ${preguntas.length}</p>
        <p>${aciertos === preguntas.length ? "Las recordaste todas." : "Las que fallaste vuelven mañana."}</p>
        <ul class="lista-compacta">${preguntas.map((p) => html`<li><a href="${enlaceHistoria(p.historia)}">
          <span class="articulo-titulo">${p.titular}</span><span class="meta">${nombres[p.hoja] || ""}</span></a></li>`)}</ul>
      </div>`, destinoPreguntas);
      return;
    }
    const p = preguntas[k];
    pintar(html`<div class="pregunta-repaso">
      <p class="meta">${k + 1} de ${preguntas.length} · ${nombres[p.hoja] || ""} · ${QUE_FALTA[p.tipo] || "Qué falta"}</p>
      <p class="titular-tapado">${p.antes}<span class="hueco">?</span>${p.despues}</p>
      <div class="opciones-repaso" role="group" aria-label="Opciones">${p.opciones.map((o, i) => html`<button
        type="button" class="opcion-repaso" data-opcion="${i}"><kbd>${i + 1}</kbd> ${o}</button>`)}</div>
      <div class="tras-responder" hidden></div>
    </div>`, destinoPreguntas);
  };
  const responder = (i) => {
    const p = preguntas[k];
    const caja = destinoPreguntas.querySelector(".pregunta-repaso");
    if (!caja || caja.dataset.respondida) return;
    caja.dataset.respondida = "1";
    const acierto = p.opciones[i] === p.respuesta;
    if (acierto) aciertos++;
    marcar({ tipo: "repaso", clase: "historia", historia: p.historia, respuesta: p.opciones[i], acierto });
    for (const boton of caja.querySelectorAll("[data-opcion]")) {
      const opcion = p.opciones[Number(boton.dataset.opcion)];
      boton.disabled = true;
      if (opcion === p.respuesta) boton.classList.add("correcta");
      else if (Number(boton.dataset.opcion) === i) boton.classList.add("incorrecta");
    }
    caja.querySelector(".hueco").textContent = p.respuesta;
    caja.querySelector(".hueco").classList.add(acierto ? "acertado" : "fallado");
    const tras = caja.querySelector(".tras-responder");
    pintar(html`<p>${acierto ? "Bien." : html`Era <strong>${p.respuesta}</strong>.`}
      <a href="${enlaceHistoria(p.historia)}">Volver a la historia →</a></p>
      <button class="boton" type="button" data-siguiente-pregunta>${k + 1 < preguntas.length ? "Siguiente" : "Ver cómo te fue"}</button>`, tras);
    tras.hidden = false;
    tras.querySelector("[data-siguiente-pregunta]").focus();
  };

  // Las palabras: primero se intenta recordar y después se ve lo que dijo Claude.
  const destinoPalabras = document.getElementById("palabras");
  const pintarPalabra = () => {
    const p = tocan[0];
    if (!p) {
      const proxima = proximas.length ? new Date(Math.min(...proximas)).toISOString() : null;
      pintar(html`<p class="nota">${palabras.length
        ? `Nada pendiente hoy.${proxima ? ` La próxima vuelve el ${fechaLarga(proxima)}.` : ""}`
        : "Cuando guardes palabras desde el lector (selecciona una y toca Vocabulario) y Claude las explique, aparecen aquí para repasarlas."}</p>`,
      destinoPalabras);
      return;
    }
    pintar(html`<div class="tarjeta-palabra">
      <p class="palabra">${p.texto}</p>
      ${p.oracion ? html`<p class="oracion">«${p.oracion}»</p>` : ""}
      <button class="boton-secundario" type="button" data-ver-significado>¿La recuerdas? Ver lo que dijo Claude</button>
      <div class="significado" hidden>
        <div class="cuerpo">${seguro(markdownAHtml(p.respuestas.at(-1).texto))}</div>
        <div class="opciones-repaso" role="group" aria-label="¿La recordabas?">
          <button type="button" class="opcion-repaso" data-recuerdo="no">No la recordaba</button>
          <button type="button" class="opcion-repaso" data-recuerdo="algo">Más o menos</button>
          <button type="button" class="opcion-repaso" data-recuerdo="si">La sabía</button>
        </div>
      </div>
    </div>`, destinoPalabras);
  };

  contenido.onclick = (evento) => {
    const opcion = evento.target.closest("[data-opcion]");
    if (opcion) responder(Number(opcion.dataset.opcion));
    if (evento.target.closest("[data-siguiente-pregunta]")) {
      k++;
      pintarPregunta();
      destinoPreguntas.querySelector("button")?.focus();
    }
    if (evento.target.closest("[data-ver-significado]")) {
      destinoPalabras.querySelector(".significado").hidden = false;
      evento.target.closest("[data-ver-significado]").remove();
    }
    const recuerdo = evento.target.closest("[data-recuerdo]");
    if (recuerdo) {
      const p = tocan.shift();
      marcar({ tipo: "repaso", clase: "palabra", entrada: p.id, resultado: recuerdo.dataset.recuerdo });
      proximas.push(Date.now() + INTERVALOS[siguienteCaja(p.caja, recuerdo.dataset.recuerdo)] * 864e5);
      avisar({ no: "Vuelve mañana", algo: "Vuelve pronto", si: "Se espacia más" }[recuerdo.dataset.recuerdo]);
      pintarPalabra();
    }
  };
  // Con el teclado: 1 a 4 para responder; Enter para seguir.
  teclasDeLaVista = (evento) => {
    const n = Number(evento.key);
    if (n >= 1 && n <= 4 && destinoPreguntas.querySelector(`[data-opcion="${n - 1}"]:not(:disabled)`)) {
      responder(n - 1);
      return true;
    }
    return false;
  };
  pintarPregunta();
  pintarPalabra();
}

// Un solo oyente para todos los formularios del cuaderno, estén en la vista que estén.
contenido.addEventListener("submit", (evento) => {
  const form = evento.target.closest(".form-cuaderno");
  if (!form) return;
  evento.preventDefault();
  const texto = form.texto.value.trim();
  if (!texto) return;
  const { clase, historia, archivo, titulo, sigue } = form.dataset;
  const oracion = clase === "palabra" ? form.oracion?.value.trim() : "";
  marcar({ tipo: "cuaderno", clase, texto, ...Object.fromEntries(
    Object.entries({ historia, archivo, titulo, sigue, oracion }).filter(([, v]) => v)) });
  form.reset();
  avisar("Quedó en el Cuaderno");
  if (location.hash.startsWith("#/cuaderno")) vistaCuaderno();
  else form.insertAdjacentHTML("beforebegin", '<p class="pendiente">Quedó en el Cuaderno. Claude lo responde en la próxima sesión de Claude Code.</p>');
});

contenido.addEventListener("click", (evento) => {
  const rapida = evento.target.closest("[data-rapida]");
  const clase = evento.target.closest("[data-clase-cuaderno]");
  const archivar = evento.target.closest("[data-archivar]");
  const irA = evento.target.closest("[data-ir-a]");
  if (irA?.dataset.parrafo) {
    try {
      localStorage.setItem(CLAVE_IR_A, JSON.stringify({ archivo: irA.dataset.irA, parrafo: Number(irA.dataset.parrafo), ts: Date.now() }));
    } catch { /* sin almacenamiento: abre al comienzo */ }
  }
  if (rapida) {
    const campo = rapida.closest("form").texto;
    campo.value = rapida.dataset.rapida;
    campo.focus();
  } else if (clase) {
    const form = clase.closest("form");
    form.dataset.clase = clase.dataset.claseCuaderno;
    for (const b of form.querySelectorAll("[data-clase-cuaderno]")) b.setAttribute("aria-pressed", String(b === clase));
    form.texto.placeholder = INVITACIONES[form.dataset.clase];
    if (form.oracion) form.oracion.hidden = form.dataset.clase !== "palabra";
  } else if (archivar) {
    const valor = archivar.dataset.valor === "true";
    marcar({ tipo: "cuaderno_archivar", entrada: archivar.dataset.archivar, valor });
    avisar(valor ? "Archivado" : "Salió del archivo");
    if (location.hash.startsWith("#/cuaderno")) vistaCuaderno();
    else archivar.closest(".hilo").remove();
  }
});

// En el lector, al seleccionar texto aparece un menú: guardar la palabra en el vocabulario,
// guardar la frase o señalar un error del texto. Todo se guarda ahí mismo, sin salir de la lectura.
const MAXIMO_DE_PALABRA = 80; // caracteres; más que eso ya no es una palabra ni una expresión
const MAXIMO_DE_FRASE = 1500;
const menuSeleccion = document.createElement("div");
menuSeleccion.className = "menu-seleccion";
menuSeleccion.hidden = true;
for (const [clase, texto] of [["palabra", "Vocabulario"], ["frase", "Guardar frase"], ["error", "Error en el texto"]]) {
  const boton = document.createElement("button");
  boton.type = "button";
  boton.dataset.guardarComo = clase;
  boton.textContent = texto;
  menuSeleccion.append(boton);
}
document.body.append(menuSeleccion);
let seleccion = null;

// La oración donde está lo seleccionado, para que Claude dé el significado en su contexto.
function oracionDe(rango, palabra) {
  const bloque = rango.startContainer.parentElement?.closest("p, li, blockquote, td");
  const texto = (bloque?.textContent || "").replace(/\s+/g, " ").trim();
  const i = texto.indexOf(palabra);
  if (i < 0) return texto.slice(0, 400);
  const inicio = Math.max(...[". ", "? ", "! "].map((s) => texto.lastIndexOf(s, i))) + 1;
  const finales = [". ", "? ", "! "].map((s) => texto.indexOf(s, i + palabra.length)).filter((n) => n >= 0);
  const fin = finales.length ? Math.min(...finales) + 1 : texto.length;
  return texto.slice(inicio, fin).trim().slice(0, 400);
}

document.addEventListener("selectionchange", () => {
  const sel = document.getSelection();
  const texto = sel?.toString().replace(/\s+/g, " ").trim() || "";
  const cuerpo = contenido.querySelector(".lector > .cuerpo");
  if (!cuerpo || !texto || texto.length > MAXIMO_DE_FRASE || !sel.rangeCount || !cuerpo.contains(sel.anchorNode)) {
    menuSeleccion.hidden = true;
    return;
  }
  const rango = sel.getRangeAt(0);
  const caja = rango.getBoundingClientRect();
  const bloque = [...cuerpo.children].findIndex((b) => b.contains(sel.anchorNode));
  seleccion = { texto, oracion: oracionDe(rango, texto), parrafo: bloque >= 0 ? bloque : undefined };
  menuSeleccion.querySelector('[data-guardar-como="palabra"]').hidden = texto.length > MAXIMO_DE_PALABRA;
  menuSeleccion.style.top = `${window.scrollY + caja.bottom + 10}px`;
  menuSeleccion.style.left = `${Math.max(8, Math.min(window.scrollX + caja.left, document.documentElement.clientWidth - 330))}px`;
  menuSeleccion.hidden = false;
});
menuSeleccion.addEventListener("pointerdown", (evento) => evento.preventDefault()); // que no se pierda la selección
menuSeleccion.addEventListener("click", (evento) => {
  const boton = evento.target.closest("[data-guardar-como]");
  const lector = contenido.querySelector(".lector");
  if (!boton || !seleccion || !lector) return;
  const clase = boton.dataset.guardarComo;
  const { archivo, titulo } = lector.dataset;
  marcar({ tipo: "cuaderno", clase, texto: seleccion.texto, archivo, titulo,
    ...(clase === "frase" ? { parrafo: seleccion.parrafo } : { oracion: seleccion.oracion }) });
  avisar({ palabra: `"${seleccion.texto}" quedó en tu vocabulario`, frase: "La frase quedó en tu Cuaderno",
    error: "Señalado: Claude lo corrige en tu copia con /cuaderno" }[clase]);
  document.getSelection().removeAllRanges();
  menuSeleccion.hidden = true;
});

// ---------- Estado ----------

const SUBPESTANAS_ESTADO = [{ slug: "", nombre: "El sistema" }, { slug: "gasto", nombre: "Gasto y piezas" }];

function pestanasDeEstado(activa) {
  return html`<div class="encabezado-pestanas">
    <p class="sobretitulo">Cómo va el sistema</p>
    <nav class="pestanas" aria-label="Estado">${SUBPESTANAS_ESTADO.map((s) => html`<a href="#/estado${s.slug ? `/${s.slug}` : ""}"
      aria-current="${s.slug === activa ? "page" : "false"}">${s.nombre}</a>`)}</nav>
  </div>`;
}

const usd = (n, decimales = 2) => n.toLocaleString("es-CO", { style: "currency", currency: "USD",
  minimumFractionDigits: decimales, maximumFractionDigits: decimales });
const MODELOS = { "claude-sonnet-5-5": "Sonnet", "claude-haiku-5-5": "Haiku" };
const MESES_CORTOS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

// Columnas de un solo color para los últimos días. La altura se pone después de pintar, porque
// la política de seguridad de la página no deja estilos escritos en el HTML. El valor del último
// día va escrito; los demás, al pasar el puntero o con el teclado, y en la tabla.
function columnas(dias, valor, formato, { referencia, etiqueta } = {}) {
  const tope = Math.max(...dias.map(valor), referencia || 0) || 1;
  return html`<div class="columnas">
    <div class="columnas-plot">
      ${referencia ? html`<div class="columnas-referencia" data-nivel="${(100 * referencia) / tope}"><span>${etiqueta}</span></div>` : ""}
      ${dias.map((d, i) => html`<div class="columna" tabindex="0" aria-label="${fechaCorta(d.fecha)}: ${formato(valor(d))}">
        <span class="columna-marca" data-alto="${(100 * valor(d)) / tope}">${i === dias.length - 1
          ? html`<span class="columna-valor">${formato(valor(d))}</span>` : ""}</span>
        <span class="columna-dato">${fechaCorta(d.fecha)}: <strong>${formato(valor(d))}</strong></span>
      </div>`)}
    </div>
    <div class="columnas-eje">${dias.map((d) => html`<span>${Number(d.fecha.slice(8, 10))}</span>`)}</div>
  </div>`;
}

const ORDEN_FUENTES = {
  piezas: { nombre: "Más piezas", clave: (f) => f.piezas },
  gasto: { nombre: "Más gasto", clave: (f) => f.costo_estimado_usd },
  saltar: { nombre: "Más descartadas", clave: (f) => partSaltada(f) ?? -1 },
};
const estadoGasto = { orden: "piezas", todas: false };

function partSaltada(f) {
  const conFicha = f.leer + f.resumen + f.saltar;
  return conFicha ? f.saltar / conFicha : null;
}

async function vistaGasto() {
  const datos = await leerJSON("datos/estadisticas/consumo.json").catch(() => null);
  if (!datos) {
    pintar(html`${pestanasDeEstado("gasto")}<header class="encabezado-vista"><h1>Gasto y piezas</h1></header>
      <p class="nota">Las cifras aparecen después de la próxima recolección.</p>`);
    return;
  }
  const { mes, tope_usd: tope } = datos;
  const dias = datos.dias.slice(-7);
  const alDia = tope / 30;
  const sePasa = mes.mes_completo_usd > tope;
  const totalPasos = datos.pasos.reduce((n, p) => n + p.usd, 0) || 1;
  const fila = (f) => {
    const saltada = partSaltada(f);
    return html`<tr><th scope="row">${f.nombre}</th><td>${numero(f.piezas)}</td><td>${f.dias_en_el_tope || ""}</td>
      <td>${saltada === null ? "—" : `${Math.round(100 * saltada)} %`}</td><td>${usd(f.costo_estimado_usd)}</td></tr>`;
  };
  const dibujarFuentes = () => {
    const { clave } = ORDEN_FUENTES[estadoGasto.orden];
    const lista = [...datos.fuentes].sort((a, b) => clave(b) - clave(a));
    pintar(html`<div class="tabla"><table class="tabla-cifras">
      <thead><tr><th scope="col">Fuente</th><th scope="col">Piezas</th><th scope="col">Días al tope</th>
        <th scope="col">Claude saltó</th><th scope="col">Gasto estimado</th></tr></thead>
      <tbody>${(estadoGasto.todas ? lista : lista.slice(0, 25)).map(fila)}</tbody></table></div>
      ${lista.length > 25 ? html`<button class="boton-texto" type="button" id="todas-las-fuentes">${estadoGasto.todas
        ? "Ver solo las primeras 25" : `Ver las ${lista.length}`}</button>` : ""}`, document.getElementById("fuentes-gasto"));
    document.getElementById("todas-las-fuentes")?.addEventListener("click", () => {
      estadoGasto.todas = !estadoGasto.todas;
      dibujarFuentes();
    });
  };
  pintar(html`
    ${pestanasDeEstado("gasto")}
    <header class="encabezado-vista">
      <h1>Gasto y piezas</h1>
      <p class="meta">Actualizado el ${fechaLarga(datos.generado)} a las ${hora(datos.generado)}, después de la recolección.</p>
    </header>
    <section class="tarjeta proyeccion">
      <p class="meta">Un mes completo a este ritmo</p>
      <p class="cifra-grande">${usd(mes.mes_completo_usd, 0)}</p>
      <p>${sePasa ? html`<span class="insignia insignia-aviso">⚠ Se pasa del tope</span> de ${usd(tope, 0)}: con este ritmo, Mentor dejaría
          de organizar hacia el día ${Math.max(1, Math.floor(tope / mes.promedio_diario_usd))} de cada mes.`
        : html`<span class="insignia">✓ Cabe en el tope</span> de ${usd(tope, 0)}.`}</p>
      <p class="meta">Promedio de ${usd(mes.promedio_diario_usd)} al día en los últimos ${mes.dias_del_promedio}
        ${mes.dias_del_promedio === 1 ? "día" : "días"} con el formato nuevo. Este mes van ${usd(mes.total_usd)} y cerraría en
        ${usd(mes.cierre_estimado_usd)}.</p>
      <progress class="gasto" max="${tope}" value="${Math.min(mes.total_usd, tope)}"></progress>
    </section>
    <section class="tarjeta">
      <h2>Gasto por día <span class="cuenta">${MESES_CORTOS[Number(dias.at(-1).fecha.slice(5, 7)) - 1]}</span></h2>
      ${columnas(dias, (d) => d.costo_usd, (n) => usd(n), { referencia: alDia, etiqueta: `Lo que cabe en el tope: ${usd(alDia)} al día` })}
    </section>
    <section class="tarjeta">
      <h2>Piezas por día <span class="cuenta">${MESES_CORTOS[Number(dias.at(-1).fecha.slice(5, 7)) - 1]}</span></h2>
      ${columnas(dias, (d) => d.piezas, (n) => numero(n))}
      <details class="mas"><summary>Ver los números</summary>
        <div class="tabla"><table class="tabla-cifras"><thead><tr><th scope="col">Día</th><th scope="col">Piezas</th>
          <th scope="col">Llamadas a Claude</th><th scope="col">Gasto</th></tr></thead>
          <tbody>${dias.map((d) => html`<tr><th scope="row">${fechaCorta(d.fecha)}${d.formato_nuevo ? "" : " ·"}</th>
            <td>${numero(d.piezas)}</td><td>${numero(d.llamadas)}</td><td>${usd(d.costo_usd)}</td></tr>`)}</tbody></table></div>
        <p class="meta">· Días del resumen anterior, antes del formato nuevo.</p>
      </details>
    </section>
    <section class="tarjeta">
      <h2>En qué se gasta</h2>
      <p class="meta">Los últimos días con el formato nuevo, por paso.</p>
      <ul class="pasos-gasto">${datos.pasos.map((p) => html`<li>
        <span class="paso-nombre">${p.paso}</span>
        <span class="meta">${p.modelos.map((m) => MODELOS[m] || m).join(" y ")} · ${numero(p.llamadas)} llamadas</span>
        <span class="paso-valor">${usd(p.usd)} <span class="meta">${Math.round((100 * p.usd) / totalPasos)} %</span></span>
        <span class="paso-barra"><span data-ancho="${(100 * p.usd) / totalPasos}"></span></span>
      </li>`)}</ul>
    </section>
    <section class="tarjeta">
      <h2>Fuentes</h2>
      <p class="meta">Los últimos 7 días. <strong>Días al tope:</strong> los días en que trajo el máximo de 30 piezas y quedó algo por fuera.
        <strong>Claude saltó:</strong> la parte de sus piezas que Claude marcó para saltar. <strong>Gasto estimado:</strong> lo que cuesta
        organizar cada día, repartido según las piezas de cada fuente (Claude cobra por llamada, no por fuente).</p>
      <div class="chips" role="group" aria-label="Ordenar fuentes">${Object.entries(ORDEN_FUENTES).map(([clave, o]) => html`<button
        class="chip" type="button" data-orden-gasto="${clave}" aria-pressed="${String(estadoGasto.orden === clave)}">${o.nombre}</button>`)}</div>
      <div id="fuentes-gasto"></div>
    </section>
  `);
  for (const el of contenido.querySelectorAll("[data-alto]")) el.style.height = `${el.dataset.alto}%`;
  for (const el of contenido.querySelectorAll("[data-nivel]")) el.style.bottom = `${el.dataset.nivel}%`;
  for (const el of contenido.querySelectorAll("[data-ancho]")) el.style.width = `${el.dataset.ancho}%`;
  dibujarFuentes();
  contenido.onclick = (evento) => {
    const chip = evento.target.closest("[data-orden-gasto]");
    if (!chip) return;
    estadoGasto.orden = chip.dataset.ordenGasto;
    for (const otro of contenido.querySelectorAll("[data-orden-gasto]")) otro.setAttribute("aria-pressed", String(otro === chip));
    dibujarFuentes();
  };
}

async function vistaEstado(sub) {
  if (sub === "gasto") {
    await vistaGasto();
    return;
  }
  const { ultima, indice, articulos } = await ultimaRecoleccion();
  const mes = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date()).slice(0, 7);
  const [registroFallas, feeds, costos] = await Promise.all([
    leerJSON(ultima.fallas), leerJSON("catalogo/feeds.json"), leerJSON(`datos/costos/${mes}.json`).catch(() => null),
  ]);
  const corrida = indice.corridas.at(-1);
  const fallas = registroFallas.corridas.at(-1).fallas;
  const porTipo = agrupar(fallas, (f) => f.tipo);
  const completos = articulos.filter((a) => a.extraccion === "completo").length;
  const minutos = Math.round((new Date(corrida.fin) - new Date(corrida.inicio)) / 60000);
  const conFeed = Object.values(feeds).filter((f) => f.feed).length;
  const { repo } = config();
  pintar(html`
    ${pestanasDeEstado("")}
    <header class="encabezado-vista">
      <h1>Estado</h1>
    </header>
    <section class="tarjeta">
      <h2>Última recolección</h2>
      <p class="meta">${fechaLarga(ultima.fecha)}, de ${hora(corrida.inicio)} a ${hora(corrida.fin)} (${minutos} min)</p>
      <dl class="cifras">
        <div><dt>Fuentes</dt><dd>${corrida.fuentes_procesadas}</dd></div>
        <div><dt>Con falla</dt><dd>${fallas.length}</dd></div>
        <div><dt>Artículos</dt><dd>${numero(articulos.length)}</dd></div>
        <div><dt>Completos</dt><dd>${Math.round((100 * completos) / Math.max(articulos.length, 1))}%</dd></div>
        <div><dt>Repetidos</dt><dd>${indice.corridas.reduce((n, c) => n + c.repetidos.length, 0)}</dd></div>
        <div><dt>Feeds conocidos</dt><dd>${conFeed}</dd></div>
      </dl>
    </section>
    <section class="tarjeta">
      <h2>Costos del mes</h2>
      ${costos
        ? html`<p><strong>${costos.total_usd.toLocaleString("es-CO", { style: "currency", currency: "USD" })}</strong>
            de ${(costos.tope_usd || 95).toLocaleString("es-CO", { style: "currency", currency: "USD" })} de créditos ·
            ${numero(costos.llamadas)} llamadas a Claude</p>
          <progress class="gasto" max="${costos.tope_usd || 95}" value="${costos.total_usd}"></progress>
          <p class="meta">Se paga con los créditos mensuales de tu plan Max. Si llega al tope, Claude deja de organizar las noticias y la recolección sigue.
            El detalle por día, por paso y por fuente está en <a href="#/estado/gasto">Gasto y piezas</a>.</p>`
        : html`<p>Sin consumo este mes.</p>`}
    </section>
    <section class="tarjeta">
      <h2>Fuentes con falla <span class="cuenta">${fallas.length}</span></h2>
      ${[...porTipo.entries()].sort((a, b) => b[1].length - a[1].length).map(([tipo, lista]) => html`
        <details>
          <summary>${TIPOS_DE_FALLA[tipo] || tipo} <span class="cuenta">${lista.length}</span></summary>
          <ul class="lista-fallas">${lista.map((f) => html`<li><strong>${f.nombre}</strong><span class="meta">${f.detalle}</span></li>`)}</ul>
        </details>`)}
    </section>
    <section class="tarjeta">
      <h2>Tus marcas</h2>
      ${(() => {
        const envio = estadoDeEnvio();
        if (envio.local) return html`<p class="meta">Modo local: las marcas se quedan en este navegador.</p>`;
        return html`<p class="meta">${envio.pendientes
          ? `${envio.pendientes} ${envio.pendientes === 1 ? "marca espera" : "marcas esperan"} en este navegador para guardarse en el repositorio.`
          : "Todo lo que marcaste está guardado en el repositorio."}</p>
          ${envio.error ? html`<p class="aviso">${envio.error}</p>
            <p class="meta">Para que se guarden, edita tu token en <a href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noopener noreferrer">github.com/settings/personal-access-tokens</a> y pon <strong>Contents</strong> en <em>Read and write</em>. El token sigue siendo el mismo.</p>` : ""}
          ${envio.pendientes ? html`<button class="boton-texto" type="button" id="enviar-marcas">Enviar ahora</button>` : ""}`;
      })()}
    </section>
    <section class="tarjeta">
      <h2>Conexión</h2>
      ${modoLocal()
        ? html`<p class="meta">Modo local: los datos salen de la carpeta del proyecto.</p>`
        : html`<p class="meta">Leyendo del repositorio ${repo} con tu token, guardado solo en este navegador.</p>
          <button class="boton-texto" type="button" id="desconectar">Desconectar este navegador</button>`}
    </section>
  `);
  document.getElementById("desconectar")?.addEventListener("click", () => {
    borrarConfig();
    location.hash = "#/conectar";
  });
  document.getElementById("enviar-marcas")?.addEventListener("click", async () => {
    await enviar();
    vistaEstado();
  });
}

// ---------- Conectar ----------

async function vistaConectar() {
  const { repo } = config();
  pintar(html`
    <header class="encabezado-vista">
      <p class="sobretitulo">Primera vez en este navegador</p>
      <h1>Conectar</h1>
    </header>
    <section class="tarjeta">
      <p>Tus datos viven en un repositorio privado. Esta página no los contiene: los lee con un token tuyo,
        que se guarda solo en este navegador.</p>
      <ol class="pasos">
        <li>Abre <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">github.com/settings/personal-access-tokens/new</a>.</li>
        <li>Nombre: <strong>Mentor lector</strong>. En <em>Repository access</em> elige <em>Only select repositories</em> y marca <strong>mentor</strong>.</li>
        <li>En <em>Permissions</em>, <em>Repository permissions</em>, pon <strong>Contents</strong> en <em>Read and write</em>: así se guarda lo que marcas.</li>
        <li>Genera el token, cópialo y pégalo aquí.</li>
      </ol>
      <form id="formulario" class="formulario">
        <label>Token<input id="token" type="password" autocomplete="off" spellcheck="false" placeholder="github_pat_…" required></label>
        <label>Repositorio<input id="repo" type="text" autocomplete="off" spellcheck="false" value="${repo || REPO_POR_DEFECTO}" required></label>
        <button class="boton" type="submit">Conectar</button>
        <p class="aviso oculto" id="error" role="alert"></p>
      </form>
    </section>
  `);
  document.getElementById("formulario").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const error = document.getElementById("error");
    const token = document.getElementById("token").value.trim();
    const repositorio = document.getElementById("repo").value.trim();
    if (!guardarConfig(token, repositorio)) {
      error.textContent = "Este navegador no permite guardar datos (¿ventana privada?).";
      error.classList.remove("oculto");
      return;
    }
    try {
      await leerJSON("datos/indice/ultima.json");
      location.hash = "#/hoy";
    } catch (e) {
      borrarConfig();
      error.textContent = e instanceof ErrorDeDatos && [401, 403, 404].includes(e.estado)
        ? "GitHub no aceptó el token para ese repositorio. Revisa que tenga acceso a mentor con permiso de Contents."
        : "No se pudo conectar con GitHub. Revisa tu conexión.";
      error.classList.remove("oculto");
    }
  });
}

// ---------- Navegación ----------

// ---------- Hoy, Geografía, Áreas y Sectores ----------
// Lee datos/v2/, que escribe scripts/organizar.py cada noche. Todas se leen como Hoy. "Lo
// nuevo" se calcula contra la última visita a cada subpestaña y la última vez que se abrió
// cada historia, que quedan como marcas.

const GRUPOS = { geografia: "Geografía", areas: "Áreas", sectores: "Sectores" };
const VISTA_DE_GRUPO = { "Geografía": "geografia", "Áreas": "areas", "Sectores": "sectores" };
const ESTADOS_HISTORIA = { nueva: "Nueva", actualizada: "Actualización", aldia: "Al día" };
const TIPOS_DE_ENTIDAD = { persona: "Persona", lugar: "Lugar", organizacion: "Organización", empresa: "Empresa", otro: "Nombre" };

const despues = (a, b) => !b || new Date(a) > new Date(b);
const masReciente = (a, b) => (!a ? b : !b ? a : new Date(a) > new Date(b) ? a : b);
const enlaceHistoria = (id) => `#/h/${encodeURIComponent(id)}`;
const enlacePagina = (pid) => `#/p/${encodeURIComponent(pid)}`;
const enlaceEntidad = (id) => `#/e/${encodeURIComponent(id)}`;
const fuentesTexto = (n) => (n === 1 ? "1 fuente" : `${n} fuentes`);
const noticiasTexto = (n) => (n === 1 ? "1 noticia" : `${n} noticias`);
// Igual que slug() en Python: así un nombre lleva a la página de su entidad.
const slugV2 = (texto) => (texto || "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 60).replace(/-+$/, "");

function fechaCorta(iso) {
  return new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "short", timeZone: "America/Bogota" })
    .format(new Date(`${iso.slice(0, 10)}T12:00:00-05:00`));
}

async function marcasV2() {
  const visitas = new Map();
  const leidas = new Map();
  for (const m of await todasLasMarcas()) {
    if (m.tipo === "visita" && m.pagina) visitas.set(m.pagina, m.ts);
    else if (m.tipo === "historia_leida" && m.historia) leidas.set(m.historia, m.ts);
  }
  return { visitas, leidas };
}

// ---------- Seguimiento: las historias que siguen vivas ----------
// Lo que el organizador dejó cada noche (datos/v2/seguimiento.json), más los botones Seguir y
// Soltar que Pedro tocó después.

let seguidasIds = new Set();

async function leerSeguimiento() {
  const datos = await leerJSON("datos/v2/seguimiento.json").catch(() => ({ historias: {}, archivadas: {}, plazos: {} }));
  const seguidas = new Map(Object.entries(datos.historias || {}));
  const pendientes = new Map(); // las que siguió después de la última corrida
  for (const m of await todasLasMarcas()) {
    if (m.tipo !== "seguir" || !m.historia || m.ts <= (datos.generado || "")) continue;
    if (m.valor === false) {
      seguidas.delete(m.historia);
      pendientes.delete(m.historia);
    } else if (seguidas.has(m.historia)) {
      seguidas.set(m.historia, { ...seguidas.get(m.historia), origen: "pedro" });
    } else {
      pendientes.set(m.historia, { origen: "pedro", desde: m.ts });
    }
  }
  seguidasIds = new Set([...seguidas.keys(), ...pendientes.keys()]);
  return { datos, seguidas, pendientes };
}

const botonSeguir = (id) => html`<button class="boton-secundario boton-seguir" type="button" data-seguir="${id}"
  aria-pressed="${String(seguidasIds.has(id))}">${seguidasIds.has(id) ? "✓ La sigues" : "Seguir"}</button>`;

// Seguir o soltar una historia, desde cualquier página.
contenido.addEventListener("click", (evento) => {
  const boton = evento.target.closest("[data-seguir]");
  if (!boton) return;
  const id = boton.dataset.seguir;
  const valor = boton.getAttribute("aria-pressed") !== "true";
  marcar({ tipo: "seguir", historia: id, valor });
  if (valor) seguidasIds.add(id); else seguidasIds.delete(id);
  for (const otro of contenido.querySelectorAll("[data-seguir]")) {
    if (otro.dataset.seguir !== id) continue;
    otro.setAttribute("aria-pressed", String(valor));
    otro.textContent = valor ? "✓ La sigues" : otro.dataset.soltar ? "Seguirla de nuevo" : "Seguir";
  }
  boton.closest(".seguida")?.classList.toggle("apagada", !valor);
  avisar(valor ? "Quedó en Seguimiento" : "Ya no la sigues");
});

// La línea de tiempo: cada novedad con su fecha y sus fuentes. Las historias anteriores al
// seguimiento no la traen y sale de su creación y de lo nuevo que tuvieron.
function movimientosDe(h) {
  if (h.movimientos?.length) return h.movimientos;
  const porDia = agrupar(h.piezas || [], (p) => (p.fecha || "").slice(0, 10));
  const fuentesDe = (fecha) => [...new Set((porDia.get(fecha) || []).map((p) => p.fuente))].sort();
  const creada = h.creada.slice(0, 10);
  return [{ fecha: creada, momento: h.creada, titular: h.titulo, fuentes: fuentesDe(creada) },
    ...h.actualizaciones.map((a) => ({ fecha: a.fecha, momento: a.momento, titular: a.textos[0] || h.titulo, fuentes: fuentesDe(a.fecha) }))];
}

function tarjetaSeguida(t, desde, paginas) {
  const nuevos = t.movimientos.filter((m) => desde && despues(m.momento, desde)).length;
  const origen = t.origen === "auto" ? `La sigue Mentor desde el ${fechaCorta(t.desde)}` : `La sigues desde el ${fechaCorta(t.desde)}`;
  return html`<article class="seguida${nuevos ? " con-novedad" : ""}">
    <a class="seguida-titulo" href="${enlaceHistoria(t.id)}">${t.titular || t.titulo}</a>
    <span class="meta">${[paginas[t.hoja]?.nombre, fuentesTexto(t.fuentes), origen].filter(Boolean).join(" · ")}${
      nuevos ? html` <span class="insignia insignia-actualizada">${nuevos === 1 ? "1 novedad" : `${nuevos} novedades`} desde tu visita</span>` : ""}</span>
    <ol class="linea-seguida">${t.movimientos.map((m) => html`<li class="${desde && despues(m.momento, desde) ? "nuevo" : ""}">
      <span class="fecha">${fechaCorta(m.fecha)}</span>
      <span>${m.titular}${m.fuentes?.length ? html` <span class="meta">· ${m.fuentes.join(", ")}</span>` : ""}</span>
    </li>`)}</ol>
    ${t.pendiente ? html`<p class="meta">La línea de tiempo completa llega con la próxima recolección.</p>` : ""}
    <div class="acciones-lectura"><button class="boton-secundario" type="button" data-seguir="${t.id}" data-soltar="1" aria-pressed="true">Soltar</button></div>
  </article>`;
}

async function vistaSeguimiento() {
  const [{ datos, seguidas, pendientes }, { visitas }, indice] = await Promise.all([
    leerSeguimiento(), marcasV2(), leerJSON("datos/v2/indice.json")]);
  const desde = visitas.get("seguimiento");
  const paginas = Object.fromEntries(indice.paginas.map((t) => [t.pagina, t]));
  // Las que siguió después de la última corrida se buscan en su página.
  const recientes = await Promise.all([...pendientes].map(async ([id, s]) => {
    const pid = indice.historias[id];
    const pagina = pid ? await leerJSON(`datos/v2/paginas/${pid}.json`).catch(() => null) : null;
    const h = pagina && [...pagina.hoy, ...pagina.semana].find((x) => x.id === id);
    return h && { ...h, ...s, id, fuentes: h.fuentes.length, movimientos: movimientosDe(h), pendiente: true };
  }));
  const tarjetas = [...seguidas.entries()].map(([id, t]) => ({ ...t, id }))
    .concat(recientes.filter(Boolean))
    .sort((a, b) => b.actualizada.localeCompare(a.actualizada));
  const archivadas = Object.entries(datos.archivadas || {}).sort((a, b) => b[1].cerrada.localeCompare(a[1].cerrada));
  const plazos = datos.plazos || {};
  pintar(html`
    <header class="encabezado-vista">
      <p class="sobretitulo">Las historias que siguen vivas</p>
      <h1>Seguimiento</h1>
      <p class="meta">Cada historia con su línea de tiempo; lo nuevo desde tu última visita va resaltado. Mentor sigue solo las
        ${plazos.primeras_de_hoy || 3} primeras de Hoy y las novedades muy importantes durante ${plazos.dias_automatico || 7} días.
        Una historia seguida se archiva tras ${plazos.dias_cierre || 14} días sin novedad${(plazos.importancia_para_volver || 1) > 1
          ? ", y solo vuelve a Hoy con una novedad importante." : ". Cuando tiene una novedad, puede quedar en Hoy como cualquier otra."}</p>
    </header>
    ${tarjetas.length ? html`<div class="seguidas">${tarjetas.map((t) => tarjetaSeguida(t, desde, paginas))}</div>`
      : html`<p class="nota">Todavía no sigues ninguna historia. Abre una noticia y toca "Seguir".</p>`}
    ${archivadas.length ? html`<details class="mas"><summary>Archivadas (${archivadas.length})</summary>
      <ul class="lista-compacta">${archivadas.map(([id, a]) => html`<li><a href="${enlaceHistoria(id)}">
        <span class="articulo-titulo">${a.titulo}</span><span class="meta">Sin novedad desde el ${fechaCorta(a.cerrada)}</span></a></li>`)}</ul>
    </details>` : ""}
  `);
  marcarVisita("seguimiento");
}

// Lo guardado desde "Para profundizar": lo que la biblioteca juntó cada noche, más las marcas recientes.
async function piezasGuardadas() {
  const guardadas = new Map(Object.entries(await leerJSON("datos/biblioteca/guardadas.json").catch(() => ({}))));
  for (const m of await todasLasMarcas()) {
    if (m.tipo !== "guardar" || !m.archivo) continue;
    if (m.valor === false) guardadas.delete(m.archivo);
    else guardadas.set(m.archivo, { titulo: m.titulo, fuente: m.fuente, url: m.url, minutos: m.minutos, fecha: m.ts });
  }
  return guardadas;
}

function estadoDeHistoria(h, visto) {
  if (!visto || despues(h.creada, visto)) return "nueva";
  return (h.cambios || h.actualizaciones.map((a) => a.momento)).some((m) => despues(m, visto)) ? "actualizada" : "aldia";
}

function resaltar(vista) {
  for (const enlace of document.querySelectorAll("[data-vista]")) {
    if (enlace.dataset.vista === vista) enlace.setAttribute("aria-current", "page");
    else enlace.removeAttribute("aria-current");
  }
}

// ---------- Los países: filtros por área e indicadores ----------

const AREAS_DE_PAIS = ["Política y justicia", "Economía y negocios", "Seguridad y orden público",
  "Sociedad: salud y educación", "Otras"];
const MINIMO_PARA_AREAS = 10; // historias del país en la semana para que tenga sentido partirlas
const areaDe = (h) => h.area || "Otras";
// Los países con tabla de indicadores (scripts/indicadores.py).
const INDICADORES_DE = { "pais-colombia": true, "pais-estados-unidos": true };

// Separador de miles siempre (también en 3.148) y dos decimales; nunca "6,3B".
function cifra(valor, unidad) {
  const n = valor.toLocaleString("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: "always" });
  return unidad === "%" ? `${n} %` : unidad ? `${n} ${unidad}` : n;
}

function tablaIndicadores(pais, visita, historias) {
  if (!pais?.indicadores?.length) return "";
  return html`<section class="indicadores">
    <h2>Indicadores</h2>
    <div class="tabla"><table class="tabla-cifras">
      <thead><tr><th scope="col">Indicador</th><th scope="col">Último</th><th scope="col">Anterior</th>
        <th scope="col">Fecha del dato</th><th scope="col">Fuente</th></tr></thead>
      <tbody>${pais.indicadores.map((i) => html`<tr>
        <th scope="row">${i.nombre}${visita && i.cambio_detectado && despues(i.cambio_detectado, visita)
          ? html` <span class="insignia insignia-actualizada">Cambió</span>` : ""}${i.historia && historias.has(i.historia)
          ? html`<a class="por-que-se-movio" href="${enlaceHistoria(i.historia)}">Por qué se movió →</a>` : ""}</th>
        <td>${cifra(i.valor, i.unidad)}</td>
        <td>${i.anterior === null ? "—" : cifra(i.anterior, i.unidad)}</td>
        <td>${i.periodo || fechaCorta(i.fecha)}</td>
        <td><a href="${i.enlace}" target="_blank" rel="noopener noreferrer">${i.fuente}</a></td>
      </tr>`)}</tbody></table></div>
    ${pais.fuera?.length ? html`<p class="meta">Sin fuente oficial gratuita, por ahora fuera: ${pais.fuera.map((f) => f.nombre).join(", ")}.</p>` : ""}
  </section>`;
}

// ---------- Geografía, Áreas y Sectores: subpestañas en el formato de Hoy ----------
// Cada subpestaña (una región, un área o un sector) abre como Hoy: lo relevante numerado, que no
// repite lo de Hoy, el resto de las noticias del día y para profundizar. Lo que ya está en Hoy y
// lo que ya abriste en otro lado van al final, apagados. Los países y las tecnologías son filtros.

async function vistaPestanas(clave, ruta) {
  const grupo = GRUPOS[clave];
  const [slugPestana, filtro, filtroArea] = (ruta || "").split("/");
  const indice = await leerJSON("datos/v2/indice.json");
  const pestanas = indice.pestanas.filter((p) => p.grupo === grupo);
  const elegida = pestanas.find((p) => p.slug === slugPestana) || pestanas[0];
  const [pestana, { visitas, leidas }, guardadas, , , indicadores] = await Promise.all([
    leerJSON(`datos/v2/pestanas/${elegida.pestana}.json`), marcasV2(), piezasGuardadas(), cargarHilosPorHistoria(), leerSeguimiento(),
    INDICADORES_DE[filtro] ? leerJSON("datos/indicadores/indicadores.json").catch(() => null) : null]);
  const paginas = Object.fromEntries(indice.paginas.map((t) => [t.pagina, t]));
  const varias = pestana.hojas.length > 1;
  const hoja = varias && pestana.hojas.includes(filtro) ? filtro : null;
  // Dentro de un país, filtros por área, solo si tiene suficientes historias en la semana.
  const delPais = hoja?.startsWith("pais-") ? [...pestana.hoy, ...pestana.semana].filter((h) => h.hoja === hoja) : [];
  const conAreas = delPais.length >= MINIMO_PARA_AREAS && new Set(delPais.map(areaDe)).size > 1;
  const area = conAreas ? AREAS_DE_PAIS.find((a) => slugV2(a) === filtroArea) : null;
  const deLaHoja = (x) => (!hoja || x.hoja === hoja) && (!area || areaDe(x) === area);

  const visita = masReciente(visitas.get(pestana.pestana), hoja && visitas.get(hoja));
  const visto = (h) => masReciente(leidas.get(h.id), visita);
  const enHoy = new Set(pestana.en_hoy);
  // Ya vista: está en Hoy, o la abriste y no ha tenido novedades desde entonces.
  const marca = (h) => (enHoy.has(h.id) ? "En Hoy"
    : leidas.has(h.id) && estadoDeHistoria(h, leidas.get(h.id)) === "aldia" ? "Ya la leíste" : null);
  // El país o la tecnología de cada noticia, cuando la subpestaña reúne varias, y en Sectores, de dónde viene.
  const pagina = (h) => (!hoja && (varias || !pestana.hojas.includes(h.hoja)) ? paginas[h.hoja] : undefined);

  const porId = new Map([...pestana.hoy, ...pestana.semana].map((h) => [h.id, h]));
  const relevante = pestana.relevante.map((r) => ({ ...r, h: porId.get(r.historia) })).filter((r) => r.h && deLaHoja(r.h));
  const enRelevante = new Set(relevante.map((r) => r.historia));
  const hoy = pestana.hoy.filter((h) => deLaHoja(h) && !enRelevante.has(h.id));
  const resto = [...hoy.filter((h) => !marca(h)), ...hoy.filter((h) => marca(h))];
  const semana = pestana.semana.filter(deLaHoja);
  const profundizar = pestana.profundizar.filter(deLaHoja);
  const pocoInteres = pestana.poco_interes.filter(deLaHoja);
  const cerradas = pestana.cerradas.filter(deLaHoja);
  const nombres = varias && !hoja ? Object.fromEntries(pestana.hojas.map((pid) => [pid, paginas[pid].nombre])) : null;
  const deOtroDia = pestana.fecha_relevante && pestana.fecha_relevante !== pestana.dia;
  const base = `#/${clave}/${pestana.slug}`;

  pintar(html`
    <div class="encabezado-pestanas">
      <p class="sobretitulo">${grupo} · ${fechaLarga(indice.dia)}</p>
      <nav class="pestanas" aria-label="${grupo}">${pestanas.map((p) => html`<a href="#/${clave}/${p.slug}"
        aria-current="${p.pestana === pestana.pestana ? "page" : "false"}">${p.nombre}<span class="cuenta">${p.hoy}</span></a>`)}</nav>
    </div>
    <div class="dos-columnas">
      <div class="principal">
        <header class="encabezado-vista">
          <div class="titulo-con-acciones"><h1>Lo relevante en ${hoja ? paginas[hoja].filtro || paginas[hoja].nombre : pestana.nombre}</h1>${
            relevante.length || resto.length ? botonEscuchar() : ""}</div>
          ${deOtroDia ? html`<p class="meta">Escrito el ${fechaLarga(pestana.fecha_relevante)}</p>` : ""}
        </header>
        ${varias ? html`<div class="filtros-pestana">
          <a class="chip" href="${base}" aria-current="${hoja ? "false" : "page"}">Todo</a>
          ${pestana.hojas.map((pid) => html`<a class="chip${paginas[pid].hoy ? "" : " sin-hoy"}" href="${base}/${pid}"
            aria-current="${pid === hoja ? "page" : "false"}">${paginas[pid].filtro || paginas[pid].nombre}${paginas[pid].hoy ? html`<span>${paginas[pid].hoy}</span>` : ""}</a>`)}
        </div>` : ""}
        ${conAreas ? html`<div class="filtros-pestana filtros-area" aria-label="Áreas de ${paginas[hoja].nombre}">
          <a class="chip" href="${base}/${hoja}" aria-current="${area ? "false" : "page"}">Todas</a>
          ${AREAS_DE_PAIS.map((a) => [a, delPais.filter((h) => areaDe(h) === a).length]).filter(([, n]) => n).map(([a, n]) => html`<a
            class="chip" href="${base}/${hoja}/${slugV2(a)}" aria-current="${a === area ? "page" : "false"}">${a}<span>${n}</span></a>`)}
        </div>` : ""}
        ${hoja && INDICADORES_DE[hoja] ? tablaIndicadores(indicadores?.paises?.[hoja], visitas.get(hoja), porId) : ""}
        ${relevante.length ? html`<ol class="relevante">${relevante.map((r) => html`<li>${noticia(r.h, visto(r.h),
          { titulo: r.texto, pagina: pagina(r.h), marca: marca(r.h) })}</li>`)}</ol>`
          : html`<p class="nota">${hoy.some((h) => enHoy.has(h.id)) ? "Lo más importante de aquí ya está en Hoy."
            : hoy.length ? "Hoy no se escribió lo relevante de aquí; abajo están todas las noticias." : "Hoy no hubo noticias aquí."}</p>`}
        ${resto.length ? html`<section>
          <h2>${relevante.length ? "Más noticias de hoy" : "Noticias de hoy"} <span class="cuenta">${resto.length}</span></h2>
          <div class="noticias">${resto.map((h) => noticia(h, visto(h), { pagina: pagina(h), marca: marca(h) }))}</div>
        </section>` : ""}
        ${semana.length ? html`<details class="mas"${pestana.hoy.some(deLaHoja) ? "" : " open"}>
          <summary>Antes en la semana (${semana.length})</summary>
          <div class="noticias">${semana.map((h) => noticia(h, visto(h), { pagina: pagina(h), conFecha: true, marca: marca(h) }))}</div>
        </details>` : ""}
        ${pocoInteres.length ? html`<details class="mas">
          <summary>De poco interés hoy (${pocoInteres.length})</summary>
          <ul class="lista-compacta">${pocoInteres.map((p) => html`<li><a href="${enlaceLector(p)}">
            <span class="articulo-titulo">${p.titulo}</span><span class="meta">${p.fuente}</span></a></li>`)}</ul>
        </details>` : ""}
        ${cerradas.length ? html`<details class="mas">
          <summary>Historias cerradas (${cerradas.length})</summary>
          <ul class="lista-compacta">${cerradas.map((h) => html`<li><a href="${enlaceHistoria(h.id)}">
            <span class="articulo-titulo">${h.titulo}</span><span class="meta">Última novedad: ${fechaCorta(h.actualizada)}</span></a></li>`)}</ul>
        </details>` : ""}
        ${grupo === "Sectores" ? html`<p class="nota pie-hoy">Cada sector reúne lo que lo toca, venga del país o del área que sea, y lo que traen las fuentes del radar.
          <a href="#/radar">El radar y sus fuentes →</a></p>` : ""}
      </div>
      ${columnaProfundizar(profundizar, guardadas, nombres)}
    </div>
  `);
  escucharNoticias(profundizar, guardadas);
  for (const h of [...pestana.hoy, ...pestana.semana]) historiasEnVista.set(h.id, h);
  // Lo relevante con su síntesis y, después, los titulares de lo demás que no ha visto.
  paraEscuchar = () => escucharHistorias([...relevante.map((r) => r.h), ...resto.filter((h) => !marca(h))],
    hoja ? paginas[hoja].filtro || paginas[hoja].nombre : pestana.nombre, relevante.length || 3);
  marcarVisita(hoja || pestana.pestana);
}

// ---------- Las noticias, que se abren ahí mismo ----------

function cuerpoNoticia(h, visto, pagina) {
  const nuevas = visto ? h.actualizaciones.filter((a) => despues(a.momento, visto)) : [];
  const piezas = [...h.piezas].sort((a, b) => ORDEN_RECOMENDACION[a.recomendacion] - ORDEN_RECOMENDACION[b.recomendacion]
    || b.relevancia - a.relevancia);
  return html`<div class="noticia-cuerpo">
    ${nuevas.length ? html`<div class="nuevo-desde"><p class="grupo">Nuevo desde tu visita</p>
      <ul>${nuevas.flatMap((a) => a.textos.map((t) => html`<li>${t}</li>`))}</ul></div>` : ""}
    <div class="cuerpo">${seguro(markdownAHtml(h.sintesis))}</div>
    ${h.que_sigue.length ? html`<p class="que-sigue-corto"><strong>Qué sigue:</strong> ${h.que_sigue.map((q) => `${q.cuando}: ${q.que}`).join(" · ")}</p>` : ""}
    <ul class="fuentes-noticia">${piezas.map((p) => html`<li><a href="${enlaceLector(p)}">${p.titulo}</a>
      <span class="meta">${p.fuente}${p.minutos ? ` · ${p.minutos} min` : ""}</span></li>`)}</ul>
    ${preguntarSobre(h)}
    <p class="enlaces-noticia">${botonSeguir(h.id)} <a href="${enlaceHistoria(h.id)}">Línea de tiempo, personas y conexiones →</a>${
      pagina ? html` <a href="${enlacePagina(pagina.pagina)}">Más de ${pagina.nombre} →</a>` : ""}</p>
  </div>`;
}

// Con marca ("En Hoy", "Ya la leíste"), la noticia sale apagada y señalada. El titular es el de
// la historia en todas las páginas: si tuvo una novedad, es lo nuevo, y debajo va lo de antes.
// En Hoy, lo que ya leyó lleva su número en suave.
function noticia(h, visto, { titulo, pagina, conFecha, marca, leida } = {}) {
  const estado = visto ? estadoDeHistoria(h, visto) : null;
  const meta = [fuentesTexto(h.fuentes.length), pagina?.nombre, conFecha ? fechaCorta(h.actualizada) : ""].filter(Boolean).join(" · ");
  return html`<details class="noticia${marca ? " apagada" : ""}${leida ? " leida" : ""}" data-historia="${h.id}">
    <summary>
      <span class="noticia-titulo">${h.titular || titulo || h.titulo}</span>
      ${h.antes ? html`<span class="noticia-antes">Antes: ${h.antes}</span>` : ""}
      <span class="noticia-meta">${marca ? html`<span class="insignia insignia-vista">${marca}</span>`
        : estado && estado !== "aldia" ? html`<span class="insignia insignia-${estado}">${ESTADOS_HISTORIA[estado]}</span>` : ""}${meta}</span>
    </summary>
    ${cuerpoNoticia(h, visto, pagina)}
  </details>`;
}

const botonGuardar = (archivo, guardada) => html`<button class="boton-secundario" type="button" data-guardar="${archivo}"
  aria-pressed="${String(guardada)}">${guardada ? "✓ En Para leer" : "Guardar en Para leer"}</button>`;

// Arriba puede ir algo propio de la vista, como "Desde tu última visita" en Hoy.
function columnaProfundizar(lista, guardadas, nombres, arriba = "") {
  return html`<aside class="lateral">
    ${arriba}
    <h2>Para profundizar</h2>
    <p class="meta">Solo por hoy. Si no te alcanza el tiempo, guárdalo en Para leer.</p>
    ${lista.length ? html`<ul class="lista-profundizar">${lista.map((l) => html`<li>
      <a class="enlace-sobrio" href="${enlaceLector(l)}"><span class="articulo-titulo">${l.titulo}</span></a>
      <span class="meta">${[l.fuente, l.minutos ? `${l.minutos} min` : "", nombres?.[l.hoja]].filter(Boolean).join(" · ")}</span>
      <p class="razon">${l.resumen}</p>
      <div class="acciones-lectura">
        ${botonGuardar(l.archivo, guardadas.has(l.archivo))}
        ${l.url ? html`<a class="boton-secundario" href="${l.url}" target="_blank" rel="noopener noreferrer">Original ↗</a>` : ""}
      </div>
    </li>`)}</ul>` : html`<p class="nota">Hoy no hay lecturas largas aquí.</p>`}
  </aside>`;
}

// Abrir una noticia cuenta como leerla; "Guardar en Para leer" deja la pieza en la cola.
function escucharNoticias(profundizar, guardadas) {
  contenido.onclick = (evento) => {
    const resumen = evento.target.closest("details.noticia > summary");
    if (resumen && !resumen.parentElement.open) marcar({ tipo: "historia_leida", historia: resumen.parentElement.dataset.historia });
    const boton = evento.target.closest("[data-guardar]");
    if (!boton) return;
    const l = profundizar.find((x) => x.archivo === boton.dataset.guardar);
    const guardada = boton.getAttribute("aria-pressed") !== "true";
    if (guardada) guardadas.set(l.archivo, l);
    else guardadas.delete(l.archivo);
    marcar({ tipo: "guardar", archivo: l.archivo, titulo: l.titulo, fuente: l.fuente, url: l.url, minutos: l.minutos, valor: guardada });
    boton.setAttribute("aria-pressed", String(guardada));
    boton.textContent = guardada ? "✓ En Para leer" : "Guardar en Para leer";
    avisar(guardada ? "Guardada en Para leer" : "Ya no está en Para leer");
  };
}

// ---------- Escuchar ----------
// Lo relevante, una historia o una lectura en voz alta (js/voz.js). Lo que suena se resalta si
// está en la pantalla, y una historia escuchada completa cuenta como leída.

const botonEscuchar = (texto = "Escuchar") => (puedeHablar() ? html`<button class="boton-secundario boton-escuchar" type="button"
  data-escuchar title="Escuchar (tecla e)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5l12 7-12 7z"/></svg>${texto}</button>` : "");

contenido.addEventListener("click", (evento) => {
  if (evento.target.closest("[data-escuchar]")) paraEscuchar?.();
});

// Si el navegador no puede hablar, se dice por qué en vez de quedarse callado.
function escucharCola(cola, opciones) {
  const pudo = escuchar(cola, { ...opciones, alFallar: (error) =>
    avisar(`Este navegador no pudo leer en voz alta (${error}). En Edge o Chrome hay voces en español.`) });
  if (!pudo) avisar("Este navegador no puede leer en voz alta.");
  return pudo;
}

function resaltarSonando(selector) {
  for (const el of document.querySelectorAll(".sonando")) el.classList.remove("sonando");
  const el = selector && contenido.querySelector(selector);
  if (!el) return;
  el.classList.add("sonando");
  const caja = el.getBoundingClientRect();
  if (caja.top < 90 || caja.bottom > window.innerHeight - 140) el.scrollIntoView({ block: "center", behavior: "smooth" });
}

// Los párrafos de un texto en Markdown, sin marcas, para leerlos en voz alta.
function parrafosDe(markdown) {
  const doc = new DOMParser().parseFromString(markdownAHtml(markdown || ""), "text/html");
  return [...doc.body.children].map((b) => b.textContent.replace(/\s+/g, " ").trim()).filter(Boolean);
}

const NUMEROS = ["Uno", "Dos", "Tres", "Cuatro", "Cinco", "Seis", "Siete", "Ocho", "Nueve", "Diez", "Once", "Doce"];

// Una historia para escuchar: su número en la lista, el titular y, si se pide, la síntesis.
function historiaParaEscuchar(h, numero, conSintesis = true) {
  const titular = h.titular || h.titulo;
  const intro = numero ? `${NUMEROS[numero - 1] || numero}. ` : "";
  return { clave: h.id, titulo: titular, partes: [...partir(`${intro}${titular}${/[.!?…]$/.test(titular) ? "" : "."}`),
    ...(conSintesis ? parrafosDe(h.sintesis).flatMap((p) => partir(p)) : [])] };
}

// Las primeras con su síntesis y el resto solo con el titular.
function escucharHistorias(historias, titulo, conSintesis = historias.length) {
  return escucharCola(historias.map((h, i) => historiaParaEscuchar(h, i + 1, i < conSintesis)), {
    titulo,
    alEmpezar: (item) => resaltarSonando(item && `details.noticia[data-historia="${CSS.escape(item.clave)}"]`),
    alTerminar: (item) => {
      marcar({ tipo: "historia_leida", historia: item.clave, via: "voz" });
      contenido.querySelector(`#relevante-hoy details.noticia[data-historia="${CSS.escape(item.clave)}"]`)?.classList.add("leida");
      pintarProgresoHoy();
    },
  });
}

// ---------- Los nombres llevan a su página ----------
// Dentro de la síntesis, la primera vez que aparece cada persona, organización o empresa de la
// historia es un enlace a su página: el grafo latente aparece al tocar un nombre.

// Dónde está un nombre, sin importar tildes (en los datos puede ir "Flavio" y en el texto
// "Flávio"), siempre que en el texto empiece con mayúscula: así no se enlaza una palabra común.
function posicionDeNombre(texto, nombre) {
  const lugar = dondeEsta(texto, nombre);
  return lugar && /\p{Lu}/u.test(texto[lugar[0]]) ? lugar : null;
}

function enlazarNombres(cuerpo, entidades = []) {
  if (!cuerpo) return;
  const pendientes = entidades.filter((e) => ["persona", "organizacion", "empresa"].includes(e.tipo) && e.nombre.length > 2);
  const caminante = document.createTreeWalker(cuerpo, NodeFilter.SHOW_TEXT);
  const nodos = [];
  while (caminante.nextNode()) if (!caminante.currentNode.parentElement.closest("a")) nodos.push(caminante.currentNode);
  for (let texto of nodos) {
    while (texto && pendientes.length) {
      // El nombre que aparece primero; si dos empiezan en el mismo sitio, el más largo.
      let mejor = null;
      for (const e of pendientes) {
        const lugar = posicionDeNombre(texto.data, e.nombre);
        if (lugar && (!mejor || lugar[0] < mejor.i || (lugar[0] === mejor.i && lugar[1] > mejor.fin))) mejor = { i: lugar[0], fin: lugar[1], e };
      }
      if (!mejor) break;
      const nombre = texto.splitText(mejor.i);
      texto = nombre.splitText(mejor.fin - mejor.i);
      const enlace = document.createElement("a");
      enlace.className = "entidad";
      enlace.href = enlaceEntidad(mejor.e.id);
      enlace.textContent = nombre.data;
      nombre.replaceWith(enlace);
      pendientes.splice(pendientes.indexOf(mejor.e), 1);
    }
  }
}

// Al abrir una noticia, sus nombres se vuelven enlaces.
contenido.addEventListener("toggle", (evento) => {
  const detalles = evento.target;
  if (!detalles.matches?.("details.noticia[data-historia]") || !detalles.open || detalles.dataset.enlazada) return;
  detalles.dataset.enlazada = "1";
  const h = historiasEnVista.get(detalles.dataset.historia);
  if (h) enlazarNombres(detalles.querySelector(":scope > .noticia-cuerpo > .cuerpo"), h.entidades);
}, true);

// ---------- Hoy ----------

const PALABRAS_POR_MINUTO = 220;

async function vistaHoyV2() {
  const [inicio, indice, { visitas, leidas }, guardadas, , , marcas] = await Promise.all([
    leerJSON("datos/v2/inicio.json"), leerJSON("datos/v2/indice.json"), marcasV2(), piezasGuardadas(), cargarHilosPorHistoria(),
    leerSeguimiento(), todasLasMarcas()]);
  const paginas = Object.fromEntries(indice.paginas.map((t) => [t.pagina, t]));
  const nombres = Object.fromEntries(indice.paginas.map((t) => [t.pagina, t.nombre]));
  const relevante = inicio.relevante;
  for (const r of relevante) historiasEnVista.set(r.historia, r.detalle);
  // Leída si la abrió después de su última novedad.
  const leida = (r) => leidas.has(r.historia) && !despues(r.detalle.actualizada, leidas.get(r.historia));
  const palabras = relevante.reduce((n, r) => n + `${r.detalle.titular || r.texto} ${r.detalle.sintesis || ""}`.split(/\s+/).length, 0);
  const desde = ultimaVisita(marcas);
  pintar(html`
    <div class="dos-columnas">
      <div class="principal">
        <header class="encabezado-vista">
          <p class="sobretitulo">${fechaLarga(inicio.dia)}</p>
          <div class="titulo-con-acciones"><h1>Lo relevante hoy</h1>${relevante.length ? botonEscuchar() : ""}</div>
          ${relevante.length ? html`<div class="progreso-hoy" id="progreso-hoy" data-minutos="${Math.max(1, Math.round(palabras / PALABRAS_POR_MINUTO))}">
            <p class="meta"></p><span class="barra-hoy"><span></span></span></div>` : ""}
        </header>
        ${relevante.length ? html`<ol class="relevante" id="relevante-hoy">${relevante.map((r) => html`<li>${noticia(r.detalle,
          masReciente(leidas.get(r.historia), visitas.get(r.detalle.hoja)), { titulo: r.texto, pagina: paginas[r.detalle.hoja], leida: leida(r) })}</li>`)}</ol>`
          : html`<p class="nota">Hoy no se escribió lo relevante. Las noticias están en Geografía, Áreas y Sectores.</p>`}
        <section class="nombres-del-dia" id="nombres-del-dia" hidden></section>
      </div>
      ${columnaProfundizar(inicio.profundizar, guardadas, nombres, html`<div id="al-dia"></div>`)}
    </div>
  `);
  escucharNoticias(inicio.profundizar, guardadas);
  pintarProgresoHoy();
  // Abrir una noticia (o escucharla completa) la cuenta como leída.
  document.getElementById("relevante-hoy")?.addEventListener("toggle", (evento) => {
    if (evento.target.matches?.("details.noticia") && evento.target.open) {
      evento.target.classList.add("leida");
      pintarProgresoHoy();
    }
  }, true);
  paraEscuchar = () => escucharHistorias(relevante.map((r) => r.detalle), "Lo relevante hoy");
  marcarVisita("hoy");
  // Lo que necesita más datos llega después, sin frenar lo relevante; si la vista se vuelve a
  // pintar mientras tanto, esto ya no va a ninguna parte.
  pintarAlDia(document.getElementById("al-dia"), desde, indice, marcas, leidas).catch((error) => console.error(error))
    .finally(() => tenerListasLasSecciones(indice, marcas));
  pintarNombresDelDia(document.getElementById("nombres-del-dia")).catch((error) => console.error(error));
}

// Las secciones que más visitas quedan en la copia desde que abres Hoy, para que abran al
// instante también la primera vez del día. Con el ahorro de datos del celular, no.
const SECCIONES_LISTAS = 3;

function tenerListasLasSecciones(indice, marcas) {
  if (navigator.connection?.saveData) return;
  const pestanaDe = new Map(indice.pestanas.flatMap((p) => [[p.pestana, p], ...p.hojas.map((h) => [h, p])]));
  const veces = new Map();
  for (const m of marcas) {
    const p = m.tipo === "visita" && pestanaDe.get(m.pagina);
    if (p) veces.set(p.pestana, (veces.get(p.pestana) || 0) + 1);
  }
  for (const [pestana] of [...veces].sort((a, b) => b[1] - a[1]).slice(0, SECCIONES_LISTAS)) {
    tenerListo(`datos/v2/pestanas/${pestana}.json`).catch(() => {});
  }
}

// Cuántas lleva de lo relevante de hoy y cuánto le falta.
function pintarProgresoHoy() {
  const progreso = document.getElementById("progreso-hoy");
  if (!progreso) return;
  const todas = contenido.querySelectorAll("#relevante-hoy details.noticia");
  const leidas = contenido.querySelectorAll("#relevante-hoy details.noticia.leida").length;
  const minutos = Number(progreso.dataset.minutos);
  progreso.querySelector(".meta").textContent = [`${todas.length} ${todas.length === 1 ? "historia" : "historias"}`,
    `unos ${minutos} min de lectura`, leidas === todas.length ? "ya las leíste todas" : leidas ? `llevas ${leidas}` : ""].filter(Boolean).join(" · ");
  progreso.querySelector(".barra-hoy > span").style.width = `${(100 * leidas) / Math.max(1, todas.length)}%`;
}

// ---------- Desde tu última visita ----------
// Lo que cambió desde la última vez que Pedro abrió Hoy: lo que sigue, las respuestas de Claude,
// los indicadores, la lectura que dejó a medias, el repaso y lo nuevo en las secciones que más
// visita. "La última vez" es la de hace más de una hora, para que no se vacíe al volver de leer.

const UNA_HORA = 36e5;
const MAXIMO_DE_SECCIONES = 6;

function ultimaVisita(marcas) {
  const antes = Date.now() - UNA_HORA;
  const previas = marcas.filter((m) => m.origen !== "claude" && Date.parse(m.ts) < antes);
  return (previas.filter((m) => m.tipo === "visita" && m.pagina === "hoy").at(-1) || previas.at(-1))?.ts || null;
}

function cuandoFue(iso) {
  const dias = Math.round((Date.parse(`${diaDeHoy()}T12:00:00-05:00`) - Date.parse(`${diaEnBogota(iso)}T12:00:00-05:00`)) / 864e5);
  const dia = dias === 0 ? "hoy" : dias === 1 ? "ayer" : new Intl.DateTimeFormat("es-CO", { weekday: "long", timeZone: "America/Bogota" }).format(new Date(iso));
  return `${dia === "hoy" || dia === "ayer" ? dia : `el ${dia}`} a las ${hora(iso)}`;
}

// El título de una lectura a medias: lo guarda la marca de avance; en las anteriores, se busca.
async function tituloDeLectura(archivo, avance) {
  if (avance.titulo) return avance.titulo;
  if (archivo.startsWith("datos/biblioteca/")) {
    const [biblioteca, { lecturas }] = await Promise.all([leerJSON("datos/biblioteca/indice.json"), leerJSON("catalogo/lecturas.json")]);
    const id = Object.keys(biblioteca).find((k) => biblioteca[k].archivo === archivo);
    return lecturas.find((l) => l.id === id)?.titulo || null;
  }
  return separarFicha(await leerTexto(archivo)).ficha.titulo || null;
}

// Cuántas historias nuevas o con novedades hay en cada subpestaña desde que Pedro la visitó.
function novedadesPorSeccion(indice, marcas, desde) {
  const pestanaDe = new Map(indice.pestanas.flatMap((p) => [[p.pestana, p], ...p.hojas.map((h) => [h, p])]));
  const veces = new Map();
  const visita = new Map();
  for (const m of marcas) {
    const p = m.tipo === "visita" && pestanaDe.get(m.pagina);
    if (!p) continue;
    veces.set(p.pestana, (veces.get(p.pestana) || 0) + 1);
    if (!m.origen || m.origen === "pedro") visita.set(p.pestana, masReciente(visita.get(p.pestana), m.ts));
  }
  const paginas = new Map(indice.paginas.map((t) => [t.pagina, t]));
  return indice.pestanas.map((p) => {
    const vista = visita.get(p.pestana) || desde;
    const ids = new Set();
    for (const hoja of p.hojas) {
      for (const h of paginas.get(hoja)?.historias || []) {
        if (!vista || despues(h.creada, vista) || h.cambios.some((c) => despues(c, vista))) ids.add(h.id);
      }
    }
    return { p, nuevas: ids.size, veces: veces.get(p.pestana) || 0 };
  }).filter((s) => s.nuevas).sort((a, b) => b.veces - a.veces || b.nuevas - a.nuevas).slice(0, MAXIMO_DE_SECCIONES);
}

async function pintarAlDia(destino, desde, indice, marcas, leidas) {
  const [{ seguidas }, cuaderno, indicadores, avance, consulta, buscador] = await Promise.all([leerSeguimiento(),
    leerCuaderno().catch(() => []), leerJSON("datos/indicadores/indicadores.json").catch(() => null), avances(),
    fuentesDeConsulta().catch(() => []), indiceDelBuscador()]);
  if (!destino?.isConnected) return; // ya se fue de Hoy, o Hoy se volvió a pintar
  const nuevo = (iso) => desde && despues(iso, desde);
  const deLoQueSigue = [...seguidas.entries()].flatMap(([id, t]) => (t.movimientos || []).filter((m) => nuevo(m.momento))
    .map((m) => ({ id, titular: m.titular, momento: m.momento }))).sort((a, b) => b.momento.localeCompare(a.momento));
  const respondidas = cuaderno.filter((e) => e.respuestas.some((r) => nuevo(r.ts)));
  const cambiaron = Object.entries(indicadores?.paises || {}).flatMap(([pid, p]) => (p.indicadores || [])
    .filter((i) => i.cambio_detectado && nuevo(i.cambio_detectado)).map((i) => ({ pid, i })));
  const [archivo, aMedias] = [...avance].filter(([, a]) => a.parrafo >= 2 && a.parrafo < (a.total || 0) - 2
    && Date.now() - Date.parse(a.fecha) < 7 * 864e5).sort((a, b) => b[1].fecha.localeCompare(a[1].fecha))[0] || [];
  const tituloAMedias = archivo ? await tituloDeLectura(archivo, aMedias).catch(() => null) : null;
  const repasos = marcas.filter((m) => m.tipo === "repaso");
  const preguntas = buscador ? preguntasDeHistorias({ indice: buscador, leidas, fusionadas: indice.fusionadas,
    repasos: repasos.filter((r) => r.clase === "historia") }).length : 0;
  const palabras = estadoDePalabras(cuaderno.filter((e) => e.clase === "palabra" && !e.archivada && e.respuestas.length),
    repasos.filter((r) => r.clase === "palabra")).filter((p) => p.toca).length;
  const deHoy = consulta[0]?.fecha === diaDeHoy() && !consulta[0].decision ? consulta[0] : null;
  const secciones = novedadesPorSeccion(indice, marcas, desde);
  const paginas = Object.fromEntries(indice.paginas.map((t) => [t.pagina, t]));

  const resumen = [deLoQueSigue.length && `${deLoQueSigue.length} ${deLoQueSigue.length === 1 ? "novedad" : "novedades"} en lo que sigues`,
    respondidas.length && `${respondidas.length} ${respondidas.length === 1 ? "respuesta" : "respuestas"} de Claude`,
    cambiaron.length && `${cambiaron.length} ${cambiaron.length === 1 ? "indicador cambió" : "indicadores cambiaron"}`,
    preguntas + palabras && "repaso listo"].filter(Boolean);
  if (!resumen.length && !secciones.length && !tituloAMedias && !deHoy) return;
  pintar(html`<details class="al-dia"${deLoQueSigue.length || respondidas.length || cambiaron.length ? " open" : ""}>
    <summary>
      <span class="al-dia-titulo">${desde ? `Desde tu última visita, ${cuandoFue(desde)}` : "Para empezar"}</span>
      <span class="meta">${resumen.length ? resumen.join(" · ") : "Lo nuevo en tus secciones"}</span>
    </summary>
    <div class="al-dia-cuerpo">
      ${deLoQueSigue.length ? html`<section><h3>Lo que sigues</h3><ul class="al-dia-lista">${deLoQueSigue.slice(0, 3).map((n) => html`<li>
        <a href="${enlaceHistoria(n.id)}">${recortar(n.titular, 110)}</a></li>`)}</ul>
        ${deLoQueSigue.length > 3 ? html`<a class="al-dia-mas" href="#/seguimiento">Y ${deLoQueSigue.length - 3} más en Seguimiento →</a>` : ""}</section>` : ""}
      ${respondidas.length ? html`<section><h3>Claude te respondió</h3><ul class="al-dia-lista">${respondidas.slice(0, 3).map((e) => html`<li>
        <a href="#/cuaderno">«${recortar(e.texto, 90)}»</a>${e.titulo ? html` <span class="meta">sobre ${recortar(e.titulo, 60)}</span>` : ""}</li>`)}</ul></section>` : ""}
      ${cambiaron.length ? html`<section><h3>Indicadores que cambiaron</h3><ul class="al-dia-lista">${cambiaron.map(({ pid, i }) => html`<li>
        <a href="${enlacePagina(pid)}">${i.nombre}</a> <span class="meta">${paginas[pid]?.nombre || ""}:</span>
        ${cifra(i.valor, i.unidad)}${i.anterior === null ? "" : html` <span class="meta">(antes ${cifra(i.anterior, i.unidad)})</span>`}</li>`)}</ul></section>` : ""}
      ${tituloAMedias ? html`<section><h3>Sigue donde ibas</h3><ul class="al-dia-lista"><li>
        <a href="${enlaceLector({ archivo })}">${tituloAMedias}</a> <span class="meta">vas en el ${porcentaje(aMedias)} %</span></li></ul></section>` : ""}
      ${preguntas + palabras ? html`<section><h3>Para repasar</h3><ul class="al-dia-lista"><li><a href="#/repaso">${[
        preguntas && `${preguntas} ${preguntas === 1 ? "pregunta" : "preguntas"} de lo que leíste`,
        palabras && `${palabras} ${palabras === 1 ? "palabra" : "palabras"} del vocabulario`].filter(Boolean).join(" y ")} →</a></li></ul></section>` : ""}
      ${deHoy ? html`<section><h3>Tu fuente de consulta de hoy</h3><ul class="al-dia-lista"><li>
        <a href="#/para-leer">${deHoy.nombre}</a> <span class="meta">${deHoy.tema || ""}</span></li></ul></section>` : ""}
      ${secciones.length ? html`<section><h3>${desde ? "Lo nuevo en tus secciones" : "Tus secciones"}</h3>
        <div class="lista-chips">${secciones.map((s) => html`<a class="chip" href="#/${VISTA_DE_GRUPO[s.p.grupo]}/${s.p.slug}"
          title="${s.nuevas} ${s.nuevas === 1 ? "historia nueva o con novedades" : "historias nuevas o con novedades"} desde tu última visita">${s.p.nombre}<span>${s.nuevas}</span></a>`)}</div></section>` : ""}
    </div>
  </details>`, destino);
}

// En cuántas historias aparece cada nombre. Los que se escriben distinto pero llevan a la misma
// página ("Abelardo de la Espriella" y "Abelardo De la Espriella") cuentan como uno, con la
// forma que más se usa.
function contarNombres(historias, sirve = () => true) {
  const porId = new Map();
  for (const h of historias) {
    const vistos = new Set();
    for (const n of h.e || []) {
      if (!sirve(n)) continue;
      const id = slugV2(n);
      const c = porId.get(id) || { id, veces: 0, formas: new Map() };
      c.formas.set(n, (c.formas.get(n) || 0) + 1);
      if (!vistos.has(id)) c.veces++;
      vistos.add(id);
      porId.set(id, c);
    }
  }
  return [...porId.values()].map((c) => ({ id: c.id, veces: c.veces, nombre: [...c.formas].sort((a, b) => b[1] - a[1])[0][0] }))
    .sort((a, b) => b.veces - a.veces);
}

// Las personas, organizaciones y empresas que más aparecen en las historias del día.
const MINIMO_DE_HISTORIAS_DEL_NOMBRE = 3;

async function pintarNombresDelDia(destino) {
  const buscador = await indiceDelBuscador();
  if (!buscador || !destino?.isConnected) return;
  const nombres = contarNombres(buscador.historias.filter((h) => h.a === buscador.dia),
    (n) => ["persona", "organizacion", "empresa"].includes(buscador.tipos[n])).filter((c) => c.veces >= MINIMO_DE_HISTORIAS_DEL_NOMBRE).slice(0, 14);
  if (nombres.length < 3) return;
  pintar(html`<h2>Quiénes están en las noticias hoy</h2>
    <div class="lista-chips">${nombres.map((c) => html`<a class="chip" href="${enlaceEntidad(c.id)}"
      title="En ${c.veces} historias de hoy">${c.nombre}<span>${c.veces}</span></a>`)}</div>`, destino);
  destino.hidden = false;
}

// ---------- Las direcciones de una página llevan a su subpestaña ----------
// #/p/pais-colombia abre América Latina con el filtro de Colombia; así siguen sirviendo los
// enlaces "Más de Colombia →" y los que ya estaban guardados.

async function vistaPagina(pid) {
  const indice = await leerJSON("datos/v2/indice.json");
  const pestana = indice.pestanas.find((p) => p.pestana === pid || p.hojas.includes(pid));
  if (!pestana) throw new Error("No existe esa página.");
  const filtro = pestana.hojas.length > 1 && pestana.hojas.includes(pid) ? `/${pid}` : "";
  location.replace(`#/${VISTA_DE_GRUPO[pestana.grupo]}/${pestana.slug}${filtro}`);
}

// ---------- Una historia completa y el grafo latente ----------

async function vistaHistoria(id) {
  const indice = await leerJSON("datos/v2/indice.json");
  // Una historia que se juntó con otra lleva a esa.
  if (indice.fusionadas?.[id]) return location.replace(enlaceHistoria(indice.fusionadas[id]));
  const pid = indice.historias[id];
  if (!pid) throw new Error("No se encontró esa historia.");
  resaltar(VISTA_DE_GRUPO[indice.paginas.find((t) => t.pagina === pid)?.grupo]);
  const [pagina, { visitas, leidas }] = await Promise.all([leerJSON(`datos/v2/paginas/${pid}.json`), marcasV2(),
    cargarHilosPorHistoria(), leerSeguimiento()]);
  const h = [...pagina.hoy, ...pagina.semana].find((x) => x.id === id)
    || (await leerJSON("datos/v2/historias.json")).historias[id];
  const visto = masReciente(leidas.get(id), visitas.get(pid));
  const nuevas = visto ? h.actualizaciones.filter((a) => despues(a.momento, visto)) : [];
  const piezas = [...h.piezas].sort((a, b) => ORDEN_RECOMENDACION[a.recomendacion] - ORDEN_RECOMENDACION[b.recomendacion]
    || b.relevancia - a.relevancia);
  pintar(html`
    <article class="dos-columnas historia-completa">
      <div class="principal">
        <a class="volver" href="${enlacePagina(pid)}">← ${pagina.nombre}</a>
        <header>
          <h1>${h.titular || h.titulo}</h1>
          ${h.antes ? html`<p class="noticia-antes">Antes: ${h.antes}</p>` : ""}
          <p class="meta">${h.estado === "activa" ? "Activa" : "Cerrada"} desde el ${fechaCorta(h.creada)} · ${fuentesTexto(h.fuentes.length)} · última novedad: ${fechaLarga(h.actualizada, true)}</p>
          <div class="acciones-lectura">${h.estado === "activa" ? botonSeguir(h.id) : ""}${botonEscuchar()}</div>
        </header>
        ${nuevas.length ? html`<section class="nuevo-desde destacado">
          <p class="grupo">Nuevo desde que la leíste (${fechaLarga(visto, true)})</p>
          <ul>${nuevas.flatMap((a) => a.textos.map((t) => html`<li>${t}</li>`))}</ul>
        </section>` : ""}
        <section class="sintesis-historia">
          <div class="cuerpo">${seguro(markdownAHtml(h.sintesis))}</div>
          ${h.lectura_claude ? html`<p class="lectura-claude"><em>Lectura de Claude: ${h.lectura_claude}</em></p>` : ""}
        </section>
        ${h.contraste ? html`<section class="contraste"><h2>En qué no coinciden las fuentes</h2><p>${h.contraste}</p></section>` : ""}
        ${h.que_sigue.length ? html`<section><h2>Qué sigue</h2>
          <ul class="que-sigue">${h.que_sigue.map((q) => html`<li><strong>${q.cuando}:</strong> ${q.que}</li>`)}</ul></section>` : ""}
        <section class="preguntas-historia"><h2>Pregúntale a Claude</h2>${preguntarSobre(h)}</section>
        <section><h2>Las piezas (${piezas.length})</h2>
          <ul class="lista-compacta">${piezas.map((p) => html`<li><a href="${enlaceLector(p)}">
            <span class="insignia insignia-${p.recomendacion}">${RECOMENDACIONES[p.recomendacion]}</span>
            <span class="articulo-titulo">${p.titulo}</span>
            <span class="meta">${p.fuente}${TIPOS_DE_PIEZA[p.tipo] ? ` · ${TIPOS_DE_PIEZA[p.tipo]}` : ""} · ${fechaCorta(p.fecha)}${p.minutos ? ` · ${p.minutos} min` : ""}</span></a></li>`)}</ul>
        </section>
      </div>
      <aside class="lateral">
        ${h.linea.length ? html`<section><h2>Línea de tiempo</h2>
          <ol class="linea-tiempo">${h.linea.map((e) => html`<li><span class="meta">${fechaCorta(e.fecha)}</span> ${e.texto}</li>`)}</ol></section>` : ""}
        ${h.entidades.length ? html`<section><h2>Personas, lugares y organizaciones</h2>
          <div class="lista-chips">${h.entidades.map((e) => html`<a class="chip" href="${enlaceEntidad(e.id)}">${e.nombre}</a>`)}</div></section>` : ""}
        ${h.conexiones.length ? html`<section><h2>Conectada con</h2>
          <ul class="lista-compacta">${h.conexiones.map((c) => html`<li><a href="${enlaceHistoria(c.id)}">
            <span class="articulo-titulo">${c.titulo}</span><span class="meta">Comparten: ${c.por.join(", ")}</span></a></li>`)}</ul></section>` : ""}
      </aside>
    </article>
  `);
  enlazarNombres(contenido.querySelector(".sintesis-historia > .cuerpo"), h.entidades);
  paraEscuchar = () => escucharCola([{ clave: h.id, titulo: h.titular || h.titulo, partes: [
    ...historiaParaEscuchar(h).partes,
    ...(h.contraste ? partir(`En qué no coinciden las fuentes: ${h.contraste}`) : []),
    ...(h.que_sigue.length ? partir(`Qué sigue: ${h.que_sigue.map((q) => `${q.cuando}, ${q.que}`).join(". ")}.`) : []),
  ] }], { titulo: "Historia", alEmpezar: (item) => resaltarSonando(item && ".sintesis-historia") });
  marcar({ tipo: "historia_leida", historia: id });
}

// La página de un nombre: en qué historias de las dos últimas semanas aparece, por página, y
// junto a quién. Sale del índice del buscador, que es liviano; un nombre que no esté ahí se
// busca en el grafo completo.
async function vistaEntidad(id) {
  const [buscador, indice] = await Promise.all([indiceDelBuscador(), leerJSON("datos/v2/indice.json")]);
  const variantes = Object.keys(buscador?.tipos || {}).filter((n) => slugV2(n) === id);
  const historias = variantes.length ? buscador.historias.filter((h) => h.e?.some((n) => variantes.includes(n))) : [];
  if (!historias.length) return vistaEntidadDelGrafo(id);
  const veces = (n) => historias.filter((h) => h.e.includes(n)).length;
  const [nombre] = variantes.sort((a, b) => veces(b) - veces(a));
  const nombres = Object.fromEntries(indice.paginas.map((t) => [t.pagina, t.nombre]));
  const porPagina = [...agrupar(historias, (h) => h.h)].sort((a, b) => b[1].length - a[1].length);
  const juntoA = contarNombres(historias, (n) => !variantes.includes(n)).filter((c) => c.veces >= 2 || historias.length < 4).slice(0, 18);
  pintar(html`
    <header class="encabezado-vista">
      <p class="sobretitulo">${TIPOS_DE_ENTIDAD[buscador.tipos[nombre]] || "Nombre"} · en ${historias.length === 1 ? "1 historia" : `${historias.length} historias`} de ${
        porPagina.length === 1 ? "1 página" : `${porPagina.length} páginas`} en las dos últimas semanas</p>
      <h1>${nombre}</h1>
    </header>
    <div class="dos-columnas">
      <div class="principal">${porPagina.map(([pid, lista]) => html`<section class="historias-del-nombre">
        <h2><a class="enlace-sobrio" href="${enlacePagina(pid)}">${nombres[pid] || pid}</a> <span class="cuenta">${lista.length}</span></h2>
        <ul class="lista-compacta">${lista.map((h) => html`<li><a href="${enlaceHistoria(h.id)}">
          <span class="articulo-titulo">${h.t}</span>
          ${h.s ? html`<span class="extracto">${h.s}</span>` : ""}
          <span class="meta">${[fuentesTexto(h.f), fechaCorta(h.a), h.c ? "cerrada" : ""].filter(Boolean).join(" · ")}</span></a></li>`)}</ul>
      </section>`)}</div>
      ${juntoA.length ? html`<aside class="lateral"><section><h2>Aparece junto a</h2>
        <div class="lista-chips">${juntoA.map((c) => html`<a class="chip" href="${enlaceEntidad(c.id)}"
          title="Juntos en ${c.veces} ${c.veces === 1 ? "historia" : "historias"}">${c.nombre}<span>${c.veces}</span></a>`)}</div></section></aside>` : ""}
    </div>
  `);
}

async function vistaEntidadDelGrafo(id) {
  const [{ entidades }, indice] = await Promise.all([leerJSON("datos/v2/entidades.json"), leerJSON("datos/v2/indice.json")]);
  const e = entidades[id];
  if (!e) throw new Error("No se encontró ese nombre en las historias activas.");
  const nombres = Object.fromEntries(indice.paginas.map((t) => [t.pagina, t.nombre]));
  const porPagina = agrupar(e.historias, (h) => h.pagina);
  pintar(html`
    <header class="encabezado-vista">
      <p class="sobretitulo">${TIPOS_DE_ENTIDAD[e.tipo] || e.tipo} · en ${e.historias.length === 1 ? "1 historia" : `${e.historias.length} historias`} de ${porPagina.size === 1 ? "1 página" : `${porPagina.size} páginas`}</p>
      <h1>${e.nombre}</h1>
    </header>
    ${[...porPagina].map(([pid, lista]) => html`<section class="seccion-grilla">
      <h2><a class="enlace-sobrio" href="${enlacePagina(pid)}">${nombres[pid] || pid}</a></h2>
      <div class="grilla">${lista.map((h) => html`<a class="tarjeta-pagina" href="${enlaceHistoria(h.id)}">
        <span class="tarjeta-nombre">${h.titulo}</span>
        <span class="tarjeta-texto">${h.frase}</span>
        <span class="tarjeta-pie">${fuentesTexto(h.fuentes)} · ${fechaCorta(h.actualizada)}</span>
      </a>`)}</div>
    </section>`)}
    ${e.vecinos.length ? html`<section><h2>Aparece junto a</h2>
      <div class="lista-chips">${e.vecinos.map((n) => entidades[slugV2(n)]
        ? html`<a class="chip" href="${enlaceEntidad(slugV2(n))}">${n}</a>` : html`<span class="chip">${n}</span>`)}</div></section>` : ""}
  `);
}

// Las direcciones del formato cuando estaba en prueba (#/nuevo/…) llevan a las de ahora.
function vistaNuevo(ruta) {
  const [tipo, ...resto] = (ruta || "").split("/");
  const valor = resto.join("/");
  const grupo = Object.entries(GRUPOS).find(([, g]) => g === valor)?.[0] || (valor === "Temas" ? "areas" : null);
  const destino = tipo === "g" && grupo ? `#/${grupo}` : ["p", "h", "e"].includes(tipo) ? `#/${tipo}/${encodeURIComponent(valor)}` : "#/hoy";
  location.replace(destino);
}

// ---------- Buscar: Ctrl+K, "/" o la lupa ----------
// Historias de las dos últimas semanas, nombres, secciones, lecturas, fuentes y el Cuaderno, más
// lo que se le puede dejar a Claude sin salir de donde se está. Sin Claude: el índice lo arma el
// organizador cada noche (datos/v2/buscar.json).

let indiceBuscador = null;
function indiceDelBuscador() {
  indiceBuscador ??= leerJSON("datos/v2/buscar.json").catch(() => null);
  return indiceBuscador;
}

const IR_A = [
  ["Hoy", "#/hoy", "inicio portada relevante"], ["Seguimiento", "#/seguimiento", "historias que sigo linea de tiempo"],
  ["Geografía", "#/geografia", "paises regiones mundo"], ["Áreas", "#/areas", "temas"], ["Sectores", "#/sectores", "radar negocios"],
  ["Para leer", "#/para-leer", "lecturas biblioteca libros cola guardadas"], ["Para ver", "#/para-ver", "videos cursos documentales youtube canales"],
  ["Cuaderno", "#/cuaderno", "preguntas vocabulario frases claude conversaciones"], ["Repaso", "#/repaso", "tutor aprender recordar palabras"],
  ["Fuentes", "#/fuentes", "catalogo medios paginas"], ["Estado", "#/estado", "sistema recoleccion fallas marcas"],
  ["Gasto y piezas", "#/estado/gasto", "costos dinero api tope creditos"],
];
const GRUPOS_DE_BUSQUEDA = { visitadas: "Lo que más visitas", ir: "Ir a", seccion: "Secciones", historia: "Historias", nombre: "Nombres",
  lectura: "Para leer y para ver", fuente: "Fuentes", cuaderno: "En tu Cuaderno", accion: "Dejarle algo a Claude" };
const CUANTOS_POR_GRUPO = { seccion: 4, historia: 8, nombre: 4, lectura: 3, fuente: 3, cuaderno: 3 };
const CLASES_EN_BUSQUEDA = { ...CLASES_CUADERNO, reflexion: "Reflexión", error: "Error en el texto" };

const campo = (texto, peso) => [normalizar(texto), peso];

async function armarCandidatos() {
  const [buscador, indice, catalogo, agregadas, { lecturas }, biblioteca] = await Promise.all([indiceDelBuscador(),
    leerJSON("datos/v2/indice.json"), leerJSON("catalogo/fuentes.json").catch(() => ({ fuentes: [] })),
    leerJSON("catalogo/fuentes_agregadas.json").catch(() => ({ fuentes: [] })),
    leerJSON("catalogo/lecturas.json").catch(() => ({ lecturas: [] })), leerJSON("datos/biblioteca/indice.json").catch(() => ({}))]);
  const paginas = Object.fromEntries(indice.paginas.map((t) => [t.pagina, t]));
  const candidatos = [
    ...IR_A.map(([nombre, href, otras]) => ({ grupo: "seccion", vista: true, href, titulo: nombre, meta: "Ir a la vista",
      campos: [campo(nombre, 4), campo(otras, 2)], impulso: 1.3 })),
    ...indice.pestanas.map((p) => ({ grupo: "seccion", href: `#/${VISTA_DE_GRUPO[p.grupo]}/${p.slug}`, titulo: p.nombre,
      meta: `${p.grupo} · ${noticiasTexto(p.hoy)} hoy`, campos: [campo(p.nombre, 4)], impulso: 1.25 })),
    ...indice.paginas.filter((t) => !indice.pestanas.some((p) => p.pestana === t.pagina)).map((t) => ({ grupo: "seccion",
      href: enlacePagina(t.pagina), titulo: t.filtro || t.nombre, meta: `${t.seccion || t.grupo} · ${noticiasTexto(t.hoy)} hoy`,
      campos: [campo(t.nombre, 4), campo(t.filtro, 4)], impulso: 1.2 })),
    ...(buscador?.historias || []).map((h) => ({ grupo: "historia", href: enlaceHistoria(h.id), titulo: h.t, detalle: h.s,
      meta: [paginas[h.h]?.nombre, fuentesTexto(h.f), fechaCorta(h.a), h.c ? "cerrada" : ""].filter(Boolean).join(" · "),
      campos: [campo(h.t, 3), campo(h.o, 2), campo((h.e || []).join(" · "), 2.5), campo(h.s, 1), campo(paginas[h.h]?.nombre, 1.5)],
      impulso: impulsoDeHistoria(h, buscador.dia) })),
    ...contarNombres(buscador?.historias || []).filter((c) => c.veces >= 2).map((c) => ({ grupo: "nombre", href: enlaceEntidad(c.id),
      titulo: c.nombre, meta: `${TIPOS_DE_ENTIDAD[buscador.tipos[c.nombre]] || "Nombre"} · en ${c.veces} historias`,
      campos: [campo(c.nombre, 4)], impulso: 1 + 0.1 * Math.log2(c.veces) })),
    ...lecturas.filter((l) => l.momento_final !== "Ya leído").map((l) => {
      const archivo = biblioteca[l.id]?.archivo;
      return { grupo: "lectura", href: archivo ? enlaceLector({ archivo }) : l.url || "#/para-leer", externo: !archivo && Boolean(l.url),
        titulo: l.titulo, meta: [l.autor, l.momento_final, CLASES_PARA_VER.has(l.tipo) ? "Para ver" : "Para leer"].filter(Boolean).join(" · "),
        campos: [campo(l.titulo, 3), campo(l.autor, 2.5), campo((l.etiquetas || []).join(" "), 1)] };
    }),
    ...[...catalogo.fuentes, ...agregadas.fuentes].filter((f) => f.url).map((f) => ({ grupo: "fuente", href: f.url, externo: true,
      titulo: f.nombre, meta: [f.autor_o_responsable !== f.nombre ? f.autor_o_responsable : "", f.categoria_inicial].filter(Boolean).join(" · "),
      campos: [campo(f.nombre, 4), campo(f.autor_o_responsable, 2), campo((f.etiquetas || []).join(" "), 1)], impulso: 0.9 })),
  ];
  return { porGrupo: agrupar(candidatos, (c) => c.grupo), indice };
}

// El Cuaderno cambia mientras se usa la página: se arma cada vez que se abre el buscador.
async function candidatosDelCuaderno() {
  return (await leerCuaderno().catch(() => [])).filter((e) => !e.archivada && e.clase !== "ver").map((e) => ({
    grupo: "cuaderno", href: "#/cuaderno", titulo: e.texto,
    meta: [CLASES_EN_BUSQUEDA[e.clase] || e.clase, fechaCorta(e.ts), e.respuestas.length ? "respondida"
      : PROPIAS_DE_PEDRO.has(e.clase) ? "" : "por responder"].filter(Boolean).join(" · "),
    campos: [campo(e.texto, 3), campo(e.titulo, 1.5), campo(e.respuestas.map((r) => r.texto).join(" "), 1)] }));
}

// Dónde está Pedro: una pregunta hecha desde una historia o una lectura queda atada a ella.
function contextoActual() {
  const [vista, ...resto] = location.hash.replace(/^#\/?/, "").split("/");
  if (vista === "h") return { historia: decodeURIComponent(resto.join("/")), titulo: contenido.querySelector("h1")?.textContent.trim() || "" };
  const lector = vista === "leer" && contenido.querySelector(".lector");
  return lector ? { archivo: lector.dataset.archivo, titulo: lector.dataset.titulo } : null;
}

function accionesCon(consulta) {
  const texto = consulta.trim();
  if (!texto) return [];
  const contexto = contextoActual();
  return [
    /^https?:\/\/\S+$/i.test(texto) && { grupo: "accion", accion: "ver", titulo: "Agregar a Para ver", meta: texto },
    { grupo: "accion", accion: "pregunta", titulo: contexto ? `Preguntarle a Claude sobre «${recortar(contexto.titulo, 60)}»` : "Preguntarle a Claude",
      meta: `«${texto}»` },
    texto.length <= MAXIMO_DE_PALABRA && { grupo: "accion", accion: "palabra", titulo: "Guardar en el vocabulario", meta: `«${texto}»` },
    { grupo: "accion", accion: "pedido", titulo: "Pedido para Mentor", meta: `«${texto}»` },
  ].filter(Boolean);
}

function dejarEnElCuaderno(accion, texto) {
  if (accion === "ver") marcar({ tipo: "cuaderno", clase: "ver", texto, enlace: texto, para: "videos" });
  else marcar({ tipo: "cuaderno", clase: accion, texto, ...(accion === "pregunta" ? contextoActual() || {} : {}) });
  avisar({ ver: "Quedó en Para ver", pregunta: "Quedó en el Cuaderno: Claude la responde con /cuaderno",
    palabra: `"${texto}" quedó en tu vocabulario`, pedido: "Quedó en el Cuaderno como pedido para Mentor" }[accion]);
}

const paleta = document.createElement("dialog");
paleta.className = "paleta";
paleta.setAttribute("aria-label", "Buscar en Mentor");
paleta.innerHTML = `<div class="paleta-caja">
  <div class="paleta-campo">
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
    <input type="text" role="combobox" aria-expanded="true" aria-controls="paleta-resultados" aria-autocomplete="list"
      aria-label="Buscar en Mentor" autocomplete="off" spellcheck="false" enterkeyhint="go"
      placeholder="Busca historias, nombres, países, lecturas… o escribe algo para Claude">
  </div>
  <div class="paleta-resultados" id="paleta-resultados" role="listbox" aria-label="Resultados"></div>
  <p class="paleta-pie"><span><kbd>↑</kbd> <kbd>↓</kbd> moverse</span><span><kbd>Enter</kbd> abrir</span><span><kbd>Esc</kbd> cerrar</span><span><kbd>?</kbd> atajos</span></p>
</div>`;
document.body.append(paleta);
const campoPaleta = paleta.querySelector("input");
const resultadosPaleta = paleta.querySelector(".paleta-resultados");
let candidatos = null;
let delCuaderno = [];
let seleccionada = 0;

function seleccionar(i) {
  const items = [...resultadosPaleta.querySelectorAll(".paleta-item")];
  if (!items.length) {
    campoPaleta.removeAttribute("aria-activedescendant");
    return;
  }
  seleccionada = (i + items.length) % items.length;
  items.forEach((el, k) => el.setAttribute("aria-selected", String(k === seleccionada)));
  campoPaleta.setAttribute("aria-activedescendant", items[seleccionada].id);
  items[seleccionada].scrollIntoView({ block: "nearest" });
}

// Sin nada escrito: lo que más visita y las vistas. Con algo escrito: cada grupo con lo que
// coincide, primero el grupo que mejor coincide, y al final lo que se le puede dejar a Claude.
async function pintarResultados() {
  if (!candidatos) return;
  const consulta = campoPaleta.value;
  let grupos;
  if (!consulta.trim()) {
    const secciones = candidatos.porGrupo.get("seccion");
    const veces = new Map();
    const marcas = await todasLasMarcas();
    if (campoPaleta.value !== consulta) return; // mientras tanto escribió algo
    for (const m of marcas) {
      if (m.tipo !== "visita" || !m.pagina || m.pagina === "hoy") continue;
      const pestana = candidatos.indice.pestanas.find((p) => p.pestana === m.pagina || p.hojas.includes(m.pagina));
      const href = IR_A.some(([, h]) => h === `#/${m.pagina}`) ? `#/${m.pagina}`
        : pestana && (pestana.pestana === m.pagina || pestana.hojas.length === 1) ? `#/${VISTA_DE_GRUPO[pestana.grupo]}/${pestana.slug}`
          : enlacePagina(m.pagina);
      veces.set(href, (veces.get(href) || 0) + 1);
    }
    const visitadas = [...veces].sort((a, b) => b[1] - a[1]).map(([href]) => secciones.find((s) => s.href === href)).filter(Boolean).slice(0, 5);
    grupos = [["visitadas", visitadas], ["ir", secciones.filter((s) => s.vista)]].filter(([, lista]) => lista.length);
  } else {
    grupos = Object.keys(CUANTOS_POR_GRUPO)
      .map((g) => [g, buscar(g === "cuaderno" ? delCuaderno : candidatos.porGrupo.get(g) || [], consulta, CUANTOS_POR_GRUPO[g])])
      .filter(([, lista]) => lista.length).sort((a, b) => b[1][0].puntaje - a[1][0].puntaje);
    grupos.push(["accion", accionesCon(consulta)]);
  }
  let n = 0;
  const item = (r) => {
    const dentro = html`<span class="paleta-titulo">${r.titulo}</span>${r.meta ? html`<span class="paleta-meta">${r.meta}</span>` : ""}${
      r.detalle ? html`<span class="paleta-detalle">${r.detalle}</span>` : ""}`;
    const id = `paleta-opcion-${n++}`;
    return r.accion ? html`<button type="button" class="paleta-item" role="option" id="${id}" data-accion="${r.accion}">${dentro}</button>`
      : html`<a class="paleta-item" role="option" id="${id}" href="${r.href}"${r.externo ? seguro(' target="_blank" rel="noopener noreferrer"') : ""}>${dentro}</a>`;
  };
  pintar(html`${grupos.length > 1 || consulta.trim() ? grupos.map(([g, lista]) => html`<section class="paleta-grupo">
      <h3>${GRUPOS_DE_BUSQUEDA[g]}</h3>${lista.map(item)}</section>`) : ""}
    ${consulta.trim() && grupos.length === 1 ? html`<p class="paleta-vacia">Nada con «${consulta.trim()}» en las dos últimas semanas.</p>` : ""}`,
  resultadosPaleta);
  seleccionar(0);
}

async function abrirPaleta(consulta) {
  if (!paleta.open) paleta.showModal();
  if (typeof consulta === "string") campoPaleta.value = consulta;
  campoPaleta.select();
  if (!candidatos) {
    resultadosPaleta.innerHTML = '<p class="paleta-vacia">Cargando…</p>';
    try {
      candidatos = await armarCandidatos();
    } catch (error) {
      console.error(error);
      resultadosPaleta.innerHTML = '<p class="paleta-vacia">No se pudo cargar el buscador. Revisa tu conexión.</p>';
      return;
    }
  }
  delCuaderno = await candidatosDelCuaderno();
  pintarResultados();
}

function activarSeleccionada() {
  const elegida = resultadosPaleta.querySelectorAll(".paleta-item")[seleccionada];
  if (elegida) elegida.click();
}

campoPaleta.addEventListener("input", pintarResultados);
paleta.addEventListener("keydown", (evento) => {
  if (evento.key === "ArrowDown" || evento.key === "ArrowUp") {
    seleccionar(seleccionada + (evento.key === "ArrowDown" ? 1 : -1));
    evento.preventDefault();
  } else if (evento.key === "Enter" && !evento.isComposing) {
    activarSeleccionada();
    evento.preventDefault();
  }
});
resultadosPaleta.addEventListener("click", (evento) => {
  const accion = evento.target.closest("[data-accion]");
  if (accion) dejarEnElCuaderno(accion.dataset.accion, campoPaleta.value.trim());
  if (evento.target.closest(".paleta-item")) paleta.close();
});
resultadosPaleta.addEventListener("pointermove", (evento) => {
  const item = evento.target.closest(".paleta-item");
  if (item) seleccionar([...resultadosPaleta.querySelectorAll(".paleta-item")].indexOf(item));
});
// Un toque fuera de la caja la cierra.
paleta.addEventListener("click", (evento) => {
  if (evento.target === paleta) paleta.close();
});
document.getElementById("boton-buscar")?.addEventListener("click", () => abrirPaleta());

// #/buscar/<lo que sea>: Hoy de fondo y el buscador abierto con eso escrito.
async function vistaBuscar(consulta) {
  await vistaHoyV2();
  abrirPaleta(consulta || "");
}

// ---------- Atajos de teclado ----------
// En el computador: buscar, bajar y subir por las noticias, abrirlas, seguirlas, preguntar,
// escuchar y saltar entre secciones sin el ratón. No actúan mientras se escribe.

const IR_CON_G = { h: "#/hoy", s: "#/seguimiento", g: "#/geografia", a: "#/areas", e: "#/sectores", l: "#/para-leer",
  v: "#/para-ver", c: "#/cuaderno", r: "#/repaso", f: "#/fuentes", t: "#/estado" };
const NAVEGABLES = "details.noticia, .seguida, .lectura, .lista-profundizar > li, .hilo, .frase, .lista-compacta > li";
// Cada atajo: sus teclas, lo que va entre ellas y lo que hace.
const ATAJOS = [
  [["Ctrl", "K"], "+", "Buscar, ir a cualquier sección o dejarle algo a Claude (también con /)"],
  [["j"], "", "Bajar a la siguiente noticia o lectura"],
  [["k"], "", "Subir a la anterior"],
  [["o"], "", "Abrir o cerrar la que está marcada"],
  [["s"], "", "Seguir o soltar la historia marcada"],
  [["p"], "", "Preguntarle a Claude sobre la historia marcada, o sobre lo que tienes abierto"],
  [["e"], "", "Escuchar lo que tienes en pantalla; si ya suena, pausar o seguir"],
  [["[", "]"], "o", "Subpestaña anterior o siguiente"],
  [["g", "h"], "y luego", "Ir a Hoy. Con g y otra letra: s Seguimiento, g Geografía, a Áreas, e Sectores, l Para leer, v Para ver, c Cuaderno, r Repaso, f Fuentes, t Estado"],
  [["1", "4"], "a", "En el Repaso, responder con la opción de ese número"],
  [["?"], "", "Esta ayuda"],
];
let esperandoG = 0;

const ayuda = document.createElement("dialog");
ayuda.className = "ayuda-atajos";
ayuda.setAttribute("aria-label", "Atajos de teclado");
ayuda.innerHTML = html`<div class="ayuda-caja">
  <h2>Atajos de teclado</h2>
  <dl>${ATAJOS.map(([teclas, entre, que]) => html`<div><dt>${teclas.map((t, i) => html`${i ? ` ${entre} ` : ""}<kbd>${t}</kbd>`)}</dt><dd>${que}</dd></div>`)}</dl>
  <p class="meta">No actúan mientras escribes. <button type="button" class="boton-texto" data-cerrar-ayuda>Cerrar</button></p>
</div>`.texto;
document.body.append(ayuda);
ayuda.addEventListener("click", (evento) => {
  if (evento.target === ayuda || evento.target.closest("[data-cerrar-ayuda]")) ayuda.close();
});

function moverFoco(paso) {
  const items = [...contenido.querySelectorAll(NAVEGABLES)].filter((el) => el.getClientRects().length);
  if (!items.length) return;
  const actual = contenido.querySelector(".enfocada");
  let i = actual ? items.indexOf(actual) : -1;
  // Sin ninguna marcada, se empieza por la primera que se ve en la pantalla.
  if (i < 0) i = Math.max(0, items.findIndex((el) => el.getBoundingClientRect().bottom > 90)) - (paso > 0 ? 1 : 0);
  const siguiente = items[Math.max(0, Math.min(items.length - 1, i + paso))];
  actual?.classList.remove("enfocada");
  siguiente.classList.add("enfocada");
  (siguiente.querySelector(":scope > summary, a, button") || siguiente).focus({ preventScroll: true });
  siguiente.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function preguntarSobreLaMarcada(actual) {
  const detalles = actual?.matches("details.noticia") ? actual : null;
  if (detalles && !detalles.open) detalles.querySelector(":scope > summary").click();
  const preguntar = (detalles || contenido).querySelector("details.preguntar");
  if (!preguntar) return;
  preguntar.open = true;
  preguntar.querySelector("textarea")?.focus();
}

function cambiarPestana(paso) {
  const enlaces = [...contenido.querySelectorAll(".pestanas a")];
  const i = enlaces.findIndex((a) => a.getAttribute("aria-current") === "page");
  if (i >= 0) enlaces[(i + paso + enlaces.length) % enlaces.length].click();
}

document.addEventListener("keydown", (evento) => {
  if ((evento.ctrlKey || evento.metaKey) && !evento.altKey && evento.key.toLowerCase() === "k") {
    evento.preventDefault();
    if (paleta.open) paleta.close();
    else abrirPaleta();
    return;
  }
  if (evento.defaultPrevented || evento.ctrlKey || evento.metaKey || evento.altKey) return;
  if (evento.target.closest?.("input, textarea, select, [contenteditable]") || document.querySelector("dialog[open]")) return;
  if (teclasDeLaVista?.(evento)) {
    evento.preventDefault();
    return;
  }
  const tecla = evento.key;
  if (Date.now() - esperandoG < 1500) {
    esperandoG = 0;
    if (IR_CON_G[tecla]) {
      location.hash = IR_CON_G[tecla];
      evento.preventDefault();
    }
    return;
  }
  const actual = contenido.querySelector(".enfocada");
  if (tecla === "/") abrirPaleta();
  else if (tecla === "?") ayuda.showModal();
  else if (tecla === "g") esperandoG = Date.now();
  else if (tecla === "j" || tecla === "k") moverFoco(tecla === "j" ? 1 : -1);
  else if (tecla === "o" && actual) (actual.matches("details") ? actual.querySelector(":scope > summary") : actual.querySelector("a"))?.click();
  else if (tecla === "s" && actual) actual.querySelector("[data-seguir]")?.click();
  else if (tecla === "p") preguntarSobreLaMarcada(actual);
  else if (tecla === "e") {
    if (!pausarOSeguir()) paraEscuchar?.();
  } else if (tecla === "[" || tecla === "]") cambiarPestana(tecla === "]" ? 1 : -1);
  else return;
  evento.preventDefault();
});

const VISTAS = {
  hoy: vistaHoyV2,
  buscar: vistaBuscar,
  repaso: vistaRepaso,
  geografia: (ruta) => vistaPestanas("geografia", ruta),
  areas: (ruta) => vistaPestanas("areas", ruta),
  sectores: (ruta) => vistaPestanas("sectores", ruta),
  p: vistaPagina,
  h: vistaHistoria,
  e: vistaEntidad,
  nuevo: vistaNuevo,
  leer: vistaLector,
  fuentes: vistaFuentes,
  "para-leer": vistaParaLeer,
  "para-ver": vistaParaVer,
  radar: vistaRadar,
  cuaderno: vistaCuaderno,
  seguimiento: vistaSeguimiento,
  vocabulario: vistaCuaderno,
  estado: vistaEstado,
  conectar: vistaConectar,
};
// Las vistas que usan el ancho del computador; las demás quedan en una columna de lectura.
const VISTAS_ANCHAS = new Set(["hoy", "buscar", "geografia", "areas", "sectores", "p", "h", "e"]);
// Qué sección de la barra se ilumina en las vistas que no tienen la suya.
const NAVEGACION_DE = { leer: "hoy", nuevo: "hoy", buscar: "hoy", vocabulario: "cuaderno", repaso: "cuaderno" };

const posiciones = {};
let rutaActual = null;

function mostrarError(error) {
  const sinPermiso = error instanceof ErrorDeDatos && [401, 403].includes(error.estado);
  pintar(html`<section class="vacio">
    <p>${sinPermiso ? "GitHub no aceptó tu token." : "No se pudo cargar esta vista."}</p>
    <p class="meta">${error.message}</p>
    ${sinPermiso ? html`<a class="boton" href="#/conectar">Conectar de nuevo</a>` : ""}
  </section>`);
}

// ---------- Cuando llega algo más reciente que lo que se pintó ----------
// La vista se pinta desde la copia del navegador y la revisión llega un momento después. Si trae
// algo nuevo para lo que está en pantalla y no la has tocado, se vuelve a pintar sola; si ya la
// estás usando, se avisa y la actualizas cuando quieras. Las marcas nuevas de otro dispositivo
// no avisan: entran en la siguiente vista.

let empezadaEn = 0;
let pintadaEn = 0;
let tocadaEn = 0;
let repintando = false;
let repintarAlTerminar = false;
for (const tipo of ["pointerdown", "keydown", "wheel", "touchstart"]) {
  document.addEventListener(tipo, () => { tocadaEn = Date.now(); }, { capture: true, passive: true });
}

alActualizar((cambio) => {
  if (cambio.sinConexion) {
    avisar("Sin conexión con GitHub: lo que ves es la copia guardada en este navegador.");
    return;
  }
  if (cambio.archivos.length) {
    if (cambio.archivos.includes("datos/v2/buscar.json")) indiceBuscador = null;
    if (!paleta.open) candidatos = null; // el buscador se rearma la próxima vez que se abra
  }
  const toca = laVistaUsa(cambio.archivos);
  if (!toca && !cambio.marcas) return;
  if (empezadaEn > pintadaEn) {
    repintarAlTerminar = true; // la vista se está pintando: se repinta apenas termine
    return;
  }
  const quieta = tocadaEn < pintadaEn && !document.querySelector("dialog[open]") && !document.body.classList.contains("con-reproductor");
  if (quieta) repintarVista();
  else if (toca) avisar("Llegó información más reciente.", { texto: "Actualizar", hacer: repintarVista });
});

async function repintarVista() {
  repintando = true;
  try {
    await enrutar();
  } finally {
    repintando = false;
  }
}

// Volver a pintar una vista no es otra visita.
function marcarVisita(pagina) {
  if (!repintando) marcar({ tipo: "visita", pagina });
}

async function enrutar() {
  const [nombre = "hoy", ...resto] = location.hash.replace(/^#\/?/, "").split("/");
  if (rutaActual) posiciones[rutaActual] = window.scrollY;
  rutaActual = location.hash || "#/hoy";
  empezadaEn = Date.now();

  if (!modoLocal() && !config().token && nombre !== "conectar") {
    location.hash = "#/conectar";
    return;
  }
  const vista = VISTAS[nombre] ? nombre : "hoy";
  resaltar(NAVEGACION_DE[vista] || vista);
  contenido.classList.toggle("amplio", VISTAS_ANCHAS.has(vista));
  contenido.onclick = null;
  contenido.onchange = null;
  paraEscuchar = null;
  teclasDeLaVista = null;
  historiasEnVista.clear();
  for (const dialogo of document.querySelectorAll("dialog[open]")) dialogo.close();
  menuSeleccion.hidden = true;
  const aviso = document.getElementById("aviso");
  if (aviso.querySelector(".aviso-accion")) aviso.hidden = true; // la vista nueva ya trae lo reciente
  if (!repintando) contenido.innerHTML = '<p class="cargando">Cargando…</p>';
  nuevaVista();
  try {
    await VISTAS[vista](decodeURIComponent(resto.join("/")));
  } catch (error) {
    console.error(error);
    mostrarError(error);
  }
  pintadaEn = Date.now();
  window.scrollTo(0, vista === "leer" && !repintando ? 0 : posiciones[rutaActual] || 0);
  if (repintarAlTerminar) {
    repintarAlTerminar = false;
    setTimeout(repintarVista);
  }
}

// ---------- Tema claro, oscuro o automático ----------

const TEMAS = ["auto", "dark", "light"];
const NOMBRES_TEMA = { auto: "automático", dark: "oscuro", light: "claro" };

function aplicarTema(tema) {
  if (tema === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = tema;
  document.getElementById("boton-tema").title = `Tema ${NOMBRES_TEMA[tema]}`;
}

let tema = "auto";
try { tema = localStorage.getItem("mentor.tema") || "auto"; } catch { /* sin almacenamiento */ }
aplicarTema(tema);
document.getElementById("boton-tema").addEventListener("click", () => {
  tema = TEMAS[(TEMAS.indexOf(tema) + 1) % TEMAS.length];
  aplicarTema(tema);
  try { localStorage.setItem("mentor.tema", tema); } catch { /* sin almacenamiento */ }
});

window.addEventListener("hashchange", enrutar);
enrutar();
