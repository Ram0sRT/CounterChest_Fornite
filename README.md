# Contador de Cofres — Fortnite (Treasure Hunters)

Aplicación web para contar cofres abiertos y rotos (incluyendo derrumbes de edificios/ciudades) a partir de archivos `.replay` de Fortnite.

## Cómo compartirla por GitHub Pages (para que tus amigos la usen con un clic)

La carpeta [`docs/`](docs/) ya contiene la página completa lista para publicar, incluyendo el analizador compilado en WebAssembly (`docs/_framework/`). Tus amigos **no necesitan descargar ni compilar nada**, y sus repeticiones nunca salen de su computadora.

1. Crea un repositorio nuevo en GitHub (público o privado según tu plan).
2. Sube el contenido de esta carpeta al repositorio (asegurándote de incluir la carpeta `docs/` completa, incluido `docs/.nojekyll` y `docs/_framework/`).
3. En GitHub, entra a **Settings → Pages**.
4. En **Build and deployment → Source**, elige **Deploy from a branch**, selecciona la rama **`main`** y la carpeta **`/docs`**, y guarda.
5. En ~1 minuto tendrás el enlace listo (`https://<tu-usuario>.github.io/<tu-repo>/`) para enviárselo a tus amigos.

## Cómo la usa tu amigo

1. Abre el enlace en **Chrome** o **Edge** (en PC).
2. Pulsa **Copiar ruta**, luego **Conectar carpeta Demos**, pega la ruta (`Ctrl + V` + `Enter`) y acepta el permiso de solo lectura.
3. Deja la pestaña abierta mientras juega: al volver al lobby después de cada partida, los cofres nuevos se suman solos.

## Modo local automático en segundo plano (opcional)

Si prefieres que un servidor local vigile la carpeta `Demos` en tu PC aunque cambies de pestaña, ejecuta `start_counter.bat`.
