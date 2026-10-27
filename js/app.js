// Mentor: la interfaz de lectura. Una sola página con vistas por dirección
// (#/hoy, #/leer/…, #/para-leer, #/radar, #/vocabulario, #/estado).
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
      <p class="sobretitulo">Resumen del ${fechaLarga(r.fecha)}</p>
      <h1>Hoy</h1>
      <a class="aviso-nuevo" href="#/nuevo">Probar el formato nuevo →</a>
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
  const [resumen, lectura] = await Promise.all([leerResumen().catch(() => null), estadoDeLectura()]);
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
    <article class="lector">
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
  const [{ lecturas }, { enlaces }, biblioteca, consolidado, lectura] = await Promise.all([
    leerJSON("catalogo/lecturas.json"),
    leerJSON("catalogo/lecturas_enlaces.json").catch(() => ({ enlaces: {} })),
    leerJSON("datos/biblioteca/indice.json").catch(() => ({})),
    leerJSON("datos/biblioteca/estado.json").catch(() => ({})),
    estadoDeLectura(),
  ]);
  // Leída si lo dice la biblioteca (que junta las marcas de cada noche) o una marca reciente.
  const leida = (l) => {
    const archivo = biblioteca[l.id]?.archivo;
    const reciente = [`lectura:${l.id}`, archivo].find((clave) => clave && lectura.marcadas.has(clave));
    return reciente ? lectura.leidos.has(reciente) : Boolean(consolidado[l.id]?.leida);
  };
  const conDestino = (l) => ({ l, destino: destinoDeLectura(l, enlaces[l.id], biblioteca[l.id]), guardada: biblioteca[l.id],
    segundo: enlaces[l.id]?.enlace_2, leida: false });
  const pendientes = lecturas
    .filter((l) => l.momento_final !== "Ya leído" && !leida(l))
    .sort((a, b) => (ORDEN_MOMENTO[a.momento_final] ?? 9) - (ORDEN_MOMENTO[b.momento_final] ?? 9)
      || (a.horas_estimadas ?? 99) - (b.horas_estimadas ?? 99))
    .map(conDestino);
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
    const halladas = pendientes.filter(({ l }) =>
      sinTildes([l.titulo, l.autor, l.por_que, ...(l.etiquetas || [])].join(" ")).includes(consulta));
    titulo.textContent = halladas.length ? `${halladas.length} en la biblioteca` : "Nada con ese texto";
    pintar(html`${halladas.slice(0, 40).map(itemLectura)}`, lista);
  };
  buscar.addEventListener("input", dibujar);
  // "Lo leí" deja la lectura en su sitio hasta la próxima visita, para poder deshacerlo.
  lista.addEventListener("click", (evento) => {
    const boton = evento.target.closest("[data-leida]");
    if (!boton) return;
    const p = pendientes.find(({ l }) => l.id === boton.dataset.leida);
    p.leida = !p.leida;
    marcar({ tipo: "leido", lectura: p.l.id, ...(p.guardada?.archivo ? { archivo: p.guardada.archivo } : {}), valor: p.leida });
    boton.setAttribute("aria-pressed", String(p.leida));
    boton.textContent = p.leida ? "✓ Leída" : "Lo leí";
    avisar(p.leida ? "Marcada como leída: sale de la cola" : "Vuelve a la cola");
  });
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
          <p class="meta">Se paga con los créditos mensuales de tu plan Max. Si llega al tope, el resumen se detiene y la recolección sigue.</p>`
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

// ---------- Formato nuevo (en prueba): historias, páginas y grafo latente ----------
// Lee datos/v2/, que escribe scripts/organizar.py. "Lo nuevo" se calcula contra la
// última visita a cada página y la última lectura de cada historia, que quedan como marcas.

const GRUPOS_V2 = ["Geografía", "Temas", "Sectores"];
const PAISES_EUROPA = ["Alemania", "Francia", "Reino Unido", "Italia", "España", "Unión Europea"];
const ESTADOS_HISTORIA = { nueva: "Nueva", actualizada: "Actualizada", aldia: "Al día" };

const despues = (a, b) => !b || new Date(a) > new Date(b);
const masReciente = (a, b) => (!a ? b : !b ? a : new Date(a) > new Date(b) ? a : b);
const enlaceHistoria = (id) => `#/nuevo/h/${encodeURIComponent(id)}`;
const enlacePagina = (pid) => `#/nuevo/p/${encodeURIComponent(pid)}`;
const enlaceEntidad = (id) => `#/nuevo/e/${encodeURIComponent(id)}`;
const fuentesTexto = (n) => (n === 1 ? "1 fuente" : `${n} fuentes`);
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

function estadoDeHistoria(h, visto) {
  if (!visto || despues(h.creada, visto)) return "nueva";
  return (h.cambios || h.actualizaciones.map((a) => a.momento)).some((m) => despues(m, visto)) ? "actualizada" : "aldia";
}

function primerParrafo(texto) {
  return (texto || "").split(/\n\s*\n/)[0];
}

function navegacionV2(activo) {
  return html`<nav class="segmentos cuatro" aria-label="Formato nuevo">
    <a href="#/nuevo" aria-selected="${String(activo === "inicio")}">Inicio</a>
    ${GRUPOS_V2.map((g) => html`<a href="#/nuevo/g/${encodeURIComponent(g)}" aria-selected="${String(activo === g)}">${g}</a>`)}
  </nav>`;
}

function contarNovedades(pagina, visto) {
  const estados = pagina.historias.map((h) => estadoDeHistoria(h, visto));
  return { nuevas: estados.filter((e) => e === "nueva").length, actualizadas: estados.filter((e) => e === "actualizada").length };
}

function filaDePagina(p, visitas) {
  const visto = visitas.get(p.pagina);
  const { nuevas, actualizadas } = contarNovedades(p, visto);
  const novedades = [nuevas && `${nuevas} nuevas`, actualizadas && `${actualizadas} actualizadas`].filter(Boolean).join(" · ");
  return html`<li><a class="fila-pagina" href="${enlacePagina(p.pagina)}">
    <span><span class="articulo-titulo">${p.nombre}</span>
      <span class="meta">${visto ? `Tu última visita: ${fechaLarga(visto, true)}` : "Sin visitar"} · ${p.historias.length} historias</span></span>
    ${novedades ? html`<span class="novedades">${novedades}</span>` : html`<span class="meta">Al día</span>`}
  </a></li>`;
}

async function vistaInicioV2() {
  const [inicio, indice, { visitas }] = await Promise.all([
    leerJSON("datos/v2/inicio.json"), leerJSON("datos/v2/indice.json"), marcasV2()]);
  const nombres = Object.fromEntries(indice.paginas.map((p) => [p.pagina, p.nombre]));
  const conMovimiento = indice.paginas
    .filter((p) => p.grupo !== "Sectores" && Object.values(contarNovedades(p, visitas.get(p.pagina))).some(Boolean))
    .sort((a, b) => b.historias.length - a.historias.length);
  pintar(html`
    <header class="encabezado-vista">
      <p class="sobretitulo">Formato nuevo · en prueba · ${fechaLarga(inicio.generado, true)}</p>
      <h1>Lo relevante hoy</h1>
    </header>
    ${navegacionV2("inicio")}
    <section class="importante">
      <ol>${inicio.relevante.map((r) => html`<li>
        <p><a class="enlace-sobrio" href="${enlaceHistoria(r.historia)}">${r.texto}</a></p>
        <p class="meta">${fuentesTexto(r.fuentes)} · <a href="${enlacePagina(r.pagina)}">${nombres[r.pagina] || r.pagina} →</a></p>
      </li>`)}</ol>
    </section>
    <section>
      <h2>Dónde hubo movimiento</h2>
      <p class="nota">Desde tu última visita a cada página.</p>
      <ul class="lista-paginas">${conMovimiento.map((p) => filaDePagina(p, visitas))}</ul>
    </section>
    ${inicio.profundizar.length ? html`<section class="lecturas-del-dia">
      <h2>Para profundizar</h2>
      <ul class="lista-compacta">${inicio.profundizar.map((l) => html`<li><a href="${enlaceLector(l)}">
        <span class="articulo-titulo">${l.titulo}</span>
        <span class="meta">${l.fuente} · ${l.minutos} min · ${nombres[l.pagina] || ""}</span>
        <span class="razon">${l.resumen}</span>
      </a></li>`)}</ul>
    </section>` : ""}
  `);
}

async function vistaGrupoV2(grupo) {
  const [indice, { visitas }] = await Promise.all([leerJSON("datos/v2/indice.json"), marcasV2()]);
  const paginas = indice.paginas.filter((p) => p.grupo === grupo);
  pintar(html`
    <header class="encabezado-vista">
      <p class="sobretitulo">Formato nuevo · en prueba</p>
      <h1>${grupo}</h1>
    </header>
    ${navegacionV2(grupo)}
    ${grupo === "Sectores" ? html`<p class="nota">Las historias de cualquier región o tema que tocan tus sectores.</p>` : ""}
    <ul class="lista-paginas">${paginas.map((p) => filaDePagina(p, visitas))}</ul>
  `);
}

function tarjetaHistoria(h, visto) {
  const estado = estadoDeHistoria(h, visto);
  const nuevas = estado === "actualizada" ? h.actualizaciones.filter((a) => despues(a.momento, visto)) : [];
  const antes = estado === "actualizada" ? h.actualizaciones.filter((a) => !despues(a.momento, visto)).at(-1) : null;
  return html`<article class="tarjeta historia">
    <p class="historia-meta"><span class="insignia insignia-${estado}">${ESTADOS_HISTORIA[estado]}</span>
      <span class="meta">${fuentesTexto(h.fuentes.length)} · ${h.piezas.length} piezas · desde el ${fechaCorta(h.creada)}</span></p>
    <h3><a class="enlace-sobrio" href="${enlaceHistoria(h.id)}">${h.titulo}</a></h3>
    ${estado === "nueva" ? html`<div class="cuerpo">${seguro(markdownAHtml(primerParrafo(h.sintesis)))}</div>` : ""}
    ${estado === "actualizada" ? html`
      ${antes ? html`<p class="ya-sabias"><strong>Ya lo sabías:</strong> ${antes.textos.join(" ")}</p>` : ""}
      <div class="nuevo-desde">
        <p class="grupo">Nuevo desde tu visita</p>
        <ul>${nuevas.flatMap((a) => a.textos.map((t) => html`<li><span class="meta">${fechaCorta(a.fecha)}</span> ${t}</li>`))}</ul>
      </div>` : ""}
    ${estado === "aldia" ? html`<p class="meta">✓ Sin novedades desde tu última visita.</p>` : ""}
    <p class="meta">${h.fuentes.join(" · ")}</p>
    <a class="boton-texto" href="${enlaceHistoria(h.id)}">Ver la historia completa →</a>
  </article>`;
}

const estadoPaginaV2 = { pais: "" };

async function vistaPaginaV2(pid) {
  const [pagina, { visitas }] = await Promise.all([leerJSON(`datos/v2/paginas/${pid}.json`), marcasV2()]);
  const visto = visitas.get(pid);
  const { nuevas, actualizadas } = contarNovedades({ historias: pagina.historias }, visto);
  const europa = pid === "europa";
  if (!europa) estadoPaginaV2.pais = "";
  const dibujar = () => {
    const historias = pagina.historias.filter((h) => !estadoPaginaV2.pais
      || (estadoPaginaV2.pais === "Otros" ? !PAISES_EUROPA.includes(h.pais) : h.pais === estadoPaginaV2.pais));
    pintar(html`
      <header class="encabezado-vista">
        <a class="volver" href="#/nuevo/g/${encodeURIComponent(pagina.grupo)}">← ${pagina.grupo}</a>
        <h1>${pagina.nombre}</h1>
        <p class="meta">${visto ? `Tu última visita: ${fechaLarga(visto, true)}` : "Primera visita"} · ${nuevas} nuevas · ${actualizadas} actualizadas · ${pagina.historias.length} historias</p>
      </header>
      ${pagina.lectura ? html`<section class="tarjeta tarjeta-resumen">
        <p class="sobretitulo">Lo que está pasando</p>
        <div class="cuerpo">${seguro(markdownAHtml(pagina.lectura))}</div>
        ${pagina.lectura_claude ? html`<p class="lectura-claude"><em>Lectura de Claude: ${pagina.lectura_claude}</em></p>` : ""}
      </section>` : ""}
      ${europa ? html`<div class="filtros" role="group" aria-label="País">${["", ...PAISES_EUROPA, "Otros"].map((p) => html`
        <button class="chip" type="button" data-pais="${p}" aria-pressed="${String(estadoPaginaV2.pais === p)}">${p || "Toda Europa"}</button>`)}</div>` : ""}
      <h2>Historias</h2>
      ${historias.length ? historias.map((h) => tarjetaHistoria(h, visto)) : html`<p class="nota">Nada por ahora.</p>`}
      ${pagina.cerradas.length ? html`<details class="profundizar"><summary>Historias cerradas (${pagina.cerradas.length})</summary>
        <ul class="lista-compacta">${pagina.cerradas.map((h) => html`<li><a href="${enlaceHistoria(h.id)}">
          <span class="articulo-titulo">${h.titulo}</span><span class="meta">Última novedad: ${fechaCorta(h.actualizada)}</span></a></li>`)}</ul>
      </details>` : ""}
      ${pagina.saltadas.length ? html`<details class="profundizar"><summary>Piezas que se saltaron (${pagina.saltadas.length})</summary>
        <ul class="lista-compacta">${pagina.saltadas.map((p) => html`<li><a href="${enlaceLector(p)}">
          <span class="articulo-titulo">${p.titulo}</span><span class="meta">${p.fuente} · ${fechaCorta(p.fecha)}</span></a></li>`)}</ul>
      </details>` : ""}
    `);
  };
  contenido.onclick = (evento) => {
    const boton = evento.target.closest("[data-pais]");
    if (!boton) return;
    estadoPaginaV2.pais = boton.dataset.pais;
    dibujar();
  };
  dibujar();
  marcar({ tipo: "visita", pagina: pid });
}

async function vistaHistoriaV2(id) {
  const indice = await leerJSON("datos/v2/indice.json");
  const pid = indice.historias[id];
  if (!pid) throw new Error("No se encontró esa historia.");
  const [pagina, { visitas, leidas }] = await Promise.all([leerJSON(`datos/v2/paginas/${pid}.json`), marcasV2()]);
  const h = pagina.historias.find((x) => x.id === id)
    || (await leerJSON("datos/v2/historias.json")).historias[id];
  const visto = masReciente(leidas.get(id), visitas.get(pid));
  const nuevas = visto ? h.actualizaciones.filter((a) => despues(a.momento, visto)) : [];
  const piezas = [...h.piezas].sort((a, b) => ORDEN_RECOMENDACION[a.recomendacion] - ORDEN_RECOMENDACION[b.recomendacion]
    || b.relevancia - a.relevancia);
  pintar(html`
    <article class="historia-completa">
      <a class="volver" href="${enlacePagina(pid)}">← ${pagina.nombre}</a>
      <header>
        <h1>${h.titulo}</h1>
        <p class="meta">${h.estado === "activa" ? "Activa" : "Cerrada"} desde el ${fechaCorta(h.creada)} · ${fuentesTexto(h.fuentes.length)} · ${h.piezas.length} piezas · última novedad: ${fechaLarga(h.actualizada, true)}</p>
      </header>
      ${nuevas.length ? html`<section class="nuevo-desde destacado">
        <p class="grupo">Nuevo desde que la leíste (${fechaLarga(visto, true)})</p>
        <ul>${nuevas.flatMap((a) => a.textos.map((t) => html`<li>${t}</li>`))}</ul>
      </section>` : ""}
      <section>
        <h2>La historia completa</h2>
        <div class="cuerpo">${seguro(markdownAHtml(h.sintesis))}</div>
        ${h.lectura_claude ? html`<p class="lectura-claude"><em>Lectura de Claude: ${h.lectura_claude}</em></p>` : ""}
      </section>
      ${h.que_sigue.length ? html`<section><h2>Qué sigue</h2>
        <ul class="que-sigue">${h.que_sigue.map((q) => html`<li><strong>${q.cuando}:</strong> ${q.que}</li>`)}</ul></section>` : ""}
      ${h.linea.length ? html`<section><h2>Línea de tiempo</h2>
        <ol class="linea-tiempo">${h.linea.map((e) => html`<li><span class="meta">${fechaCorta(e.fecha)}</span> ${e.texto}</li>`)}</ol></section>` : ""}
      ${h.entidades.length ? html`<section><h2>Personas, lugares y organizaciones</h2>
        <div class="filtros">${h.entidades.map((e) => html`<a class="chip" href="${enlaceEntidad(e.id)}">${e.nombre}</a>`)}</div></section>` : ""}
      ${h.conexiones.length ? html`<section><h2>Conectada con</h2>
        <ul class="lista-compacta">${h.conexiones.map((c) => html`<li><a href="${enlaceHistoria(c.id)}">
          <span class="articulo-titulo">${c.titulo}</span><span class="meta">Comparten: ${c.por.join(", ")}</span></a></li>`)}</ul></section>` : ""}
      <section><h2>Las piezas (${piezas.length})</h2>
        <ul class="lista-compacta">${piezas.map((p) => html`<li><a href="${enlaceLector(p)}">
          <span class="insignia insignia-${p.recomendacion}">${RECOMENDACIONES[p.recomendacion]}</span>
          <span class="articulo-titulo">${p.titulo}</span>
          <span class="meta">${p.fuente} · ${fechaCorta(p.fecha)}${p.minutos ? ` · ${p.minutos} min` : ""}</span></a></li>`)}</ul>
      </section>
    </article>
  `);
  marcar({ tipo: "historia_leida", historia: id });
}

async function vistaEntidadV2(id) {
  const [{ entidades }, indice] = await Promise.all([leerJSON("datos/v2/entidades.json"), leerJSON("datos/v2/indice.json")]);
  const e = entidades[id];
  if (!e) throw new Error("No se encontró ese nombre en las historias activas.");
  const nombres = Object.fromEntries(indice.paginas.map((p) => [p.pagina, p.nombre]));
  const porPagina = agrupar(e.historias, (h) => h.pagina);
  pintar(html`
    <header class="encabezado-vista">
      <p class="sobretitulo">${e.tipo} · en ${e.historias.length === 1 ? "1 historia" : `${e.historias.length} historias`} de ${porPagina.size === 1 ? "1 página" : `${porPagina.size} páginas`}</p>
      <h1>${e.nombre}</h1>
    </header>
    ${[...porPagina].map(([pid, lista]) => html`<section>
      <h2><a class="enlace-sobrio" href="${enlacePagina(pid)}">${nombres[pid] || pid}</a></h2>
      ${lista.map((h) => html`<article class="tarjeta historia">
        <h3><a class="enlace-sobrio" href="${enlaceHistoria(h.id)}">${h.titulo}</a></h3>
        <p>${h.frase}</p>
        <p class="meta">${fuentesTexto(h.fuentes)} · ${fechaCorta(h.actualizada)}</p>
      </article>`)}
    </section>`)}
    ${e.vecinos.length ? html`<section><h2>Aparece junto a</h2>
      <div class="filtros">${e.vecinos.map((n) => entidades[slugV2(n)]
        ? html`<a class="chip" href="${enlaceEntidad(slugV2(n))}">${n}</a>` : html`<span class="chip">${n}</span>`)}</div></section>` : ""}
  `);
}

async function vistaNuevo(ruta) {
  const [tipo, ...resto] = (ruta || "").split("/");
  const valor = resto.join("/");
  if (tipo === "g") return vistaGrupoV2(valor);
  if (tipo === "p") return vistaPaginaV2(valor);
  if (tipo === "h") return vistaHistoriaV2(valor);
  if (tipo === "e") return vistaEntidadV2(valor);
  return vistaInicioV2();
}

const VISTAS = {
  hoy: vistaHoy,
  nuevo: vistaNuevo,
  leer: vistaLector,
  fuentes: vistaFuentes,
  clasificacion: () => vistaFuentes("articulos"),
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
  contenido.onchange = null;
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
