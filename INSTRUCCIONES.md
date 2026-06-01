# 🗓️ Sistema de Reservas — Lic. Julián Gaffet
## Guía de instalación paso a paso

---

## PASO 1 — Crear proyecto en Google Cloud (10 min, gratis)

1. Andá a https://console.cloud.google.com
2. Hacé clic en **"Nuevo proyecto"** → ponele un nombre (ej: "reservas-gaffet") → **Crear**
3. En el menú de la izquierda buscá **"APIs y servicios"** → **"Biblioteca"**
4. Buscá **"Google Calendar API"** → hacé clic → **Habilitar**
5. Andá a **"APIs y servicios"** → **"Credenciales"**
6. Hacé clic en **"+ Crear credenciales"** → **"ID de cliente OAuth"**
7. Si te pide configurar la pantalla de consentimiento:
   - Tipo de usuario: **Externo**
   - Nombre de la app: "Reservas Gaffet"
   - Completá email y guardá
   - En "Alcances" no agregues nada, solo guardá
   - En "Usuarios de prueba" agregá tu email de Gmail
8. De vuelta en Credenciales → "Crear credenciales" → "ID de cliente OAuth":
   - Tipo: **Aplicación web**
   - Nombre: "Reservas Gaffet"
   - En **"URIs de redireccionamiento autorizados"** agregá:
     - `http://localhost:3000/auth/callback`
     - `https://TU-APP.railway.app/auth/callback` (lo completás después)
9. Hacé clic en **Crear** → te aparece el **Client ID** y **Client Secret** → **guardalos**

---

## PASO 2 — Deployar en Railway (5 min, gratis)

1. Andá a https://railway.app y creá una cuenta (podés entrar con GitHub)
2. Hacé clic en **"New Project"** → **"Deploy from GitHub repo"**
   - Si no tenés GitHub, elegí **"Empty project"** → **"Add service"** → **"GitHub repo"**
   - Subí los archivos a un repo de GitHub primero (podés usar github.com, es gratis)
3. Una vez deployado, Railway te da una URL tipo: `https://reservas-gaffet.up.railway.app`

---

## PASO 3 — Configurar variables de entorno en Railway

En tu proyecto de Railway, andá a **"Variables"** y agregá estas 3:

```
GOOGLE_CLIENT_ID     = (el Client ID del paso 1)
GOOGLE_CLIENT_SECRET = (el Client Secret del paso 1)
REDIRECT_URI         = https://TU-APP.railway.app/auth/callback
```

---

## PASO 4 — Obtener el Refresh Token (una sola vez)

1. Abrí en el navegador: `https://TU-APP.railway.app/auth`
2. Te va a pedir que inicies sesión con tu cuenta de Google
3. Autorizá el acceso al calendario
4. En la consola de Railway vas a ver un mensaje así:
   ```
   ✅ REFRESH TOKEN OBTENIDO:
   1//0gXXXXXXXXXXXXXXXXX...
   ```
5. Copiá ese token y en Railway agregá la variable:
   ```
   GOOGLE_REFRESH_TOKEN = (el token que copiaste)
   ```

---

## PASO 5 — ¡Listo! Compartí el link

Tu página va a estar en: `https://TU-APP.railway.app`

Podés compartir ese link por WhatsApp, Instagram, o pegarlo en tu bio.

---

## ¿Qué hace exactamente el sistema?

Cuando un paciente reserva:
1. ✅ El turno aparece en **tu Google Calendar** con los datos del paciente
2. 📧 El paciente recibe una **invitación por email** al evento
3. ⏰ Si acepta, le aparece en su **Google Calendar con recordatorio 30 min antes**
4. 📍 La dirección (Cmte. Piedrabuena 820) queda en el evento con link a Google Maps

---

## Archivos del proyecto

```
reservas-gaffet/
├── server.js          ← Backend (Node.js + Google Calendar API)
├── package.json       ← Dependencias
└── public/
    └── index.html     ← Página web de reservas
```

---

## ¿Problemas?

- **Error de autenticación**: revisá que el REDIRECT_URI en Google Cloud y en Railway sean idénticos
- **"Acceso bloqueado"**: en Google Cloud, en la pantalla de consentimiento, agregá tu email como "usuario de prueba"
- **El servidor no arranca**: revisá que las 4 variables de entorno estén cargadas en Railway

---

*Generado con Claude — claude.ai*
