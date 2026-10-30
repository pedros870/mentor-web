// Escuchar: Mentor lee en voz alta con la voz del navegador, sin Claude ni nada que pagar.
// Una cola de cosas (las historias de Hoy, los párrafos de una lectura) que se leen por partes
// cortas, porque algunos navegadores cortan las frases largas. Un reproductor abajo permite
// pausar, saltar y cambiar la velocidad, y la cola sigue aunque se cambie de vista.

const CLAVE_VELOCIDAD = "mentor.voz.velocidad";
const VELOCIDADES = [1, 1.15, 1.3, 1.5, 0.9];
const MAXIMO_DE_PARTE = 200; // caracteres por vez
// Las regiones de las voces en español, de la preferida a la menos: primero Colombia y Latinoamérica.
const REGIONES = ["es-co", "es-us", "es-mx", "es-419", "es-ar", "es-cl", "es-pe", "es-ve", "es-ec"];

const estado = { cola: [], i: 0, j: 0, sonando: false, actual: null, titulo: "", alEmpezar: null, alTerminar: null, alFallar: null };
let velocidad = 1;
try { velocidad = Number(localStorage.getItem(CLAVE_VELOCIDAD)) || 1; } catch { /* sin almacenamiento */ }

export const puedeHablar = () => "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
if (puedeHablar()) speechSynthesis.getVoices(); // en algunos navegadores, pedirlas una vez hace que carguen

// La mejor voz en español: de Colombia o de Latinoamérica si hay, y mejor si es "natural".
function voz() {
  const puntaje = (v) => {
    const lengua = v.lang.toLowerCase().replace("_", "-");
    const region = REGIONES.indexOf(lengua);
    return (region >= 0 ? 20 - region : lengua === "es-es" ? 5 : 8) + (/natural|online|neural|google/i.test(v.name) ? 10 : 0);
  };
  return speechSynthesis.getVoices().filter((v) => /^es\b/i.test(v.lang)).sort((a, b) => puntaje(b) - puntaje(a))[0] || null;
}

// Dónde cortar una oración larga: en la última coma antes del máximo y, si no hay una que
// sirva, en el último espacio.
function corte(texto, maximo) {
  const coma = texto.lastIndexOf(", ", maximo);
  if (coma > maximo / 3) return coma + 1;
  const espacio = texto.lastIndexOf(" ", maximo);
  return espacio > maximo / 3 ? espacio : maximo;
}

// Un texto en partes de una o varias oraciones, sin pasar del máximo. (Sin "mirar hacia atrás"
// en la expresión regular: los iPhone con Safari anterior a 16.4 no la entienden.)
export function partir(texto, maximo = MAXIMO_DE_PARTE) {
  const oraciones = (texto || "").replace(/\s+/g, " ").trim()
    .replace(/([.!?…:;])\s+(?=[«"“¿¡(\p{Lu}\d])/gu, "$1\n").split("\n").filter(Boolean);
  const partes = [];
  for (let resto of oraciones) {
    const trozos = [];
    while (resto.length > maximo) {
      const en = corte(resto, maximo);
      trozos.push(resto.slice(0, en).trim());
      resto = resto.slice(en).trim();
    }
    if (resto) trozos.push(resto);
    for (const trozo of trozos) {
      if (partes.length && partes.at(-1).length + trozo.length + 1 <= maximo) partes[partes.length - 1] += ` ${trozo}`;
      else partes.push(trozo);
    }
  }
  return partes;
}

// ---------- El reproductor ----------

const reproductor = document.createElement("div");
reproductor.className = "reproductor";
reproductor.hidden = true;
reproductor.setAttribute("role", "region");
reproductor.setAttribute("aria-label", "Lectura en voz alta");
reproductor.innerHTML = `
  <button type="button" data-voz="anterior" aria-label="Anterior" title="Anterior"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5v14M18 6l-9 6 9 6z"/></svg></button>
  <button type="button" data-voz="pausa" class="principal" aria-label="Pausar" title="Pausar"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="icono-pausa" d="M8 5v14M16 5v14"/><path class="icono-sigue" d="M7 5l12 7-12 7z"/></svg></button>
  <button type="button" data-voz="siguiente" aria-label="Siguiente" title="Siguiente"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 5v14M6 6l9 6-9 6z"/></svg></button>
  <p class="reproductor-texto"><span class="reproductor-cuenta"></span><span class="reproductor-titulo"></span></p>
  <button type="button" data-voz="velocidad" class="reproductor-velocidad" title="Velocidad"></button>
  <button type="button" data-voz="cerrar" aria-label="Dejar de escuchar" title="Dejar de escuchar"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
document.body.append(reproductor);

function pintarReproductor() {
  const item = estado.cola[estado.i];
  reproductor.hidden = !item;
  document.body.classList.toggle("con-reproductor", Boolean(item));
  if (!item) return;
  reproductor.classList.toggle("en-pausa", !estado.sonando);
  const pausa = reproductor.querySelector('[data-voz="pausa"]');
  pausa.setAttribute("aria-label", estado.sonando ? "Pausar" : "Seguir");
  pausa.title = pausa.getAttribute("aria-label");
  reproductor.querySelector(".reproductor-cuenta").textContent = `${estado.titulo} · ${estado.i + 1} de ${estado.cola.length}`;
  reproductor.querySelector(".reproductor-titulo").textContent = item.titulo;
  reproductor.querySelector(".reproductor-velocidad").textContent = `${String(velocidad).replace(".", ",")}×`;
}

// ---------- La lectura ----------

function callar() {
  estado.actual = null; // lo que llegue de la frase que se corta ya no cuenta
  speechSynthesis.cancel();
}

function decir() {
  if (!estado.sonando) return;
  const item = estado.cola[estado.i];
  if (!item) {
    terminar();
    return;
  }
  const texto = item.partes[estado.j];
  if (texto === undefined) {
    estado.alTerminar?.(item);
    estado.i++;
    estado.j = 0;
    decir();
    return;
  }
  if (estado.j === 0) estado.alEmpezar?.(item, estado.i);
  const frase = new SpeechSynthesisUtterance(texto);
  const elegida = voz();
  if (elegida) frase.voice = elegida;
  frase.lang = elegida?.lang || "es-CO";
  frase.rate = velocidad;
  const seguir = () => {
    if (frase !== estado.actual) return;
    estado.j++;
    decir();
  };
  frase.onend = seguir;
  // Si el navegador no puede hablar, se para y avisa: la cola no sigue sola ni cuenta nada como escuchado.
  frase.onerror = (evento) => {
    if (frase !== estado.actual || ["interrupted", "canceled"].includes(evento.error)) return;
    if (evento.error === "text-too-long") {
      seguir();
      return;
    }
    const alFallar = estado.alFallar;
    terminar();
    alFallar?.(evento.error);
  };
  estado.actual = frase;
  pintarReproductor();
  speechSynthesis.speak(frase);
}

// Algunos navegadores no hablan si se les pide justo después de callar.
const decirEnSeguida = () => setTimeout(decir, 60);

function terminar() {
  callar();
  estado.alEmpezar?.(null);
  Object.assign(estado, { cola: [], sonando: false, alEmpezar: null, alTerminar: null, alFallar: null });
  pintarReproductor();
}

// Lee una cola: [{ clave, titulo, partes: [texto…] }]. alEmpezar(item) avisa qué se empieza a
// leer (null al terminar), alTerminar(item) cuándo se leyó completo y alFallar(error) si el
// navegador no pudo hablar.
export function escuchar(cola, { titulo = "Escuchando", desde = 0, alEmpezar = null, alTerminar = null, alFallar = null } = {}) {
  if (!puedeHablar() || !cola.length) return false;
  callar();
  estado.alEmpezar?.(null);
  Object.assign(estado, { cola, i: Math.min(desde, cola.length - 1), j: 0, sonando: true, titulo, alEmpezar, alTerminar, alFallar });
  decirEnSeguida();
  return true;
}

export function detener() {
  if (estado.cola.length) terminar();
}

function mover(paso) {
  if (paso > 0 && estado.i >= estado.cola.length - 1) {
    terminar();
    return;
  }
  // "Anterior" primero vuelve al comienzo de lo que está sonando.
  if (paso > 0 || estado.j === 0) estado.i = Math.max(0, estado.i + paso);
  estado.j = 0;
  estado.sonando = true;
  callar();
  decirEnSeguida();
}

export function pausarOSeguir() {
  if (!estado.cola.length) return false;
  estado.sonando = !estado.sonando;
  if (estado.sonando) decirEnSeguida(); // sigue desde el comienzo de la parte que se cortó
  else callar();
  pintarReproductor();
  return true;
}

reproductor.addEventListener("click", (evento) => {
  const accion = evento.target.closest("[data-voz]")?.dataset.voz;
  if (accion === "pausa") pausarOSeguir();
  else if (accion === "anterior") mover(-1);
  else if (accion === "siguiente") mover(1);
  else if (accion === "cerrar") terminar();
  else if (accion === "velocidad") {
    velocidad = VELOCIDADES[(VELOCIDADES.indexOf(velocidad) + 1) % VELOCIDADES.length];
    try { localStorage.setItem(CLAVE_VELOCIDAD, String(velocidad)); } catch { /* sin almacenamiento */ }
    if (estado.sonando) {
      callar();
      decirEnSeguida();
    }
    pintarReproductor();
  }
});

// Si la página se cierra, que no siga hablando sola.
window.addEventListener("pagehide", () => window.speechSynthesis?.cancel());
