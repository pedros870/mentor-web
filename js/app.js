// Mentor: la interfaz de lectura. Una sola página con vistas por dirección
// (#/hoy, #/leer/…, #/para-leer, #/radar, #/vocabulario, #/estado).
import { ErrorDeDatos, REPO_POR_DEFECTO, borrarConfig, config, guardarConfig, leerJSON, leerTexto, modoLocal } from "./datos.js";
import { escapar, markdownAHtml, separarFicha } from "./markdown.js";

const contenido = document.getElementById("contenido");

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

// ---------- Hoy: el resumen de la mañana ----------

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

function itemTitular(t) {
  return html`<li><a class="articulo" href="${enlaceLector(t)}">
    <span class="articulo-titulo">${t.titulo}</span>
    <span class="meta"><span class="insignia insignia-${t.recomendacion}">${RECOMENDACIONES[t.recomendacion]}</span> ${t.fuente} · ${t.minutos} min</span>
    <span class="razon">${t.razon}</span>
  </a></li>`;
}

function pintarResumen(r) {
  const porCategoria = agrupar(r.titulares, (t) => t.categoria);
  const categorias = CATEGORIAS.filter((c) => porCategoria.has(c));
  const orden = (a, b) => ORDEN_RECOMENDACION[a.recomendacion] - ORDEN_RECOMENDACION[b.recomendacion]
    || b.relevancia - a.relevancia;
  pintar(html`
    <header class="encabezado-vista">
      <p class="sobretitulo">Resumen del ${fechaLarga(r.fecha)}</p>
      <h1>Hoy</h1>
      <p class="meta">Escrito por Claude · unos ${r.minutos} min de lectura · ${numero(r.ventana.articulos)} artículos revisados</p>
    </header>
    ${r.aviso_noche ? html`<p class="aviso-noche">${r.aviso_noche}</p>` : ""}
    ${r.nota ? html`<p class="nota">${r.nota}</p>` : ""}
    ${r.lecturas_del_dia.length ? html`<section class="lecturas-del-dia">
      <h2>Las lecturas del día</h2>
      ${r.lecturas_del_dia.map((l) => html`<a class="tarjeta lectura-del-dia" href="${enlaceLector(l)}">
        <span class="sobretitulo">${l.fuente} · ${l.minutos} min</span>
        <span class="articulo-titulo">${l.titulo}</span>
        <span class="meta">${l.por_que}</span>
      </a>`)}
    </section>` : ""}
    ${r.categorias.map((c) => html`<section class="categoria-resumen">
      <h2>${c.nombre}</h2>
      <div class="cuerpo cuerpo-resumen">${seguro(markdownAHtml(c.texto))}</div>
    </section>`)}
    <section class="titulares">
      <h2>Titulares</h2>
      <p class="nota">Todo lo revisado, con la recomendación de Claude. Lo que conviene saltar queda plegado.</p>
      ${categorias.map((c) => {
        const lista = porCategoria.get(c);
        const destacados = lista.filter((t) => t.recomendacion !== "saltar").sort(orden);
        const saltar = lista.filter((t) => t.recomendacion === "saltar").sort(orden);
        return html`<details class="grupo-titulares">
          <summary>${c} <span class="cuenta">${destacados.length} de ${lista.length}</span></summary>
          <ul class="lista-articulos">${destacados.map(itemTitular)}</ul>
          ${saltar.length ? html`<button class="boton-texto" type="button" data-saltos>Ver ${saltar.length} para saltar</button>
            <ul class="lista-articulos" hidden>${saltar.map(itemTitular)}</ul>` : ""}
        </details>`;
      })}
    </section>
    <section class="tarjeta">
      <h2>Pedir un resumen nuevo</h2>
      <p class="meta">El botón se activa cuando conectemos la API de Claude: entonces el resumen se escribe solo, desde lo último que leíste.</p>
      <button class="boton" type="button" disabled>Pedir resumen</button>
    </section>
  `);
  contenido.onclick = (evento) => {
    const boton = evento.target.closest("[data-saltos]");
    if (!boton) return;
    boton.nextElementSibling.hidden = false;
    boton.remove();
  };
}

// ---------- Hoy sin resumen: los titulares recolectados ----------

const estadoHoy = { filtro: "todas", abiertas: new Set() };
const VISIBLES_POR_CATEGORIA = 6;

async function vistaHoy() {
  const resumen = await leerResumen();
  if (resumen) {
    pintarResumen(resumen);
    return;
  }
  const { ultima, articulos } = await ultimaRecoleccion();
  const porCategoria = agrupar(
    [...articulos].sort((a, b) => (b.fecha_publicacion || "").localeCompare(a.fecha_publicacion || "")),
    (a) => a.categoria_inicial || "Sin categoría",
  );
  const categorias = [...CATEGORIAS.filter((c) => porCategoria.has(c)),
    ...[...porCategoria.keys()].filter((c) => !CATEGORIAS.includes(c))];

  const dibujar = () => {
    const elegidas = estadoHoy.filtro === "todas" ? categorias : [estadoHoy.filtro];
    pintar(html`
      <header class="encabezado-vista">
        <p class="sobretitulo">Recolección del ${fechaLarga(ultima.fecha)}</p>
        <h1>Hoy</h1>
      </header>
      <section class="tarjeta tarjeta-resumen">
        <h2>Resumen de la mañana</h2>
        <p>Todavía no hay resumen: Claude empieza a escribirlo en la etapa 2. Por ahora ves los
          ${numero(articulos.length)} titulares recolectados, ordenados por la categoría de su fuente.</p>
        <button class="boton" type="button" disabled>Pedir resumen</button>
      </section>
      <div class="chips" role="group" aria-label="Filtrar por categoría">
        <button class="chip" type="button" data-filtro="todas" aria-pressed="${String(estadoHoy.filtro === "todas")}">Todas <span>${articulos.length}</span></button>
        ${categorias.map((c) => html`<button class="chip" type="button" data-filtro="${c}" aria-pressed="${String(estadoHoy.filtro === c)}">${c} <span>${porCategoria.get(c).length}</span></button>`)}
      </div>
      ${elegidas.map((c) => {
        const lista = porCategoria.get(c);
        const abierta = estadoHoy.filtro !== "todas" || estadoHoy.abiertas.has(c);
        const visibles = abierta ? lista : lista.slice(0, VISIBLES_POR_CATEGORIA);
        return html`<section class="categoria">
          <h2>${c} <span class="cuenta">${lista.length}</span></h2>
          <ul class="lista-articulos">${visibles.map(itemArticulo)}</ul>
          ${visibles.length < lista.length ? html`<button class="boton-texto" type="button" data-abrir="${c}">Ver ${lista.length - visibles.length} más</button>` : ""}
        </section>`;
      })}
    `);
  };

  contenido.onclick = (evento) => {
    const filtro = evento.target.closest("[data-filtro]");
    const abrir = evento.target.closest("[data-abrir]");
    if (filtro) {
      estadoHoy.filtro = filtro.dataset.filtro;
      dibujar();
    } else if (abrir) {
      estadoHoy.abiertas.add(abrir.dataset.abrir);
      dibujar();
    }
  };
  dibujar();
}

// ---------- Lector ----------

async function vistaLector(ruta) {
  if (!/^datos\/crudo\/[\w/.-]+\.md$/.test(ruta)) throw new Error("La dirección no corresponde a un artículo.");
  const { ficha, cuerpo } = separarFicha(await leerTexto(ruta));
  const texto = cuerpo
    .replace(/^\s*# .*\n/, "") // el título ya va en la cabecera
    .replace(/\n---\n\nSolo se obtuvo el extracto[\s\S]*$/, "");
  const extracto = ficha.extraccion === "extracto";
  pintar(html`
    <article class="lector">
      <a class="volver" href="#/hoy">← Hoy</a>
      <header>
        <p class="sobretitulo">${ficha.fuente}${ficha.categoria_inicial ? ` · ${ficha.categoria_inicial}` : ""}</p>
        <h1>${ficha.titulo}</h1>
        <p class="meta">${[ficha.autor, fechaLarga(ficha.fecha_publicacion, true), `${ficha.minutos_lectura} min de lectura`]
          .filter(Boolean).join(" · ")}</p>
        ${extracto ? html`<p class="aviso">Solo se obtuvo el extracto (${MOTIVOS_DE_EXTRACTO[ficha.motivo_extracto] || ficha.motivo_extracto}). El texto completo está en el original.</p>` : ""}
      </header>
      <div class="cuerpo">${seguro(markdownAHtml(texto))}</div>
      <footer class="pie-lector">
        <a class="boton" href="${ficha.url}" target="_blank" rel="noopener noreferrer">Abrir el original ↗</a>
        ${ficha.tambien_en?.length ? html`<p class="meta">También publicado en:</p>
          <ul class="tambien">${ficha.tambien_en.map((u) => html`<li><a href="${u}" target="_blank" rel="noopener noreferrer">${dominio(u)}</a></li>`)}</ul>` : ""}
        <p class="meta">Texto de la fuente, recolectado el ${fechaLarga(ficha.fecha_recoleccion)}. Calificar y guardar palabras llega en la siguiente etapa.</p>
      </footer>
    </article>
  `);
}

// ---------- Para leer ----------

const ORDEN_MOMENTO = { "Este trimestre": 0, "Este año": 1, "Siguiente trimestre": 2, "Algún día": 3 };

function itemLectura(l) {
  return html`<li class="lectura">
    <a class="articulo-titulo" href="${l.url}" target="_blank" rel="noopener noreferrer">${l.titulo}</a>
    <span class="meta">${l.autor}</span>
    <span class="insignias"><span class="insignia insignia-acento">${l.momento_final}</span><span class="insignia">${l.hoja_origen}</span>${l.horas_estimadas ? html`<span class="insignia">${l.horas_estimadas} h</span>` : ""}</span>
    ${l.por_que ? html`<p>${l.por_que}</p>` : ""}
  </li>`;
}

async function vistaParaLeer() {
  const { lecturas } = await leerJSON("catalogo/lecturas.json");
  const pendientes = lecturas
    .filter((l) => l.momento_final !== "Ya leído")
    .sort((a, b) => (ORDEN_MOMENTO[a.momento_final] ?? 9) - (ORDEN_MOMENTO[b.momento_final] ?? 9)
      || (a.horas_estimadas ?? 99) - (b.horas_estimadas ?? 99));
  pintar(html`
    <header class="encabezado-vista">
      <p class="sobretitulo">${pendientes.length} lecturas en la cola</p>
      <h1>Para leer</h1>
    </header>
    <p class="nota">Orden provisional: primero lo que marcaste para este trimestre y, dentro de cada momento, lo más corto.
      La prioridad con los cuatro criterios llega con la cola durable.</p>
    <label class="buscador">
      <span class="oculto">Buscar en la biblioteca</span>
      <input id="buscar" type="search" placeholder="Buscar por título, autor o tema" autocomplete="off">
    </label>
    <h2 id="titulo-lista">Las próximas 10</h2>
    <ul class="lista-lecturas" id="lista"></ul>
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
    const halladas = pendientes.filter((l) =>
      sinTildes([l.titulo, l.autor, l.por_que, ...(l.etiquetas || [])].join(" ")).includes(consulta));
    titulo.textContent = halladas.length ? `${halladas.length} en la biblioteca` : "Nada con ese texto";
    pintar(html`${halladas.slice(0, 40).map(itemLectura)}`, lista);
  };
  buscar.addEventListener("input", dibujar);
  dibujar();
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

// ---------- Vocabulario ----------

async function vistaVocabulario() {
  pintar(html`
    <header class="encabezado-vista">
      <p class="sobretitulo">Repaso del día</p>
      <h1>Vocabulario</h1>
    </header>
    <section class="vacio">
      <p>Aún no hay palabras guardadas.</p>
      <p class="meta">Cuando llegue la etapa del vocabulario, seleccionas una palabra en el lector y la guardas
        con su oración. Claude te da el significado en contexto y aquí repasas cinco minutos al día.</p>
    </section>
  `);
}

// ---------- Estado ----------

async function vistaEstado() {
  const { ultima, indice, articulos } = await ultimaRecoleccion();
  const [registroFallas, feeds] = await Promise.all([leerJSON(ultima.fallas), leerJSON("catalogo/feeds.json")]);
  const corrida = indice.corridas.at(-1);
  const fallas = registroFallas.corridas.at(-1).fallas;
  const porTipo = agrupar(fallas, (f) => f.tipo);
  const completos = articulos.filter((a) => a.extraccion === "completo").length;
  const minutos = Math.round((new Date(corrida.fin) - new Date(corrida.inicio)) / 60000);
  const conFeed = Object.values(feeds).filter((f) => f.feed).length;
  const { repo } = config();
  pintar(html`
    <header class="encabezado-vista">
      <p class="sobretitulo">Cómo va el sistema</p>
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
      <p>Cero: Claude todavía no se usa. El consumo aparece aquí desde la etapa 2.</p>
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
        <li>En <em>Permissions</em>, <em>Repository permissions</em>, pon <strong>Contents</strong> en <em>Read-only</em>.</li>
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
        ? "GitHub no aceptó el token para ese repositorio. Revisa que tenga acceso a mentor con Contents en lectura."
        : "No se pudo conectar con GitHub. Revisa tu conexión.";
      error.classList.remove("oculto");
    }
  });
}

// ---------- Navegación ----------

const VISTAS = {
  hoy: vistaHoy,
  leer: vistaLector,
  "para-leer": vistaParaLeer,
  radar: vistaRadar,
  vocabulario: vistaVocabulario,
  estado: vistaEstado,
  conectar: vistaConectar,
};

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

async function enrutar() {
  const [nombre = "hoy", ...resto] = location.hash.replace(/^#\/?/, "").split("/");
  if (rutaActual) posiciones[rutaActual] = window.scrollY;
  rutaActual = location.hash || "#/hoy";

  if (!modoLocal() && !config().token && nombre !== "conectar") {
    location.hash = "#/conectar";
    return;
  }
  const vista = VISTAS[nombre] ? nombre : "hoy";
  for (const enlace of document.querySelectorAll("[data-vista]")) {
    const activa = enlace.dataset.vista === vista || (vista === "leer" && enlace.dataset.vista === "hoy");
    enlace.toggleAttribute("aria-current", activa);
    if (activa) enlace.setAttribute("aria-current", "page");
  }
  contenido.onclick = null;
  contenido.innerHTML = '<p class="cargando">Cargando…</p>';
  try {
    await VISTAS[vista](decodeURIComponent(resto.join("/")));
  } catch (error) {
    console.error(error);
    mostrarError(error);
  }
  window.scrollTo(0, vista === "leer" ? 0 : posiciones[rutaActual] || 0);
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
