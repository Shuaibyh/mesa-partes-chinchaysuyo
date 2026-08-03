# Mesa de Partes Virtual - I. E. Chinchaysuyo

Sistema web para registrar, consultar, derivar y atender documentos de la I. E. Chinchaysuyo.

## Sistema publicado

La aplicación está disponible en:

<https://mesa-partes-chinchaysuyo.brandonsl2024.workers.dev>

La versión en Internet utiliza:

- Cloudflare Workers para la API y la interfaz.
- D1 para usuarios, áreas, expedientes, derivaciones, comentarios y sesiones.
- Workers KV para los documentos adjuntos privados.

## Funciones principales

- Todos los FUT llegan inicialmente a Mesa de Partes.
- Mesa de Partes revisa y deriva cada expediente.
- Cada área accede únicamente a los expedientes que le corresponden.
- Los administradores generales supervisan el sistema sin alterar el flujo operativo.
- Las derivaciones, recepciones, comentarios y cambios de estado mantienen trazabilidad.
- El solicitante consulta su expediente usando el código y su documento.
- Los adjuntos solamente se descargan desde cuentas autorizadas.

## Estructura

```text
public/       Interfaz, estilos, imágenes y cabeceras de seguridad
src/          Worker, autenticación y consultas para Cloudflare
migrations/   Esquema y futuras migraciones de D1
tools/        Exportación, mantenimiento y pruebas de migración
test/         Pruebas automatizadas
local-server/ Servidor alternativo con Express, SQLite y autenticación local
wrangler.jsonc Configuración del despliegue en Cloudflare
```

## Desarrollo local con Cloudflare

Requisitos: Node.js 22.5 o superior y las dependencias instaladas con `npm.cmd install`.

```powershell
npm.cmd run cloudflare:dev
```

La aplicación queda disponible normalmente en <http://127.0.0.1:8787> y usa almacenamiento local de Wrangler.

## Pruebas

```powershell
npm.cmd test
npm.cmd run cloudflare:check
```

`cloudflare:check` valida el Worker y sus vinculaciones sin publicar cambios.

## Publicar una actualización

Después de probar los cambios:

```powershell
npm.cmd run cloudflare:deploy
```

El despliegue conserva la misma dirección pública y no elimina los datos almacenados en D1 o KV.

No vuelva a ejecutar `migration-data/seed.sql` sobre la base remota. Ese archivo se utilizó solamente para la carga inicial.

## Servidor local alternativo

La versión original con Express y SQLite se conserva como alternativa:

```powershell
npm.cmd start
```

Se abre en <http://localhost:3000>. Sus datos se almacenan en `data/` y sus adjuntos en `uploads/`.

## Archivos privados

Estos elementos están excluidos de Git y nunca deben publicarse:

- `.env`
- `CUENTAS_ACCESO_PRIVADO.txt`
- `data/`
- `uploads/`
- `backups/`
- `migration-data/`
- `.wrangler/`
- archivos de registro

Antes de modificar tablas remotas, cree una migración nueva y un respaldo. No edite manualmente identificadores, hashes de contraseña ni datos internos de sesión.
