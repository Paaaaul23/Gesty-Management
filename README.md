# Gesty Management

Gestión para pequeños comercios. Entorno local.

- **Panel de administrador** (`/admin`): alta, edición, suspensión y baja de clientes; ver sus locales, empleados y documentos; abrir el panel de cualquier cliente.
- **Panel de cliente** (`/app`): resumen, captura inteligente, documentos **recibidos** (compras) y **emitidos** (ventas) separados por tipo (facturas, rectificativas, albaranes, pedidos, presupuestos y ofertas), contabilidad, precisión del reconocimiento, locales y empleados, configuración.
- **Contabilidad** (*Gastos y beneficios*): ingresos (facturas emitidas), gastos (facturas recibidas y apuntes manuales como nóminas, alquiler o cuotas), beneficio y margen por año, trimestre o mes; gráfico mensual; gastos por categoría; IVA repercutido, soportado y a ingresar por trimestre (orientativo para el 303) e IRPF retenido (111); facturas pendientes de cobro y de pago con vencimientos; principales clientes y proveedores; libro de ingresos y gastos exportable a CSV (Excel). Las rectificativas restan y los importes son sin IVA (`accounting.js`).

- **Fiscalidad** (`fiscal.js`):
  - *Impuestos*: calendario del ejercicio con los plazos oficiales y el **borrador casilla a casilla** de los modelos 303 (IVA), 130 (IRPF autónomos) o 202 (pagos fraccionados de sociedades), 111 y 115 (retenciones), 390, 347, 190 y 180 (anuales) y una estimación del 200 (Sociedades) o de la Renta. Se copian las casillas o se imprime el borrador, y se marca cada modelo como presentado con su justificante.
  - *Dinero a reservar*: lo que habrá que pagar en los próximos plazos (IVA devengado, retenciones practicadas, pagos fraccionados y estimación anual).
  - *Gastos deducibles*: qué parte de cada gasto es deducible y cuánto IVA se recupera, con el motivo (tickets sin tus datos, vehículo al 50 %, comidas, suministros de casa, inversiones, multas…).
  - *Libros registro* de facturas expedidas y recibidas, exportables a CSV.
  - *Perfil fiscal* en Configuración: autónomo o sociedad, régimen de IVA, estimación directa, tipo del IS, trabajadores, alquiler de local…
  - Son **borradores orientativos**: la presentación se hace en la Sede Electrónica de la AEAT con certificado digital, y conviene revisarlos con una asesoría (no contemplan prorrata, regímenes especiales, operaciones intracomunitarias ni compensaciones de periodos anteriores).
- **Ventas y compras** (`sales.js`): crea presupuestos u ofertas, pedidos (de cliente o a proveedor), albaranes, facturas y facturas rectificativas con PDF.
  - Numeración correlativa por serie y año (`F2026-0001`, `P2026-0001`…). Una factura emitida no se puede modificar ni borrar, ni emitir otra con fecha anterior: se corrige con una rectificativa. Cada factura lleva una huella encadenada con la anterior para detectar cambios.
  - Conversión con un clic: presupuesto → pedido → albarán → factura (quedan enlazados), y facturación de varios albaranes en una sola factura.
  - Recargo de equivalencia, retención de IRPF, descuentos por línea y varios tipos de IVA.
  - Agenda de **clientes y proveedores** (con ventas, compras y pendiente de cada uno) y catálogo de **artículos y servicios**.
  - Los documentos creados cuentan automáticamente en la contabilidad, los impuestos y los libros registro.
- **Contabilidad general** (`ledger.js`): asientos por partida doble según el PGC de PYMES generados a partir de facturas, cobros y pagos, apuntes, liquidaciones de IVA, pagos de modelos y amortizaciones (lineal, 12 %). Libro diario, libro mayor, balance de sumas y saldos, cuenta de pérdidas y ganancias y balance de situación, con saldos iniciales, exportación a CSV e impresión.
- **Trazabilidad**: *Historial de actividad* con quién hizo qué y cuándo (subidas, validaciones con los campos corregidos, pagos, apuntes, impuestos, configuración), y **documentos relacionados** en cada documento (oferta → pedido → albarán → factura), que se enlazan solos cuando uno cita el número de otro.

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
3. **Campos**: tipo de documento (factura, rectificativa, albarán, pedido, presupuesto), si es **recibido o emitido** (según dónde aparece tu empresa: como emisor o en el bloque del cliente), el tercero (proveedor o cliente), NIF/CIF, número, fecha, vencimiento, base, tipo y cuota de IVA (también con varios tipos), recargo de equivalencia, retención de IRPF, total, forma de pago, IBAN y líneas de detalle (`extract.js`).
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
npm test                     # pruebas de los cálculos fiscales
```

Los documentos `h01`–`h04` se añadieron después de ajustar el lector, con maquetaciones nuevas: la primera medición dio un 81 % (reglas demasiado a medida) y sirvieron para generalizarlas. Para medir de verdad con documentos no vistos, añade documentos reales nuevos. Para regenerar los documentos: `npm i --no-save playwright && node test/generate.js`.
