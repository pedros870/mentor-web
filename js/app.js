// Mentor: la interfaz de lectura. Una sola página con vistas por dirección
// (#/hoy, #/geografia, #/areas, #/sectores, #/p/…, #/h/…, #/leer/…, #/para-leer, #/cuaderno, #/estado…).
import { ErrorDeDatos, REPO_POR_DEFECTO, borrarConfig, config, guardarConfig, leerJSON, leerTexto, modoLocal } from "./datos.js";
import { enLinea, escapar, markdownAHtml, separarFicha } from "./markdown.js";
import { alCambiar, enviar, estadoDeEnvio, marcar, todasLasMarcas } from "./marcas.js";

const contenido = document.getElementById("contenido");

// Un aviso breve al pie de la pantalla, para confirmar que una marca quedó guardada.
let temporizadorAviso = null;
function avisar(texto) {
  const aviso = document.getElementById("aviso");
  aviso.textContent = texto;
  aviso.hidden = false;
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => { aviso.hidden = true; }, 2500);
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
const estadoResumen = { abierta: null };

async function leerResumen() {
  try {
    const puntero = await leerJSON("datos/resumenes/ultimo.json");
    return await leerJSON(puntero.json);
  } catch (error) {
    if (error instanceof ErrorDeDatos && error.estado === 404) return null;
    throw error;
  }
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

// Parte una sección en temas: cada párrafo empieza con lo que cambió, en
// negrita; eso es el titular y el resto es el detalle que se abre al tocarlo.
function temasDeSeccion(texto) {
  const grupos = [];
  let grupo = null;
  for (const bloque of texto.replace(/\r\n/g, "\n").split(/\n\s*\n/)) {
    let resto = bloque.trim();
    if (!resto) continue;
    const subtitulo = resto.match(/^#{1,6}\s+(.+)(?:\n|$)/);
    if (subtitulo) {
      grupo = { titulo: subtitulo[1].trim(), temas: [] };
      grupos.push(grupo);
      resto = resto.slice(subtitulo[0].length).trim();
      if (!resto) continue;
    }
    if (!grupo) {
      grupo = { titulo: null, temas: [] };
      grupos.push(grupo);
    }
    const negrita = resto.match(/^\*\*(.+?)\*\*\s*([\s\S]*)$/);
    if (negrita) {
      // Si el detalle sigue la frase del titular, se marca con puntos suspensivos.
      const detalle = /^[a-záéíóúñ(]/.test(negrita[2]) ? `… ${negrita[2]}` : negrita[2];
      grupo.temas.push({ titular: negrita[1], detalle });
    } else {
      const corte = resto.search(/[.!?](\s|$)/);
      grupo.temas.push(corte > 0
        ? { titular: resto.slice(0, corte + 1), detalle: resto.slice(corte + 1).trim() }
        : { titular: resto, detalle: "" });
    }
  }
  return grupos.filter((g) => g.temas.length);
}

function marcaDeLeido(lectura, archivo) {
  return lectura.leidos.has(archivo) ? html`<span class="leido" title="Leído">✓</span>` : "";
}

function itemTitular(t, lectura) {
  return html`<li><a class="articulo" href="${enlaceLector(t)}">
    <span class="articulo-titulo">${marcaDeLeido(lectura, t.archivo)}${t.titulo}</span>
    <span class="meta"><span class="insignia insignia-${t.recomendacion}">${RECOMENDACIONES[t.recomendacion]}</span> ${t.fuente} · ${t.minutos} min${t.fuentes_historia > 1 ? ` · historia de ${t.fuentes_historia} fuentes` : ""}</span>
    <span class="razon">${t.razon}</span>
  </a></li>`;
}

function pintarResumen(r, lectura, aviso) {
  const estaLista = (categoria) => lectura.listas.get(`${r.fecha}|${categoria}`) === true;
  const listas = r.categorias.filter((c) => estaLista(c.nombre)).length;
  const porCategoria = agrupar(r.titulares, (t) => t.categoria);
  const orden = (a, b) => ORDEN_RECOMENDACION[a.recomendacion] - ORDEN_RECOMENDACION[b.recomendacion]
    || b.relevancia - a.relevancia;

  const tema = (c, t) => {
    const preferencia = lectura.preferencias.get(`${r.fecha}|${c.nombre}|${t.titular}`);
    return html`<li><details class="tema">
      <summary>${seguro(enLinea(t.titular))}</summary>
      <div class="tema-detalle">
        ${seguro(markdownAHtml(t.detalle))}
        <div class="preferencias" data-categoria="${c.nombre}" data-tema="${t.titular}">
          <button class="chip" type="button" data-preferencia="mas" aria-pressed="${String(preferencia === "mas")}">Más de esto</button>
          <button class="chip" type="button" data-preferencia="menos" aria-pressed="${String(preferencia === "menos")}">Menos de esto</button>
        </div>
      </div>
    </details></li>`;
  };

  // Formato 2 (desde el 23 de octubre): un texto corrido por categoría y, debajo,
  // las noticias en que se apoya. El formato 1 partía el texto en temas.
  const cuerpoCorrido = (c) => {
    const preferencia = lectura.preferencias.get(`${r.fecha}|${c.nombre}|`);
    return html`<div class="cuerpo cuerpo-resumen">${seguro(markdownAHtml(c.texto))}</div>
      <h3 class="grupo">Las noticias</h3>
      <ul class="lista-compacta">${c.articulos.map((a) => html`<li><a href="${enlaceLector(a)}">
        <span class="articulo-titulo">${marcaDeLeido(lectura, a.archivo)}${a.titulo}</span>
        <span class="meta">${a.fuente} · ${a.minutos} min</span>
      </a></li>`)}</ul>
      <div class="preferencias" data-categoria="${c.nombre}" data-tema="">
        <button class="chip" type="button" data-preferencia="mas" aria-pressed="${String(preferencia === "mas")}">Más de esto</button>
        <button class="chip" type="button" data-preferencia="menos" aria-pressed="${String(preferencia === "menos")}">Menos de esto</button>
      </div>`;
  };

  // Formato 3 (desde el 23 de octubre): por tema, hallazgos que sintetizan lo
  // encontrado; los artículos de cada hallazgo quedan plegados para profundizar.
  const cuerpoHallazgos = (c) => {
    const preferencia = lectura.preferencias.get(`${r.fecha}|${c.nombre}|`);
    return html`${c.hallazgos.map((h) => html`<div class="hallazgo">
        <div class="cuerpo cuerpo-resumen">${seguro(markdownAHtml(h.texto))}</div>
        <details class="profundizar">
          <summary>${h.articulos.length === 1 ? "1 artículo" : `${h.articulos.length} artículos`} para profundizar</summary>
          <ul class="lista-compacta">${h.articulos.map((a) => html`<li><a href="${enlaceLector(a)}">
            <span class="articulo-titulo">${marcaDeLeido(lectura, a.archivo)}${a.titulo}</span>
            <span class="meta">${a.fuente} · ${a.minutos} min</span>
          </a></li>`)}</ul>
        </details>
      </div>`)}
      <div class="preferencias" data-categoria="${c.nombre}" data-tema="">
        <button class="chip" type="button" data-preferencia="mas" aria-pressed="${String(preferencia === "mas")}">Más de esto</button>
        <button class="chip" type="button" data-preferencia="menos" aria-pressed="${String(preferencia === "menos")}">Menos de esto</button>
      </div>`;
  };

  const seccion = (c) => {
    const hallazgos = Array.isArray(c.hallazgos);
    const corrido = !hallazgos && Array.isArray(c.articulos);
    const grupos = hallazgos || corrido ? [] : temasDeSeccion(c.texto);
    const lista = estaLista(c.nombre);
    const cuenta = hallazgos ? c.hallazgos.length : corrido ? c.articulos.length : grupos.reduce((n, g) => n + g.temas.length, 0);
    const unidad = hallazgos ? (cuenta === 1 ? "hallazgo" : "hallazgos")
      : corrido ? (cuenta === 1 ? "noticia" : "noticias") : (cuenta === 1 ? "tema" : "temas");
    return html`<details class="seccion${lista ? " lista" : ""}" name="secciones" data-categoria="${c.nombre}" ${estadoResumen.abierta === c.nombre ? "open" : ""}>
      <summary>
        <span class="seccion-titulo">${lista ? "✓ " : ""}${c.nombre}</span>
        <span class="meta">${cuenta} ${unidad}</span>
      </summary>
      <div class="seccion-cuerpo">
        ${hallazgos ? cuerpoHallazgos(c) : corrido ? cuerpoCorrido(c)
          : grupos.map((g) => html`${g.titulo ? html`<h3 class="grupo">${g.titulo}</h3>` : ""}<ul class="temas">${g.temas.map((t) => tema(c, t))}</ul>`)}
        <div class="acciones">
          <button class="boton" type="button" data-lista="${c.nombre}">${lista ? "Volver a pendiente" : "Listo"}</button>
        </div>
      </div>
    </details>`;
  };

  pintar(html`
    <header class="encabezado-vista">
      <p class="sobretitulo">Resumen del ${fechaLarga(r.fecha)} · formato anterior</p>
      <h1>Resumen de la mañana</h1>
      <a class="aviso-nuevo" href="#/hoy">Volver a Hoy →</a>
      <div class="progreso">
        <progress max="${r.categorias.length}" value="${listas}"></progress>
        <span class="meta">${listas === r.categorias.length ? "Todo listo" : `${listas} de ${r.categorias.length} listas`} · unos ${r.minutos} min</span>
      </div>
    </header>
    ${aviso && aviso.generado > r.generado ? html`<p class="aviso">${aviso.texto}</p>` : ""}
    ${r.importante?.length ? html`<section class="importante">
      <h2>Lo importante hoy</h2>
      <ol>${r.importante.map((i) => html`<li>
        <p>${seguro(enLinea(i.texto))}</p>
        <details class="profundizar">
          <summary>${i.fuentes > 1 ? `${i.fuentes} fuentes` : "1 fuente"} · ver ${i.articulos.length === 1 ? "el artículo" : `${i.articulos.length} artículos`}</summary>
          <ul class="lista-compacta">${i.articulos.map((a) => html`<li><a href="${enlaceLector(a)}">
            <span class="articulo-titulo">${marcaDeLeido(lectura, a.archivo)}${a.titulo}</span>
            <span class="meta">${a.fuente} · ${a.minutos} min</span>
          </a></li>`)}</ul>
        </details>
      </li>`)}</ol>
    </section>` : ""}
    ${r.aviso_noche ? (r.aviso_noche_archivo
      ? html`<a class="aviso-noche" href="${enlaceLector({ archivo: r.aviso_noche_archivo })}">${marcaDeLeido(lectura, r.aviso_noche_archivo)}${r.aviso_noche} <span class="leer-ahora">Leer →</span></a>`
      : html`<p class="aviso-noche">${r.aviso_noche}</p>`) : ""}
    ${r.lecturas_del_dia.length ? html`<section class="lecturas-del-dia">
      <h2>Para leer completo</h2>
      <ul class="lista-compacta">${r.lecturas_del_dia.map((l) => html`<li><a href="${enlaceLector(l)}">
        <span class="articulo-titulo">${marcaDeLeido(lectura, l.archivo)}${l.titulo}</span>
        <span class="meta">${l.fuente} · ${l.minutos} min</span>
      </a></li>`)}</ul>
    </section>` : ""}
    <section class="secciones">${r.categorias.map(seccion)}</section>
    <details class="tarjeta titulares">
      <summary>Todos los titulares <span class="cuenta">${numero(r.titulares.length)}</span></summary>
      <p class="nota">Cada artículo revisado, con la recomendación de Claude. Lo que conviene saltar queda plegado.</p>
      ${CATEGORIAS.filter((c) => porCategoria.has(c)).map((c) => {
        const todos = porCategoria.get(c);
        const destacados = todos.filter((t) => t.recomendacion !== "saltar").sort(orden);
        const saltar = todos.filter((t) => t.recomendacion === "saltar").sort(orden);
        return html`<details class="grupo-titulares">
          <summary>${c} <span class="cuenta">${destacados.length} de ${todos.length}</span></summary>
          <ul class="lista-articulos">${destacados.map((t) => itemTitular(t, lectura))}</ul>
          ${saltar.length ? html`<button class="boton-texto" type="button" data-saltos>Ver ${saltar.length} para saltar</button>
            <ul class="lista-articulos" hidden>${saltar.map((t) => itemTitular(t, lectura))}</ul>` : ""}
        </details>`;
      })}
    </details>
    <p class="nota">${r.autor}. ${r.nota || ""}</p>
  `);

  contenido.onclick = (evento) => {
    const saltos = evento.target.closest("[data-saltos]");
    const botonLista = evento.target.closest("[data-lista]");
    const preferencia = evento.target.closest("[data-preferencia]");
    if (saltos) {
      saltos.nextElementSibling.hidden = false;
      saltos.remove();
    } else if (botonLista) {
      const categoria = botonLista.dataset.lista;
      const nueva = !estaLista(categoria);
      marcar({ tipo: "categoria", resumen: r.fecha, categoria, estado: nueva ? "lista" : "pendiente" });
      lectura.listas.set(`${r.fecha}|${categoria}`, nueva);
      // Al terminar una categoría se abre la siguiente pendiente.
      const siguiente = r.categorias.find((c) => !estaLista(c.nombre));
      estadoResumen.abierta = nueva ? siguiente?.nombre ?? null : categoria;
      pintarResumen(r, lectura);
      avisar(nueva ? `${categoria}: lista` : `${categoria}: pendiente`);
      contenido.querySelector("details.seccion[open]")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (preferencia) {
      const grupo = preferencia.parentElement;
      const clave = `${r.fecha}|${grupo.dataset.categoria}|${grupo.dataset.tema}`;
      const valor = lectura.preferencias.get(clave) === preferencia.dataset.preferencia ? null : preferencia.dataset.preferencia;
      lectura.preferencias.set(clave, valor);
      marcar({ tipo: "preferencia", resumen: r.fecha, categoria: grupo.dataset.categoria, tema: grupo.dataset.tema, valor });
      for (const boton of grupo.querySelectorAll("[data-preferencia]")) {
        boton.setAttribute("aria-pressed", String(boton.dataset.preferencia === valor));
      }
      avisar(valor === "mas" ? "Anotado: más de esto" : valor === "menos" ? "Anotado: menos de esto" : "Preferencia quitada");
    }
  };
  // Recordar qué sección quedó abierta, para volver a ella desde el lector.
  for (const detalle of contenido.querySelectorAll("details.seccion")) {
    detalle.addEventListener("toggle", () => {
      if (detalle.open) estadoResumen.abierta = detalle.dataset.categoria;
      else if (estadoResumen.abierta === detalle.dataset.categoria) estadoResumen.abierta = null;
    });
  }
}

// ---------- Hoy sin resumen: los titulares recolectados ----------

const estadoHoy = { filtro: "todas", abiertas: new Set() };
const VISIBLES_POR_CATEGORIA = 6;

async function vistaHoy(categoria) {
  if (categoria) estadoResumen.abierta = categoria; // #/hoy/<categoría> abre esa sección
  const resumen = await leerResumen();
  if (resumen) {
    // Si el último intento no pudo escribir resumen (por ejemplo, sin créditos), se avisa.
    const aviso = await leerJSON("datos/resumenes/aviso.json").catch(() => null);
    pintarResumen(resumen, await estadoDeLectura(), aviso);
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
  if (!/^datos\/(crudo|biblioteca)\/[\w/.-]+\.md$/.test(ruta)) throw new Error("La dirección no corresponde a un artículo.");
  const deLaBiblioteca = ruta.startsWith("datos/biblioteca/");
  const { ficha, cuerpo } = separarFicha(await leerTexto(ruta));
  const texto = cuerpo
    .replace(/^\s*# .*\n/, "") // el título ya va en la cabecera
    .replace(/\n---\n\nSolo se obtuvo el extracto[\s\S]*$/, "");
  const extracto = ficha.extraccion === "extracto";
  const [resumen, lectura, cuadernoLector] = await Promise.all([leerResumen().catch(() => null), estadoDeLectura(),
    leerCuaderno().catch(() => [])]);
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
        <p class="meta">${[ficha.autor, fechaLarga(ficha.fecha_publicacion, true), `${ficha.minutos_lectura} min de lectura`]
          .filter(Boolean).join(" · ")}</p>
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
  document.getElementById("guardar-nota").addEventListener("click", () => {
    const texto = document.getElementById("nota").value.trim();
    marcar({ tipo: "nota", archivo: ruta, texto });
    avisar(texto ? "Nota guardada" : "Nota borrada");
  });
}

// ---------- Fuentes: el catálogo de Pedro, por tema y con su estado ----------

const TEMAS_DE_FUENTE = [...CATEGORIAS, "Varios temas"];
const ESTADOS = { resume: "Se resume", consulta: "Consulta", fuera: "Fuera" };
const estadoFuentes = { filtro: "todas", buscar: "", abiertos: new Set() };

function pestanasDeFuentes(activa) {
  return html`<div class="segmentos" role="tablist">
    <a role="tab" href="#/fuentes" aria-selected="${String(activa === "fuentes")}">Tus fuentes</a>
    <a role="tab" href="#/fuentes/articulos" aria-selected="${String(activa === "articulos")}">Artículos del resumen</a>
  </div>`;
}

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
  if (subvista === "articulos") {
    await vistaClasificacion();
    return;
  }
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
    ${pestanasDeFuentes("fuentes")}
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

// ---------- Clasificación: qué hizo Claude con cada artículo ----------

const estadoClasificacion = { recomendacion: "todas", categoria: "todas", buscar: "", visibles: 60 };

async function vistaClasificacion() {
  const resumen = await leerResumen();
  if (!resumen) {
    pintar(html`<section class="vacio"><p>Todavía no hay clasificación.</p>
      <p class="meta">Aparece con el primer resumen de la mañana.</p></section>`);
    return;
  }
  const lectura = await estadoDeLectura();
  const detalle = resumen.clasificacion
    ? new Map((await leerJSON(resumen.clasificacion)).articulos.map((a) => [a.archivo, a])) : new Map();
  // A qué parte del resumen fue cada artículo.
  const destino = new Map();
  for (const c of resumen.categorias) {
    // El formato 1 guardaba las citas como "citados"; el formato 2, como "articulos".
    const usados = c.articulos ? c.articulos.map((a) => a.archivo) : c.citados || [];
    for (const archivo of usados) destino.set(archivo, c.nombre);
  }
  for (const l of resumen.lecturas_del_dia) destino.set(l.archivo, destino.get(l.archivo) || "Lecturas del día");
  if (resumen.aviso_noche_archivo) {
    destino.set(resumen.aviso_noche_archivo, destino.get(resumen.aviso_noche_archivo) || "Para la noche");
  }
  const articulos = resumen.titulares.map((t) => ({ ...detalle.get(t.archivo), ...t, destino: destino.get(t.archivo) }));
  const cuenta = (rec) => articulos.filter((a) => a.recomendacion === rec).length;
  const categorias = CATEGORIAS.filter((c) => articulos.some((a) => a.categoria === c));

  const fila = (a) => html`<li class="clasificado">
    <a class="articulo-titulo" href="${enlaceLector(a)}">${marcaDeLeido(lectura, a.archivo)}${a.titulo}</a>
    <span class="meta">${a.fuente} · ${a.minutos} min</span>
    <span class="insignias">
      <span class="insignia insignia-${a.recomendacion}">${RECOMENDACIONES[a.recomendacion]}</span>
      <span class="insignia">${a.categoria}${a.sector ? ` · ${a.sector}` : ""}</span>
      ${a.tipo ? html`<span class="insignia">${a.tipo}</span>` : ""}
    </span>
    ${a.novedad ? html`<span class="meta">Relevancia ${a.relevancia} · Novedad ${a.novedad} · Impacto ${a.impacto}</span>` : ""}
    <span class="razon">${a.razon}</span>
    <span class="${a.destino ? "destino" : "destino destino-fuera"}">${a.destino ? `→ En el resumen: ${a.destino}` : "No entró al texto del resumen"}</span>
  </li>`;

  const dibujarLista = () => {
    const consulta = sinTildes(estadoClasificacion.buscar);
    const elegidos = articulos.filter((a) =>
      (estadoClasificacion.recomendacion === "todas" || a.recomendacion === estadoClasificacion.recomendacion)
      && (estadoClasificacion.categoria === "todas" || a.categoria === estadoClasificacion.categoria)
      && (!consulta || sinTildes(`${a.titulo} ${a.fuente} ${a.razon} ${a.subtema || ""}`).includes(consulta)))
      .sort((a, b) => ORDEN_RECOMENDACION[a.recomendacion] - ORDEN_RECOMENDACION[b.recomendacion] || b.relevancia - a.relevancia);
    const visibles = elegidos.slice(0, estadoClasificacion.visibles);
    pintar(html`
      <p class="meta">${numero(elegidos.length)} ${elegidos.length === 1 ? "artículo" : "artículos"}</p>
      <ul class="lista-clasificacion">${visibles.map(fila)}</ul>
      ${visibles.length < elegidos.length ? html`<button class="boton-texto" type="button" id="ver-mas">Ver ${Math.min(60, elegidos.length - visibles.length)} más</button>` : ""}
    `, document.getElementById("lista-clasificacion"));
    document.getElementById("ver-mas")?.addEventListener("click", () => {
      estadoClasificacion.visibles += 60;
      dibujarLista();
    });
  };

  pintar(html`
    <header class="encabezado-vista">
      <p class="sobretitulo">Resumen del ${fechaLarga(resumen.fecha)}</p>
      <h1>Fuentes</h1>
      <p class="meta">Lo que Claude decidió con cada uno de los ${numero(articulos.length)} artículos revisados y a qué parte del resumen fue.</p>
    </header>
    ${pestanasDeFuentes("articulos")}
    <div class="chips" role="group" aria-label="Filtrar por recomendación">
      ${["todas", "leer", "resumen", "saltar"].map((rec) => html`<button class="chip" type="button" data-recomendacion="${rec}" aria-pressed="${String(estadoClasificacion.recomendacion === rec)}">${rec === "todas" ? "Todas" : RECOMENDACIONES[rec]} <span>${rec === "todas" ? articulos.length : cuenta(rec)}</span></button>`)}
    </div>
    <div class="filtros">
      <label><span class="oculto">Categoría</span>
        <select id="categoria">
          <option value="todas">Todas las categorías</option>
          ${categorias.map((c) => html`<option value="${c}" ${estadoClasificacion.categoria === c ? "selected" : ""}>${c}</option>`)}
        </select>
      </label>
      <label class="buscador"><span class="oculto">Buscar</span>
        <input id="buscar-clasificacion" type="search" placeholder="Buscar título, fuente o razón" autocomplete="off" value="${estadoClasificacion.buscar}">
      </label>
    </div>
    <div id="lista-clasificacion"></div>
  `);
  contenido.onclick = (evento) => {
    const chip = evento.target.closest("[data-recomendacion]");
    if (!chip) return;
    estadoClasificacion.recomendacion = chip.dataset.recomendacion;
    estadoClasificacion.visibles = 60;
    for (const otro of contenido.querySelectorAll("[data-recomendacion]")) otro.setAttribute("aria-pressed", String(otro === chip));
    dibujarLista();
  };
  document.getElementById("categoria").addEventListener("change", (evento) => {
    estadoClasificacion.categoria = evento.target.value;
    estadoClasificacion.visibles = 60;
    dibujarLista();
  });
  document.getElementById("buscar-clasificacion").addEventListener("input", (evento) => {
    estadoClasificacion.buscar = evento.target.value.trim();
    estadoClasificacion.visibles = 60;
    dibujarLista();
  });
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

function itemLectura({ l, destino, guardada, leida, segundo }) {
  const abrir = (clase, texto) => destino
    ? html`<a class="${clase}" href="${destino.href}"${destino.externo ? html` target="_blank" rel="noopener noreferrer"` : ""}>${texto}</a>`
    : html`<span class="${clase}">${texto}</span>`;
  const duracion = guardada?.minutos_lectura ? `${guardada.minutos_lectura} min` : l.horas_estimadas ? `${l.horas_estimadas} h` : "";
  return html`<li class="lectura">
    ${abrir("articulo-titulo", l.titulo)}
    <span class="meta">${[l.autor, duracion].filter(Boolean).join(" · ")}</span>
    <span class="insignias"><span class="insignia">${l.momento_final}</span><span class="insignia">${l.hoja_origen}</span>${destino?.acceso ? html`<span class="insignia${destino.acceso === "aqui" ? " insignia-acento" : ""}">${ACCESOS[destino.acceso]}</span>` : ""}</span>
    ${l.por_que ? html`<p>${l.por_que}</p>` : ""}
    <div class="acciones-lectura">
      ${destino ? abrir("boton-secundario", `${destino.accion}${destino.externo ? " ↗" : ""}`) : ""}
      ${segundo ? html`<a class="boton-secundario" href="${segundo}" target="_blank" rel="noopener noreferrer">Otro texto ↗</a>` : ""}
      <button class="boton-secundario" type="button" data-leida="${l.id}" aria-pressed="${String(leida)}">${leida ? "✓ Leída" : "Lo leí"}</button>
    </div>
  </li>`;
}

async function vistaParaLeer() {
  const [{ lecturas }, { enlaces }, biblioteca, consolidado, lectura, guardadas] = await Promise.all([
    leerJSON("catalogo/lecturas.json"),
    leerJSON("catalogo/lecturas_enlaces.json").catch(() => ({ enlaces: {} })),
    leerJSON("datos/biblioteca/indice.json").catch(() => ({})),
    leerJSON("datos/biblioteca/estado.json").catch(() => ({})),
    estadoDeLectura(),
    piezasGuardadas(),
  ]);
  // Leída si lo dice la biblioteca (que junta las marcas de cada noche) o una marca reciente.
  const leida = (l) => {
    const archivo = biblioteca[l.id]?.archivo;
    const reciente = [`lectura:${l.id}`, archivo].find((clave) => clave && lectura.marcadas.has(clave));
    return reciente ? lectura.leidos.has(reciente) : Boolean(consolidado[l.id]?.leida);
  };
  const conDestino = (l) => ({ l, destino: destinoDeLectura(l, enlaces[l.id], biblioteca[l.id]), guardada: biblioteca[l.id],
    segundo: enlaces[l.id]?.enlace_2, leida: false });
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
    ${guardadas.size ? html`<section class="guardadas">
      <h2>Guardadas desde las noticias <span class="cuenta">${guardadas.size}</span></h2>
      <ul class="lista-lecturas" id="guardadas">${[...guardadas].reverse().map(([archivo, g]) => html`<li class="lectura">
        <a class="articulo-titulo" href="${enlaceLector({ archivo })}">${g.titulo}</a>
        <span class="meta">${[g.fuente, g.minutos ? `${g.minutos} min` : "", g.fecha ? `guardada el ${fechaCorta(g.fecha)}` : ""].filter(Boolean).join(" · ")}</span>
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

const CLASES_CUADERNO = { pregunta: "Pregunta", palabra: "Palabra", pedido: "Pedido para Mentor" };
const ESTADOS_RESPUESTA = { hecho: "Hecho", en_curso: "En curso", descartado: "Descartado" };
const INVITACIONES = {
  pregunta: "Tu pregunta para Claude…",
  palabra: "La palabra o la frase…",
  pedido: "Qué quieres que cambie o se agregue en Mentor…",
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

const pendienteHilo = (hilo) => !hilo.at(-1).respuestas.length;

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
    <button class="boton" type="submit">Dejar en el Cuaderno</button>
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

async function vistaCuaderno() {
  const [entradas, { visitas }] = await Promise.all([leerCuaderno(), marcasV2()]);
  const desde = visitas.get("cuaderno");
  const hilos = hilosDe(entradas).sort((a, b) => b.at(-1).ts.localeCompare(a.at(-1).ts));
  const activos = hilos.filter((x) => !x[0].archivada);
  const pendientes = activos.filter(pendienteHilo);
  const respondidos = (clase) => activos.filter((x) => x[0].clase === clase && !pendienteHilo(x));
  const archivados = hilos.filter((x) => x[0].archivada);
  const seccion = (titulo, lista, vacio) => html`<section class="seccion-cuaderno">
    <h2>${titulo} <span class="cuenta">${lista.length}</span></h2>
    ${lista.length ? lista.map((x) => hilo(x, { desde })) : html`<p class="nota">${vacio}</p>`}
  </section>`;
  pintar(html`
    <header class="encabezado-vista">
      <p class="sobretitulo">Lo que conversamos</p>
      <h1>Cuaderno</h1>
      <p class="meta">Lo que dejes aquí, en una noticia o en el lector, lo responde Claude en la próxima sesión de Claude Code
        (escribe <strong>/cuaderno</strong>). No gasta API y todo queda guardado.</p>
    </header>
    <section class="tarjeta">${formularioCuaderno({ conClase: true })}</section>
    ${pendientes.length ? seccion("Por responder", pendientes, "") : ""}
    ${seccion("Preguntas", respondidos("pregunta"), "Las preguntas que le hagas a Claude sobre una noticia aparecen aquí con su respuesta.")}
    ${seccion("Vocabulario", respondidos("palabra"), "En el lector, selecciona una palabra o una frase y toca \"Guardar en vocabulario\". El repaso diario llega cuando haya palabras.")}
    ${seccion("Pedidos para Mentor", respondidos("pedido"), "Lo que quieras cambiar o agregar en Mentor.")}
    ${archivados.length ? html`<details class="mas"><summary>Archivado (${archivados.length})</summary>
      ${archivados.map((x) => hilo(x))}</details>` : ""}
  `);
  marcar({ tipo: "visita", pagina: "cuaderno" });
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

// En el lector, al seleccionar una palabra o una frase aparece "Guardar en vocabulario".
const botonPalabra = document.createElement("button");
botonPalabra.type = "button";
botonPalabra.className = "boton-palabra";
botonPalabra.textContent = "Guardar en vocabulario";
botonPalabra.hidden = true;
document.body.append(botonPalabra);
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
  if (!cuerpo || !texto || texto.length > 80 || !sel.rangeCount || !cuerpo.contains(sel.anchorNode)) {
    botonPalabra.hidden = true;
    return;
  }
  const rango = sel.getRangeAt(0);
  const caja = rango.getBoundingClientRect();
  seleccion = { texto, oracion: oracionDe(rango, texto) };
  botonPalabra.style.top = `${window.scrollY + caja.bottom + 10}px`;
  botonPalabra.style.left = `${Math.max(8, Math.min(window.scrollX + caja.left, document.documentElement.clientWidth - 210))}px`;
  botonPalabra.hidden = false;
});
botonPalabra.addEventListener("pointerdown", (evento) => evento.preventDefault()); // que no se pierda la selección
botonPalabra.addEventListener("click", () => {
  const lector = contenido.querySelector(".lector");
  if (!seleccion || !lector) return;
  marcar({ tipo: "cuaderno", clase: "palabra", texto: seleccion.texto, oracion: seleccion.oracion,
    archivo: lector.dataset.archivo, titulo: lector.dataset.titulo });
  avisar(`"${seleccion.texto}" quedó en el Cuaderno`);
  document.getSelection().removeAllRanges();
  botonPalabra.hidden = true;
});

// ---------- Estado ----------

async function vistaEstado() {
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
      ${costos
        ? html`<p><strong>${costos.total_usd.toLocaleString("es-CO", { style: "currency", currency: "USD" })}</strong>
            de ${(costos.tope_usd || 95).toLocaleString("es-CO", { style: "currency", currency: "USD" })} de créditos ·
            ${numero(costos.llamadas)} llamadas a Claude</p>
          <progress class="gasto" max="${costos.tope_usd || 95}" value="${costos.total_usd}"></progress>
          <p class="meta">Se paga con los créditos mensuales de tu plan Max. Si llega al tope, Claude deja de organizar las noticias y la recolección sigue.</p>`
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
const ESTADOS_HISTORIA = { nueva: "Nueva", actualizada: "Con novedades", aldia: "Al día" };
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

// ---------- Geografía, Áreas y Sectores: subpestañas en el formato de Hoy ----------
// Cada subpestaña (una región, un área o un sector) abre como Hoy: lo relevante numerado, que no
// repite lo de Hoy, el resto de las noticias del día y para profundizar. Lo que ya está en Hoy y
// lo que ya abriste en otro lado van al final, apagados. Los países y las tecnologías son filtros.

async function vistaPestanas(clave, ruta) {
  const grupo = GRUPOS[clave];
  const [slugPestana, filtro] = (ruta || "").split("/");
  const indice = await leerJSON("datos/v2/indice.json");
  const pestanas = indice.pestanas.filter((p) => p.grupo === grupo);
  const elegida = pestanas.find((p) => p.slug === slugPestana) || pestanas[0];
  const [pestana, { visitas, leidas }, guardadas] = await Promise.all([
    leerJSON(`datos/v2/pestanas/${elegida.pestana}.json`), marcasV2(), piezasGuardadas(), cargarHilosPorHistoria()]);
  const paginas = Object.fromEntries(indice.paginas.map((t) => [t.pagina, t]));
  const varias = pestana.hojas.length > 1;
  const hoja = varias && pestana.hojas.includes(filtro) ? filtro : null;
  const deLaHoja = (x) => !hoja || x.hoja === hoja;

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
          <h1>Lo relevante en ${hoja ? paginas[hoja].filtro || paginas[hoja].nombre : pestana.nombre}</h1>
          ${deOtroDia ? html`<p class="meta">Escrito el ${fechaLarga(pestana.fecha_relevante)}</p>` : ""}
        </header>
        ${varias ? html`<div class="filtros-pestana">
          <a class="chip" href="${base}" aria-current="${hoja ? "false" : "page"}">Todo</a>
          ${pestana.hojas.map((pid) => html`<a class="chip${paginas[pid].hoy ? "" : " sin-hoy"}" href="${base}/${pid}"
            aria-current="${pid === hoja ? "page" : "false"}">${paginas[pid].filtro || paginas[pid].nombre}${paginas[pid].hoy ? html`<span>${paginas[pid].hoy}</span>` : ""}</a>`)}
        </div>` : ""}
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
  marcar({ tipo: "visita", pagina: hoja || pestana.pestana });
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
    <p class="enlaces-noticia"><a href="${enlaceHistoria(h.id)}">Línea de tiempo, personas y conexiones →</a>${
      pagina ? html` <a href="${enlacePagina(pagina.pagina)}">Más de ${pagina.nombre} →</a>` : ""}</p>
  </div>`;
}

// Con marca ("En Hoy", "Ya la leíste"), la noticia sale apagada y señalada.
function noticia(h, visto, { titulo, pagina, conFecha, marca } = {}) {
  const estado = visto ? estadoDeHistoria(h, visto) : null;
  const meta = [fuentesTexto(h.fuentes.length), pagina?.nombre, conFecha ? fechaCorta(h.actualizada) : ""].filter(Boolean).join(" · ");
  return html`<details class="noticia${marca ? " apagada" : ""}" data-historia="${h.id}">
    <summary>
      <span class="noticia-titulo">${titulo || h.titulo}</span>
      <span class="noticia-meta">${marca ? html`<span class="insignia insignia-vista">${marca}</span>`
        : estado && estado !== "aldia" ? html`<span class="insignia insignia-${estado}">${ESTADOS_HISTORIA[estado]}</span>` : ""}${meta}</span>
    </summary>
    ${cuerpoNoticia(h, visto, pagina)}
  </details>`;
}

const botonGuardar = (archivo, guardada) => html`<button class="boton-secundario" type="button" data-guardar="${archivo}"
  aria-pressed="${String(guardada)}">${guardada ? "✓ En Para leer" : "Guardar en Para leer"}</button>`;

function columnaProfundizar(lista, guardadas, nombres) {
  return html`<aside class="lateral">
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

// ---------- Hoy ----------

async function vistaHoyV2() {
  const [inicio, indice, { visitas, leidas }, guardadas] = await Promise.all([
    leerJSON("datos/v2/inicio.json"), leerJSON("datos/v2/indice.json"), marcasV2(), piezasGuardadas(), cargarHilosPorHistoria()]);
  const paginas = Object.fromEntries(indice.paginas.map((t) => [t.pagina, t]));
  const nombres = Object.fromEntries(indice.paginas.map((t) => [t.pagina, t.nombre]));
  pintar(html`
    <div class="dos-columnas">
      <div class="principal">
        <header class="encabezado-vista">
          <p class="sobretitulo">${fechaLarga(inicio.dia)}</p>
          <h1>Lo relevante hoy</h1>
        </header>
        ${inicio.relevante.length ? html`<ol class="relevante">${inicio.relevante.map((r) => html`<li>${noticia(r.detalle,
          masReciente(leidas.get(r.historia), visitas.get(r.detalle.hoja)), { titulo: r.texto, pagina: paginas[r.detalle.hoja] })}</li>`)}</ol>`
          : html`<p class="nota">Hoy no se escribió lo relevante. Las noticias están en Geografía, Áreas y Sectores.</p>`}
        <p class="nota pie-hoy"><a href="#/anterior">Los resúmenes del formato anterior</a></p>
      </div>
      ${columnaProfundizar(inicio.profundizar, guardadas, nombres)}
    </div>
  `);
  escucharNoticias(inicio.profundizar, guardadas);
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
    cargarHilosPorHistoria()]);
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
          <h1>${h.titulo}</h1>
          <p class="meta">${h.estado === "activa" ? "Activa" : "Cerrada"} desde el ${fechaCorta(h.creada)} · ${fuentesTexto(h.fuentes.length)} · última novedad: ${fechaLarga(h.actualizada, true)}</p>
        </header>
        ${nuevas.length ? html`<section class="nuevo-desde destacado">
          <p class="grupo">Nuevo desde que la leíste (${fechaLarga(visto, true)})</p>
          <ul>${nuevas.flatMap((a) => a.textos.map((t) => html`<li>${t}</li>`))}</ul>
        </section>` : ""}
        <section>
          <div class="cuerpo">${seguro(markdownAHtml(h.sintesis))}</div>
          ${h.lectura_claude ? html`<p class="lectura-claude"><em>Lectura de Claude: ${h.lectura_claude}</em></p>` : ""}
        </section>
        ${h.que_sigue.length ? html`<section><h2>Qué sigue</h2>
          <ul class="que-sigue">${h.que_sigue.map((q) => html`<li><strong>${q.cuando}:</strong> ${q.que}</li>`)}</ul></section>` : ""}
        <section class="preguntas-historia"><h2>Pregúntale a Claude</h2>${preguntarSobre(h)}</section>
        <section><h2>Las piezas (${piezas.length})</h2>
          <ul class="lista-compacta">${piezas.map((p) => html`<li><a href="${enlaceLector(p)}">
            <span class="insignia insignia-${p.recomendacion}">${RECOMENDACIONES[p.recomendacion]}</span>
            <span class="articulo-titulo">${p.titulo}</span>
            <span class="meta">${p.fuente} · ${fechaCorta(p.fecha)}${p.minutos ? ` · ${p.minutos} min` : ""}</span></a></li>`)}</ul>
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
  marcar({ tipo: "historia_leida", historia: id });
}

async function vistaEntidad(id) {
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

const VISTAS = {
  hoy: vistaHoyV2,
  geografia: (ruta) => vistaPestanas("geografia", ruta),
  areas: (ruta) => vistaPestanas("areas", ruta),
  sectores: (ruta) => vistaPestanas("sectores", ruta),
  p: vistaPagina,
  h: vistaHistoria,
  e: vistaEntidad,
  nuevo: vistaNuevo,
  anterior: vistaHoy,
  leer: vistaLector,
  fuentes: vistaFuentes,
  clasificacion: () => vistaFuentes("articulos"),
  "para-leer": vistaParaLeer,
  "para-ver": vistaParaVer,
  radar: vistaRadar,
  cuaderno: vistaCuaderno,
  vocabulario: vistaCuaderno,
  estado: vistaEstado,
  conectar: vistaConectar,
};
// Las vistas que usan el ancho del computador; las demás quedan en una columna de lectura.
const VISTAS_ANCHAS = new Set(["hoy", "geografia", "areas", "sectores", "p", "h", "e"]);
// Qué sección de la barra se ilumina en las vistas que no tienen la suya.
const NAVEGACION_DE = { leer: "hoy", anterior: "hoy", nuevo: "hoy", clasificacion: "fuentes", vocabulario: "cuaderno" };

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
  resaltar(NAVEGACION_DE[vista] || vista);
  contenido.classList.toggle("amplio", VISTAS_ANCHAS.has(vista));
  contenido.onclick = null;
  contenido.onchange = null;
  botonPalabra.hidden = true;
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
