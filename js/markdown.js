// Conversión de markdown a HTML para el lector. Escapa todo el texto antes de
// darle formato y solo crea enlaces http, https o mailto: un artículo no puede
// meter código en la página, que guarda el token de Pedro.

export function escapar(texto) {
  return String(texto).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// La ficha del artículo: una línea "clave: valor" por campo, con el valor en JSON.
export function separarFicha(texto) {
  texto = texto.replace(/\r\n/g, "\n");
  const ficha = {};
  if (texto.startsWith("---\n")) {
    const fin = texto.indexOf("\n---\n", 4);
    if (fin !== -1) {
      for (const linea of texto.slice(4, fin).split("\n")) {
        const i = linea.indexOf(": ");
        if (i <= 0) continue;
        const valor = linea.slice(i + 2);
        try { ficha[linea.slice(0, i)] = JSON.parse(valor); } catch { ficha[linea.slice(0, i)] = valor; }
      }
      return { ficha, cuerpo: texto.slice(fin + 5) };
    }
  }
  return { ficha, cuerpo: texto };
}

const ENLACE = /\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+&quot;.*?&quot;)?\)/g;
const ES_URL_SEGURA = /^(https?:|mailto:)/i;

function enfasis(texto) {
  return texto
    .replace(/\*\*(?=\S)(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(?=\S)(.+?)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*(?=\S)([^*]+?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?=\S)([^_]+?)_(?!\w)/g, "$1<em>$2</em>");
}

// Formato dentro de una línea: escapes, código, enlaces, negrita y cursiva.
function enLinea(crudo) {
  const piezas = [];
  const guardar = (html) => `\u0000${piezas.push(html) - 1}\u0000`;
  let texto = crudo
    .replace(/\\([!-/:-@[-`{-~])/g, (_, c) => guardar(escapar(c)))
    .replace(/`([^`]+)`/g, (_, c) => guardar(`<code>${escapar(c)}</code>`));
  texto = escapar(texto).replace(ENLACE, (_, etiqueta, url) =>
    ES_URL_SEGURA.test(url)
      ? guardar(`<a href="${url}" target="_blank" rel="noopener noreferrer">${enfasis(etiqueta)}</a>`)
      : etiqueta);
  return enfasis(texto).replace(/\u0000(\d+)\u0000/g, (_, i) => piezas[Number(i)]);
}

const TITULO = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LINEA_HORIZONTAL = /^\s*([-*_])(\s*\1){2,}\s*$/;
const CITA = /^\s*>/;
const ITEM = /^\s*([-*+]|\d+[.)])\s+/;
const CODIGO = /^\s*```/;
const FILA = /^\s*\|/;

function iniciaBloque(linea) {
  return [TITULO, LINEA_HORIZONTAL, CITA, ITEM, CODIGO, FILA].some((re) => re.test(linea));
}

function celdas(fila) {
  return fila.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

export function markdownAHtml(md) {
  const lineas = md.replace(/\r\n/g, "\n").split("\n");
  const salida = [];
  let i = 0;
  while (i < lineas.length) {
    const linea = lineas[i];
    let m;
    if (!linea.trim()) {
      i++;
    } else if (CODIGO.test(linea)) {
      const codigo = [];
      i++;
      while (i < lineas.length && !CODIGO.test(lineas[i])) codigo.push(lineas[i++]);
      i++;
      salida.push(`<pre><code>${escapar(codigo.join("\n"))}</code></pre>`);
    } else if ((m = linea.match(TITULO))) {
      // Se baja un nivel: el título del artículo es el único h1 de la página.
      const nivel = Math.min(6, m[1].length + 1);
      salida.push(`<h${nivel}>${enLinea(m[2])}</h${nivel}>`);
      i++;
    } else if (LINEA_HORIZONTAL.test(linea)) {
      salida.push("<hr>");
      i++;
    } else if (CITA.test(linea)) {
      const cita = [];
      while (i < lineas.length && CITA.test(lineas[i])) cita.push(lineas[i++].replace(/^\s*>\s?/, ""));
      salida.push(`<blockquote>${markdownAHtml(cita.join("\n"))}</blockquote>`);
    } else if (FILA.test(linea) && i + 1 < lineas.length && /^\s*\|?\s*:?-{2,}/.test(lineas[i + 1])) {
      const filas = [];
      while (i < lineas.length && FILA.test(lineas[i])) filas.push(lineas[i++]);
      const [cabecera, , ...cuerpo] = filas;
      const th = celdas(cabecera).map((c) => `<th>${enLinea(c)}</th>`).join("");
      const tr = cuerpo.map((f) => `<tr>${celdas(f).map((c) => `<td>${enLinea(c)}</td>`).join("")}</tr>`).join("");
      salida.push(`<div class="tabla"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`);
    } else if (ITEM.test(linea)) {
      const ordenada = /^\s*\d/.test(linea);
      const items = [];
      while (i < lineas.length && ITEM.test(lineas[i])) {
        let item = lineas[i++].replace(ITEM, "");
        while (i < lineas.length && /^\s{2,}\S/.test(lineas[i]) && !ITEM.test(lineas[i])) item += " " + lineas[i++].trim();
        items.push(`<li>${enLinea(item)}</li>`);
      }
      const etiqueta = ordenada ? "ol" : "ul";
      salida.push(`<${etiqueta}>${items.join("")}</${etiqueta}>`);
    } else {
      const parrafo = [lineas[i++].trim()];
      while (i < lineas.length && lineas[i].trim() && !iniciaBloque(lineas[i])) parrafo.push(lineas[i++].trim());
      salida.push(`<p>${enLinea(parrafo.join(" "))}</p>`);
    }
  }
  return salida.join("\n");
}
