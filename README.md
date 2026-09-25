# Gesty Management

Gestión para pequeños comercios. Entorno local.

- **Panel de administrador** (`/admin`): alta, edición, suspensión y baja de clientes; ver sus locales, empleados y documentos; abrir el panel de cualquier cliente.
- **Panel de cliente** (`/app`): resumen, captura inteligente, documentos (facturas, albaranes, pedidos), precisión del reconocimiento, locales y empleados, configuración.

## Arrancar en Windows

1. Instala **Node.js LTS** (22.13 o superior) desde https://nodejs.org, con las opciones por defecto.
2. Haz doble clic en **`Iniciar Gesty.bat`**. Él solo:
   - comprueba que Node.js está instalado y es suficientemente nuevo;
   - instala o actualiza las dependencias si faltan o han cambiado;
   - la primera vez crea la base de datos y **muestra las contraseñas** (apúntalas);
   - arranca Gesty y abre el navegador en http://localhost:3000.
3. Deja la ventana negra abierta mientras lo uses; al cerrarla, Gesty se detiene.

Para descargar la última versión: doble clic en **`Actualizar Gesty.bat`** (necesita Git y que la carpeta se haya descargado con `git clone`). Tus datos, en `data/`, no se tocan.

## Arrancar desde la terminal (cualquier sistema)

Requiere Node.js 22.13 o superior (usa `node:sqlite`, no hace falta instalar ninguna base de datos).

```
npm install
npm run seed     # crea admin, cliente Torca 3D, local Torca 3D y empleado Javier González
npm start        # http://localhost:3000
```

`npm run seed` imprime las contraseñas generadas la primera vez. Para fijarlas tú:
`ADMIN_PASSWORD=... CLIENT_PASSWORD=... npm run seed` (solo si los usuarios aún no existen).

Los datos se guardan en `data/` (base de datos `gesty.db` y archivos subidos en `data/uploads`). Para empezar de cero, borra `data/gesty.db` y `data/uploads` (no `data/tessdata`) y vuelve a ejecutar el seed.

## Reconocimiento de documentos

1. **Lectura de la página con posiciones**: PDF digital → capa de texto (pdfjs). Foto o PDF escaneado → OCR en español (tesseract.js), enderezando la imagen si está torcida. El modelo de español va incluido en `data/tessdata`.
2. **Maquetación**: filas y columnas con coordenadas. Se emparejan etiquetas y valores (en la misma línea, a la derecha o debajo, como en las cabeceras de tabla), se leen las líneas de detalle por columnas y se separa el bloque del cliente del del proveedor.
3. **Campos**: tipo de documento, proveedor, NIF/CIF, número, fecha, vencimiento, base, tipo y cuota de IVA (también con varios tipos), recargo de equivalencia, retención de IRPF, total, forma de pago, IBAN y líneas de detalle (`extract.js`).
4. **Comprobaciones y autocorrección**: dígito de control del NIF/CIF (corrige errores típicos del OCR, p. ej. `8`→`B`) y del IBAN, base + IVA + recargo − retención = total, suma de líneas = base, cantidades y decimales que el OCR lee mal. Si en una foto falta el número, la fecha o el total, se relee esa zona por separado.
5. **Lectura con IA (opcional)**: desde el panel de administrador → *Lectura con IA* se pega una clave de la API de Anthropic y cada documento lo lee también Claude (`ai.js`). El resultado se combina con la lectura local y pasa las mismas comprobaciones; si la IA falla, se usa la local. También se puede activar con la variable `ANTHROPIC_API_KEY`.
6. **Revisión**: el usuario corrige y valida. La página *Precisión del reconocimiento* compara lo extraído con lo validado, por campo y por documento.

## Banco de pruebas

`test/fixtures` contiene 20 documentos de prueba (facturas, albaranes, pedido, ticket, autónomo con IRPF, recargo de equivalencia, varios tipos de IVA…) en tres versiones: PDF digital, foto y PDF escaneado, con sus valores correctos.

```
npm run eval                 # precisión por campo del lector local
npm run eval -- --verbose    # con el detalle de cada fallo
npm run eval -- f03 jpg      # solo un documento o una variante
npm run eval -- --ia         # usando también la IA (necesita la clave; tiene coste)
```

Los documentos `h01`–`h04` se añadieron después de ajustar el lector, con maquetaciones nuevas: la primera medición dio un 81 % (reglas demasiado a medida) y sirvieron para generalizarlas. Para medir de verdad con documentos no vistos, añade documentos reales nuevos. Para regenerar los documentos: `npm i --no-save playwright && node test/generate.js`.
