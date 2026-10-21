// Acceso a los datos. En GitHub Pages se leen del repositorio privado con el
// token de Pedro, guardado solo en su navegador. En el computador de
// desarrollo (localhost) se leen de la carpeta del proyecto.

const CLAVE_TOKEN = "mentor.token";
const CLAVE_REPO = "mentor.repo";
export const REPO_POR_DEFECTO = "pedros870/mentor";

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

export function guardarConfig(token, repo) {
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
  cache.clear();
}

const cache = new Map();

function pedir(ruta) {
  if (modoLocal()) return fetch(`../${ruta}`, { cache: "no-store" });
  const { token, repo } = config();
  return fetch(`https://api.github.com/repos/${repo}/contents/${encodeURI(ruta)}`, {
    // Solo encabezados que GitHub autoriza desde el navegador (CORS).
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.raw+json",
    },
    cache: "no-store",
  });
}

export function leerTexto(ruta) {
  if (!cache.has(ruta)) {
    const promesa = pedir(ruta).then(async (r) => {
      if (!r.ok) throw new ErrorDeDatos(r.status, ruta);
      return r.text();
    });
    promesa.catch(() => cache.delete(ruta));
    cache.set(ruta, promesa);
  }
  return cache.get(ruta);
}

export async function leerJSON(ruta) {
  return JSON.parse(await leerTexto(ruta));
}
