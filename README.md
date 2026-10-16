# Ultimate Creations — Pixel Chat

Proyecto inicial de la web con estética pixel-art, inicio de sesión de Discord, chat privado por pedido y formulario desbloqueado con una clave individual.

## Qué incluye
- Inicio de sesión con Discord (OAuth2 `identify`).
- El administrador se reconoce por `ADMIN_DISCORD_ID`.
- Los clientes pueden iniciar chats privados.
- El administrador puede responder desde el panel y generar una clave de un solo uso para un formulario.
- El cliente completa el formulario y sus respuestas quedan visibles para el administrador.
- Las claves se guardan como hash, caducan a las 72 horas y se pueden usar una sola vez.
- SQLite guarda chats, mensajes, claves y formularios.

## Configuración local
1. Instalar Node.js 18 o superior.
2. Crear una aplicación en el portal de desarrolladores de Discord.
3. En OAuth2, agregar como Redirect URI la dirección indicada en `DISCORD_REDIRECT_URI`.
4. Copiar `.env.example` como `.env` y completar `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`, `BASE_URL` y un `SESSION_SECRET` largo y aleatorio. No compartas el `.env` ni el secreto.
5. Instalar y arrancar:
   ```bash
   npm install
   npm start
   ```
6. Abrir `http://localhost:3000`.

## Importante
- Esta carpeta contiene el código preparado, no una web publicada en Internet.
- Para usarlo en producción, necesitás alojarlo en un servicio que permita Node.js y almacenamiento persistente. Configurá las variables de entorno en el panel del alojamiento, no en el navegador ni en un chat.
- La sesión incluida usa el almacenamiento de sesión por defecto de Express, apropiado solo para pruebas. Antes de producción, reemplazalo por un almacén persistente de sesiones y activá HTTPS y cookies seguras.
- El inicio de sesión de Discord requiere que configures tu propia aplicación OAuth. No pide ni necesita tu contraseña de Discord.
- Los mensajes y formularios son privados a nivel de aplicación; el administrador puede ver los chats y cada cliente solo puede ver los suyos.
