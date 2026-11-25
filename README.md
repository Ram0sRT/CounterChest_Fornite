# 🏴‍☠️ Contador de Cofres — Fortnite (Treasure Hunters)

Cuenta automáticamente cuántos cofres abres o rompes por partida en Fortnite (incluyendo cofres que caen al tumbar edificios o ciudades) para llevar tu progreso hacia el **Token de Acceso a la Tienda Pirata**.

> ### 👉 [**ABRIR LA PÁGINA AQUÍ**](https://ram0srt.github.io/CounterChest_Fornite/)
> *Funciona 100% en tu navegador (Chrome o Edge en PC). **No tienes que descargar ni instalar nada**, y tus archivos nunca salen de tu computadora.*

---

## 🎮 Cómo usarla en 4 pasos (para amigos)

1. **Activa las repeticiones en Fortnite (solo la primera vez):**
   Dentro del juego ve a **Ajustes → Juego → Repeticiones** y activa **Grabar repeticiones**.
2. **Abre el enlace de arriba** en **Google Chrome** o **Microsoft Edge**.
3. **Conecta tu carpeta de repeticiones:**
   * Haz clic en **Copiar ruta** (copia `%LOCALAPPDATA%\FortniteGame\Saved\Demos`).
   * Haz clic en **Conectar carpeta Demos**.
   * En la ventana que se abre, haz clic en la barra de arriba, pega la ruta (`Ctrl + V`), pulsa `Enter` y acepta el permiso de **solo lectura**.
4. **¡Juega tranquilo!**
   Deja la pestaña abierta en segundo plano. Cada vez que termines una partida y vuelvas al lobby, la página leerá el archivo `.replay` nuevo y sumará tus cofres automáticamente.

*(La próxima vez que entres a la página, solo tendrás que pulsar **Reconectar carpeta guardada**.)*

---

## ✨ Qué cuenta la página

* **Abiertos y rotos:** Cuenta tanto los cofres que abres manualmente como los que rompes con el pico, desentierras o caen al destruir edificios.
* **Solo míos / Con equipo:** Puedes cambiar arriba con un clic si quieres ver únicamente tus cofres o también los de tu escuadrón.
* **Total guardado:** Tu conteo queda guardado en tu navegador aunque Fortnite borre repeticiones antiguas (puedes usar **Ajustar base** si ya llevabas cofres contados antes, y **Exportar / Importar** para guardar un respaldo).

---

## 📱 ¿Juegas en Xbox o consola?

En consola no se pueden leer archivos `.replay` automáticamente, pero puedes abrir el mismo enlace desde el celular o la PC y usar el apartado desplegable **Contador manual (Xbox / conteo rápido)** al final de la página.

<details>
<summary>Opciones avanzadas (solo si quieres correrlo como servidor local en tu PC)</summary>

Si prefieres que un servidor local vigile la carpeta `Demos` sin tener que reconectar permisos en el navegador, ejecuta `start_counter.bat` (requiere Python y .NET 10).

</details>
